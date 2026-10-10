## Context

`StateStore` loads `PersistedState` from `configDir()/state.json`:

- `projects`: `ProjectId` → durable runtime (`containerId`, `password`, `workspaceFolder`, `relayToken`, `remoteUser`)
- `environments`: `EnvId` → `projectId`, `worktree: { path, hostPath, branch }`, `image`, `node`, plus the durable runtime

It writes the whole file back whenever a durable key changes or an environment is added or removed. `cli.ts nodes remove` reads it directly. Projects come from `discovery.ts` scanning the configured roots. `ProjectId` is `slug-<sha256(path)[0:6]>`, so it is stable per path.

## Goals / Non-Goals

**Goals:**

- One database holds projects, environments, tasks, branches and worktrees, with foreign keys between them.
- No container is lost on upgrade or rollback.
- Secrets get the same file-level protection as today.

**Non-Goals:**

- Persisting volatile runtime state (container state, ports, opencode health). That stays in memory as today.
- Storing settings from `config.json` (roots, forges, nodes, project settings) in the database. That is configuration, and stays a file users can edit.
- Moving secrets into the OS keyring (see Open Questions).

## Decisions

### Schema (migration 3)

```sql
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,   -- projectId(path)
  path              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  devcontainer_path TEXT NOT NULL,
  first_seen_at     INTEGER NOT NULL,
  missing_since     INTEGER
);

CREATE TABLE environments (
  id               TEXT PRIMARY KEY,    -- EnvId; the main environment's id is the project id
  project_id       TEXT NOT NULL REFERENCES projects (id),
  kind             TEXT NOT NULL CHECK (kind IN ('main', 'task')),
  worktree_id      INTEGER REFERENCES worktrees (id),   -- task environments only
  node_id          TEXT,
  container_id     TEXT,
  workspace_folder TEXT,
  remote_user      TEXT,
  image_key        TEXT,
  image_ref        TEXT,
  password         TEXT,
  relay_token      TEXT,
  created_at       INTEGER NOT NULL,
  removed_at       INTEGER,
  CHECK ((kind = 'main') = (worktree_id IS NULL))
);
```

SQLite can't add foreign keys to existing tables, so migration 3 rebuilds `tasks`, `branches` and `worktrees` (create new, copy, drop, rename) to add `REFERENCES projects (id)`. Before that, it inserts a placeholder project row (`path` = `missing:<id>`, `missing_since` = now) for every project id in use that discovery hasn't produced yet. Discovery replaces the placeholder with the real path the first time it finds that project. Variants' `env_id` gets its foreign key in the same rebuild.

### Discovery upserts, never deletes

`setProjects` upserts every discovered project and clears `missing_since`. Rows not in the list get `missing_since` = now. Missing projects stay out of the snapshot as today, and their tasks remain in the database. If the project's folder comes back at the same path, it gets the same id, so all its history reattaches.

### Task environments point at worktree rows

`EnvRecord.worktree` (`path`, `hostPath`, `branch`) is now loaded by joining `environments.worktree_id` to `worktrees` and `branches`, so the in-memory shape `StateStore` and `Environments` use stays the same. Creating a task environment requires the worktree row from `link-branches-and-worktrees` to exist first, which is already the order in `runTask`.

### Secrets stay where file permissions protect them

The password and relay token move from `state.json` (0600) to `opendevhub.db` (0600), with the same exposure. They are never selected into a view, and `publicRuntime` keeps stripping them. The keyring was considered, but `secrets.ts` keeps integration tokens there and it can fail headless (no Secret Service on SSH-only hosts). Tying container start-up to it would add a failure mode.

### state.json: import once, export for one release

- **Import**: on start, if migration 3 has just run and `state.json` exists, its projects and environments are inserted in one transaction. Each environment's worktree is matched to a live worktree row by path, or a new worktree row is inserted as unmanaged if none exists yet. A `meta` mark `state_json_imported` makes this run only once.
- **Export**: whenever an environment row changes, `state.json` is rewritten in the existing format from the database. Older builds therefore still find their containers after a rollback. The export is removed one minor release later, in a follow-up change.

### Write behaviour

`StateStore.updateRuntime` currently writes the file only when a `DURABLE_KEYS` field changes. It now does an `UPDATE` of the matching columns under the same rule. The volatile fields stay in the `runtimes` map.

## Risks / Trade-offs

- **Rebuilding tables in migration 3 could lose rows on a bug** → the migration runs in a transaction, compares row counts before and after, and aborts on any mismatch. Tests cover a seeded version-2 database.
- **Placeholder projects** (ids in use that discovery hasn't produced yet) could look odd → they're `missing_since` from the start, so they never reach the snapshot. They only keep foreign keys valid.
- **The export drifts from the old format** → it's generated by the existing `saveState` serialiser, and a test checks that it loads with `loadState`.
- **Concurrent opendevhub processes** (an e2e run next to a dev server) → each uses its own `XDG_STATE_HOME`, as e2e already does for `stateDir`.

## Migration Plan

1. Migration 3 creates the tables, adds placeholder projects, and rebuilds the tables that need foreign keys.
2. First start imports `state.json`. Every environment change also writes the export.
3. Rollback: older builds read the exported `state.json`.
4. Next minor release: drop the export and `PersistedState` (separate change).

## Open Questions

- Should the main environment get a worktree row for the main checkout, so that every environment and variant has a checkout row? Still open from `link-branches-and-worktrees`. This design keeps `worktree_id` NULL for `main`.
