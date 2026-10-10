## Context

opendevhub keeps its state in four places:

- `config.json`: settings
- `state.json`: container runtimes and task environments
- git config: `branch.<b>.opendevhub*` keys
- opencode session metadata: `TaskMeta`, including the spec chain (`TaskSpec`)

A task is only the shared `task` id in the `TaskMeta` of its sessions. `Tasks.beginTask` puts a `StartingTask` in `StateStore` memory. Once a variant's session shows up, the variant leaves that list, and from then on the dashboard rebuilds the task from session metadata (`taskSessions` in `web/features/tasks/tasks.ts`). `specs.ts` reads and patches the spec chain in the same metadata, and `usage.ts`, `status.ts` and `cleanup.ts` parse it to find a session's task or discard flag. Sessions without `TaskMeta`, whether started from the session list, from "new worktree with session", by `generateIn`, or directly in opencode, belong to no task.

This change is the first step of a larger data model (task → variant → branch/worktree/environment/session → pull request, ticket → task). It introduces the database, projects, tasks, variants and the events table. Later changes in the series add their tables to the same schema.

opendevhub has no users yet. The series therefore replaces the old storage outright and carries no backfill, dual writes or rollback path.

## Goals / Non-Goals

**Goals:**

- Tasks and variants are durable rows. They outlive their sessions, a restart and cleanup.
- The database is the only record of a task. Session metadata no longer carries `TaskMeta`.
- Every top-level session belongs to exactly one task, using an implicit `manual` task when needed.
- Starting progress (step, error) survives a restart.
- The dashboard reads tasks from the server instead of deriving them from session metadata.
- Projects have rows that other tables can reference.
- What happens to tasks, variants and sessions is recorded as events from the start.

**Non-Goals:**

- Branches, worktrees, environments, pull requests, tickets and reviews as tables (later changes).
- Moving `state.json` or the `branch.<b>.opendevhub*` git config keys into the database (later changes).
- Mirroring session content, status, cost or tokens. opencode remains the source of truth for those.
- An activity feed or provenance UI over the events (`show-provenance`).
- Importing anything from existing installs.

## Decisions

### SQLite through `node:sqlite`

`node:sqlite` (`DatabaseSync`) is built in from Node 22.13, which is already the `engines` floor, so it adds no native dependency to build for each platform. Its API is synchronous, which suits a single-process server with small tables. We suppress the one-time `ExperimentalWarning` for `node:sqlite` only. _Alternatives:_ `better-sqlite3` (mature, but a second native addon next to `node-pty` and the keyring, with prebuild issues on new Node versions); JSON files like `state.json` (no foreign keys or queries, and they grow badly once events and links arrive); Drizzle or Kysely (not worth it for a handful of tables; plain SQL and typed row mappers are enough).

### Location and migrations

The database file is `stateDir()/opendevhub.db` (default `~/.local/state/opendevhub/`), created with mode 0600 and opened with `journal_mode=WAL` and `foreign_keys=ON`. It holds generated state, not configuration, which is why it lives in `stateDir` rather than next to `config.json`. Migrations are an ordered array of SQL strings in `src/server/db/migrations.ts`, applied in one transaction each and tracked with `PRAGMA user_version`. If the database is newer than the code, the server refuses to start with a clear error rather than guessing.

### Pre-release schema

Until the first release, there is exactly one migration. Each change in this series edits migration 1 in place to add its tables and columns, so the released schema is created by one migration with every foreign key in place, and no table is ever rebuilt. A developer database from an older iteration is deleted by hand. The runner, `user_version` and the newer-than-code check are still built now, so the first post-release schema change is an ordinary migration 2.

### Schema

