## Context

`StateStore` loads `PersistedState` from `configDir()/state.json`:

- `projects`: `ProjectId` → durable runtime (`containerId`, `password`, `workspaceFolder`, `relayToken`, `remoteUser`)
- `environments`: `EnvId` → `projectId`, `worktree: { path, hostPath, branch }`, `image`, `node`, plus the durable runtime

It writes the whole file back whenever a durable key changes or an environment is added or removed. `cli.ts nodes remove` reads it directly. Project rows already exist since `persist-tasks`, and worktree rows since `link-branches-and-worktrees`.

## Goals / Non-Goals

**Goals:**

- One database holds projects, environments, tasks, branches and worktrees, with foreign keys between them.
- `state.json` goes away.
- Secrets get the same file-level protection as today.
- Environment creation and removal are recorded as events.

**Non-Goals:**

- Persisting volatile runtime state (container state, ports, opencode health). That stays in memory as today.
- Storing settings from `config.json` (roots, forges, nodes, project settings) in the database. That is configuration, and stays a file users can edit.
- Moving secrets into the OS keyring (see Open Questions).
- Importing an existing `state.json`. opendevhub has no users yet.

## Decisions

### Schema (added to migration 1)

```sql
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

-- in CREATE TABLE variants:
--   env_id TEXT REFERENCES environments (id),
```

Because migration 1 is edited in place, `variants.env_id` gets its foreign key directly, and no table is rebuilt.

### Task environments point at worktree rows

`EnvRecord.worktree` (`path`, `hostPath`, `branch`) is now loaded by joining `environments.worktree_id` to `worktrees` and `branches`, so the in-memory shape `StateStore` and `Environments` use stays the same. Creating a task environment requires the worktree row from `link-branches-and-worktrees` to exist first, which is already the order in `runTask`.

### Secrets stay where file permissions protect them

The password and relay token move from `state.json` (0600) to `opendevhub.db` (0600), with the same exposure. They are never selected into a view, and `publicRuntime` keeps stripping them. The keyring was considered, but `secrets.ts` keeps integration tokens there and it can fail headless (no Secret Service on SSH-only hosts). Tying container start-up to it would add a failure mode.

### state.json is removed

`PersistedState`, `loadState`, `saveState` and `StoreOptions.persist` are deleted. opendevhub neither reads nor writes `state.json`. A file left over from development is ignored. The containers it lists are not reattached and are cleaned up by hand.

### Write behaviour

`StateStore.updateRuntime` currently writes the file only when a `DURABLE_KEYS` field changes. It now does an `UPDATE` of the matching columns under the same rule. The volatile fields stay in the `runtimes` map.

### Events

The environment repository writes `environment.created` and `environment.removed` in the same transaction as the change, as `persist-tasks` set up. A task environment's events carry the task id of the variant it was created for. A container id change on recreate is not an event: it's runtime detail, and `show-provenance` leaves runtime changes out of the feed.

## Risks / Trade-offs

- **Concurrent opendevhub processes** (an e2e run next to a dev server) → each uses its own `XDG_STATE_HOME`, as e2e already does for `stateDir`.
- **A development machine has containers only `state.json` knows about** → they are not reattached. Removing them by hand is acceptable before release.

## Open Questions

- Should the main environment get a worktree row for the main checkout, so that every environment and variant has a checkout row? Still open from `link-branches-and-worktrees`. This design keeps `worktree_id` NULL for `main`.
- Should container secrets move to the OS keyring later, with the database only as a fallback on headless hosts?