```sql
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,   -- projectId(path)
  path              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  devcontainer_path TEXT NOT NULL,
  first_seen_at     INTEGER NOT NULL,
  missing_since     INTEGER
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,            -- newTaskId()
  project_id     TEXT NOT NULL REFERENCES projects (id),
  kind           TEXT NOT NULL CHECK (kind IN ('task', 'manual')),
  title          TEXT NOT NULL,
  prompt         TEXT,                        -- NULL for manual tasks
  jira           TEXT,                        -- JSON JiraTaskSource snapshot
  spec_first     INTEGER NOT NULL DEFAULT 0,  -- started with opsx-propose
  proposed_in    TEXT REFERENCES tasks (id),  -- implementing: the task that proposed the change
  implemented_in TEXT REFERENCES tasks (id),  -- the task implementing this task's change
  created_at     INTEGER NOT NULL,
  archived_at    INTEGER
);
CREATE INDEX tasks_project ON tasks (project_id, archived_at);

CREATE TABLE variants (
  task_id            TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  n                  INTEGER NOT NULL,     -- 1-based
  model              TEXT,                 -- JSON ModelRef
  agent              TEXT,
  node_id            TEXT,                 -- NULL = this machine
  env_id             TEXT,                 -- the environment whose opencode runs the session
  branch             TEXT,
  directory          TEXT,
  step               TEXT NOT NULL,        -- StartStep
  error              TEXT,
  session_id         TEXT,
  session_removed_at INTEGER,
  picked_at          INTEGER,
  discarded_at       INTEGER,
  spec_phase         TEXT CHECK (spec_phase IN ('propose', 'implement', 'archived')),
  spec_change        TEXT,                 -- the OpenSpec change, once the Spec view found it
  spec_archived      TEXT,                 -- folder under openspec/changes/archive/
  PRIMARY KEY (task_id, n)
);
CREATE UNIQUE INDEX variants_session ON variants (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,           -- monotonic, used as cursor
  at          INTEGER NOT NULL,
  project_id  TEXT REFERENCES projects (id),  -- NULL for events with no project (e.g. a ticket refresh)
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'variant', 'system')),
  actor_id    TEXT,                          -- variant: '<task>/<n>'
  verb        TEXT NOT NULL,                 -- e.g. 'task.started', 'session.removed'
  object_type TEXT NOT NULL,                 -- task | variant | session | project, more in later changes
  object_id   TEXT NOT NULL,
  task_id     TEXT,                          -- denormalised for the task feed
  data        TEXT                           -- JSON, small: names, URLs, error text
);
CREATE INDEX events_project ON events (project_id, id);
CREATE INDEX events_object  ON events (object_type, object_id, id);
CREATE INDEX events_task    ON events (task_id, id) WHERE task_id IS NOT NULL;
```

Later changes add `branches`, `worktrees`, `environments`, `pull_requests` and so on to migration 1, and point `variants` at them. Today's `branch`/`directory`/`env_id` columns are plain values so the snapshot and pick logic don't need those tables yet.

The spec chain is split by where it is decided. `spec_first`, `proposed_in` and `implemented_in` belong to the task as a whole. Phase, change and archived folder are found per worktree by the Spec view, as they are per session today, so they live on the variant.

### Projects are upserted by discovery

`setProjects` upserts every discovered project and clears `missing_since`. Rows not in the list get `missing_since` = now. Missing projects stay out of the snapshot as today, and their tasks remain in the database. If the project's folder comes back at the same path, it gets the same id, so all its history reattaches. A project row exists before any task can be created for it, because tasks are only started for discovered projects.

### Repositories behind `HubDeps`

`src/server/db/` exposes small synchronous repositories: `ProjectStore` (`upsertAll`, `get`) and `TaskStore` (`createTask`, `updateVariant`, `attachSession`, `adoptSession`, `markSessionsGone`, `pick`, `setSpec`, `archive`, `listForProject`, `bySession`). `StateStore` keeps emitting snapshots, and its `startingTasks` map is replaced by reads from `TaskStore`. Only `StartingVariant.log` stays in memory: it holds the last 30 lines, is noisy, and isn't worth persisting. Tests use an in-memory database (`:memory:`).

### The database is the only task record

Sessions are created without `metadata.opendevhub`. Everything that read `TaskMeta` reads the store instead:

- `SessionView.task` becomes `{ id, kind, n, discarded }`, joined from `variants.session_id`. It is set for every top-level session once reconcile has run.
- `specs.ts` reads and writes the spec chain with `TaskStore.setSpec` instead of `patchTaskMetadata`.
- `usage.ts` attributes cost to a task through `TaskStore.bySession`.
- `cleanup.ts` and `status.ts` read `discarded_at` instead of the metadata flag.

`TaskMeta`, `parseTaskMeta`, `patchTaskMetadata` and `discardMetadata` are deleted.

### Claims instead of metadata during session creation

Without `TaskMeta`, reconcile can no longer tell that a session it lists belongs to a task whose `attachSession` hasn't run yet. Code that creates a session (a task variant or a manual session) first registers an in-memory claim for `(env, directory)` on `TaskStore`, then calls `createSession`, writes `session_id` on the variant, and releases the claim in a `finally`. While a directory is claimed, reconcile does not adopt unknown sessions in it. It leaves them for the next pass, by which time the creator has attached them. Because the hub is a single process, the claim is exact, with no grace period.

### When manual tasks are created

- **opendevhub starts a session outside a task** (`Sessions.startSession`, `Checkouts.createWorktree` with a session, `Sessions.generateIn` creating a new session): it claims the directory, creates the session, and then creates a `manual` task with one variant (`step = 'session'`, `session_id`, `directory`, `env_id`, and `branch` when the directory is a worktree) before `reconcile`.
- **Reconcile finds a top-level session with no row in an unclaimed directory** (it was created in opencode directly): reconcile adopts it into a new `manual` task with `created_at` set to the session's creation time. Subagent sessions (those with `parentID`) are never adopted.

A manual task's title follows its session's title on each reconcile, because opencode renames sessions after the first turn. A `task`-kind title never changes.

### Ended, not deleted

When reconcile of an environment no longer lists a variant's session, it sets `session_removed_at`. This covers removal, cleanup and archiving in opencode. A missing environment, such as a stopped container, unreachable node or failed listing, does **not** count as removal. Only a successful listing does. A task is _ended_ when all of its variants have no live session and none is still starting. Ended tasks stay in the snapshot, collapsed, until the user archives them. Archived tasks drop out of the snapshot, but their rows are kept.

### Restart

On start, variants in `queued | pushing | worktree | image | container` without a session are set to `failed` with the error "interrupted: opendevhub restarted", because the job that was setting them up no longer exists.

### Events are written inside the repositories

Each repository method that changes state inserts its event in the same transaction, so call sites can't forget one, and a rolled-back change leaves no event behind. This change records `project.discovered`, `project.missing`, `task.started`, `task.ended`, `task.archived`, `variant.failed`, `variant.picked`, `variant.discarded`, `session.started`, `session.adopted` and `session.removed`. The actor is passed in: `user` for API requests, `variant` for writes a task's setup job makes for its variant, `system` for reconcile and restart. Verbs are a closed TypeScript union in `src/server/db/events.ts`, which later changes extend. Only state _changes_ emit events, and reconcile is idempotent, so a steady state emits nothing. _Alternative considered:_ SQLite triggers. Rejected: triggers don't know the actor, and verbs like `session.adopted` vs `session.started` depend on the code path.

### API shape

```ts
interface TaskView {
  id: string;
  kind: "task" | "manual";
  title: string;
  jira?: JiraTaskSource;
  spec?: { first: boolean; proposedIn?: string; implementedIn?: string };
  createdAt: number;
  state: "starting" | "running" | "ended";
  variants: VariantView[]; // n, model, agent, node, branch, directory, envId, step, error, sessionId, sessionRemoved, picked, discarded, spec { phase, change, archived }
}
```

`ProjectView.tasks` replaces the web app's `taskSessions` grouping and `ProjectView.starting`, which is removed in this change.

## Risks / Trade-offs

- **`node:sqlite` is still flagged experimental** → It is stable enough for this use, and all access goes through `src/server/db/`. Swapping in `better-sqlite3` later is a change to one module.
- **Adoption races on session creation** → the creator's claim keeps reconcile from adopting the session until it is attached. Any leftover race (a crash between `createSession` and the attach) only creates a manual task, and the unique `session_id` index prevents duplicates.
- **A flaky environment listing could falsely end tasks** → only a successful listing marks sessions gone, and `session_removed_at` is cleared if the session reappears.
- **The task list grows without limit** → archiving, and cleanup offers to archive ended tasks older than the session idle cutoff it already uses.
- **Losing the database loses task history** → sessions survive in opencode and are re-adopted as manual tasks on the next reconcile. Picks, spec chain and the grouping of variants are lost. That is acceptable before release. Backups are a later concern.

## Open Questions

- ~~Should AI-review and commit-message sessions get their own kind now?~~ They stay `manual` here. `link-pull-requests-and-tickets` adds the `review` kind with `tasks.pull_request_id`. Commit-message sessions stay `manual`.
- Should archiving a task also offer to remove its sessions and worktrees, or only hide the task? This proposal only hides it. Removal stays with cleanup and pick.
