## Context

opendevhub keeps its state in four places:

- `config.json`: settings
- `state.json`: container runtimes and task environments
- git config: `branch.<b>.opendevhub*` keys
- opencode session metadata: `TaskMeta`

A task is only the shared `task` id in the `TaskMeta` of its sessions. `Tasks.beginTask` puts a `StartingTask` in `StateStore` memory. Once a variant's session shows up, the variant leaves that list, and from then on the dashboard rebuilds the task from session metadata (`taskSessions` in `web/features/tasks/tasks.ts`). Sessions without `TaskMeta`, whether started from the session list, from "new worktree with session", by `generateIn`, or directly in opencode, belong to no task.

This change is the first step of a larger data model (task → variant → branch/worktree/environment/session → pull request, ticket → task). It only introduces the database, tasks and variants. Its schema leaves room for the rest.

## Goals / Non-Goals

**Goals:**

- Tasks and variants are durable rows. They outlive their sessions, a restart and cleanup.
- Every top-level session belongs to exactly one task, using an implicit `manual` task when needed.
- Starting progress (step, error) survives a restart.
- The dashboard reads tasks from the server instead of deriving them from session metadata.
- Existing installs are backfilled automatically, and the change can be rolled back without losing data.

**Non-Goals:**

- Branches, worktrees, environments, pull requests, tickets and reviews as tables (later changes).
- Moving `state.json` or the `branch.<b>.opendevhub*` git config keys into the database.
- Moving the spec chain (`TaskSpec`: phase, change, proposedIn, implementedIn) out of session metadata. It stays where it is, and `TaskView` exposes it from the variant sessions as today.
- Mirroring session content, status, cost or tokens. opencode remains the source of truth for those.
- An activity/event log.

## Decisions

### SQLite through `node:sqlite`

`node:sqlite` (`DatabaseSync`) is built in from Node 22.13, which is already the `engines` floor, so it adds no native dependency to build for each platform. Its API is synchronous, which suits a single-process server with small tables. We suppress the one-time `ExperimentalWarning` for `node:sqlite` only. _Alternatives:_ `better-sqlite3` (mature, but a second native addon next to `node-pty` and the keyring, with prebuild issues on new Node versions); JSON files like `state.json` (no foreign keys or queries, and they grow badly once events and links arrive); Drizzle or Kysely (not worth it for a handful of tables; plain SQL and typed row mappers are enough).

### Location and migrations

The database file is `stateDir()/opendevhub.db` (default `~/.local/state/opendevhub/`), created with mode 0600 and opened with `journal_mode=WAL` and `foreign_keys=ON`. It holds generated state, not configuration, which is why it lives in `stateDir` rather than next to `config.json`. Migrations are an ordered array of SQL strings in `src/server/db/migrations.ts`, applied in one transaction each and tracked with `PRAGMA user_version`. If the database is newer than the code, the server refuses to start with a clear error rather than guessing.

### Schema

```sql
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,            -- newTaskId(); same id as TaskMeta.task
  project_id  TEXT NOT NULL,               -- ProjectId; no FK yet (projects come from discovery)
  kind        TEXT NOT NULL CHECK (kind IN ('task', 'manual')),
  title       TEXT NOT NULL,
  prompt      TEXT,                        -- NULL for manual tasks and backfilled tasks
  jira        TEXT,                        -- JSON JiraTaskSource snapshot
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX tasks_project ON tasks (project_id, archived_at);

CREATE TABLE variants (
  task_id            TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  n                  INTEGER NOT NULL,     -- 1-based, TaskMeta.variant
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
  PRIMARY KEY (task_id, n)
);
CREATE UNIQUE INDEX variants_session ON variants (session_id) WHERE session_id IS NOT NULL;
```

Later changes add `branches`, `worktrees`, `pull_requests` and so on, and point `variants` at them. Today's `branch`/`directory`/`env_id` columns are kept as plain values so the snapshot and pick logic don't need those tables yet.

### A `TaskStore` behind `HubDeps`

`src/server/db/tasks.ts` exposes a small synchronous repository: `createTask`, `updateVariant`, `attachSession`, `adoptSession`, `markSessionsGone`, `pick`, `archive`, `listForProject`. `StateStore` keeps emitting snapshots, and its `startingTasks` map is replaced by reads from `TaskStore`. Only `StartingVariant.log` stays in memory: it holds the last 30 lines, is noisy, and isn't worth persisting. Tests use an in-memory database (`:memory:`).

### The database decides task identity, metadata keeps compatibility

Tasks still write `TaskMeta` to every session they create, and picks still set `discarded` in metadata. Rows are the source of truth for title, kind, archive and pick state. Metadata is only used to attach a session to its task, so a session a task created can never be adopted as a manual task, even if reconcile sees it before `attachSession` runs. Because of the dual write, older builds keep working after a rollback.

### When manual tasks are created

- **opendevhub starts a session outside a task** (`Sessions.startSession`, `Checkouts.createWorktree` with a session, `Sessions.generateIn` creating a new session): right after `createSession`, before `reconcile`, it creates a `manual` task with one variant (`step = 'session'`, `session_id`, `directory`, `env_id`, and `branch` when the directory is a worktree).
- **Reconcile finds a top-level session with neither a row nor `TaskMeta`** (it was created in opencode directly, or before this change): reconcile adopts it into a new `manual` task with `created_at` set to the session's creation time. Subagent sessions (those with `parentID`) are never adopted.

A manual task's title follows its session's title on each reconcile, because opencode renames sessions after the first turn. A `task`-kind title never changes.

### Ended, not deleted

When reconcile of an environment no longer lists a variant's session, it sets `session_removed_at`. This covers removal, cleanup and archiving in opencode. A missing environment, such as a stopped container, unreachable node or failed listing, does **not** count as removal. Only a successful listing does. A task is _ended_ when all of its variants have no live session and none is still starting. Ended tasks stay in the snapshot, collapsed, until the user archives them. Archived tasks drop out of the snapshot, but their rows are kept.

### Restart

On start, variants in `queued | pushing | worktree | image | container` without a session are set to `failed` with the error "interrupted: opendevhub restarted", because the job that was setting them up no longer exists.

### Backfill

Migration 1 creates the tables. The first reconcile of each environment after that backfills that environment from the sessions it lists, using the same adoption path:

- sessions with `TaskMeta` → upsert the task (`kind = 'task'`, title, jira, `created_at` = the oldest session's creation time) and the variant (`n`, branch, model, `discarded_at` when `discarded`).
- other top-level sessions → manual tasks.

Backfill is idempotent because it runs on every reconcile, and it doesn't need a separate one-off step. That also covers environments that are offline at upgrade time.

### API shape

```ts
interface TaskView {
  id: string;
  kind: "task" | "manual";
  title: string;
  jira?: JiraTaskSource;
  createdAt: number;
  state: "starting" | "running" | "ended";
  variants: VariantView[]; // n, model, agent, node, branch, directory, envId, step, error, sessionId, sessionRemoved, picked, discarded
}
```

`ProjectView.tasks` replaces the web app's `taskSessions` grouping. `ProjectView.starting` is kept, derived from `tasks`, until the web app no longer reads it, and is then removed in the same change.

## Risks / Trade-offs

- **`node:sqlite` is still flagged experimental** → It is stable enough for this use, and all access goes through `src/server/db/`. Swapping in `better-sqlite3` later is a change to one module.
- **Session metadata and DB rows can disagree after a rollback and upgrade** (for example, an old build picked a variant) → reconcile copies `discarded` from metadata into `discarded_at` when the row hasn't been picked or discarded yet. Pick state, the one field both sides write, ends up the same.
- **Adoption races on session creation** → a session a task created already carries `TaskMeta` when it's created. A manual session's row is written before `reconcile`. Any leftover race only creates a manual task, and the unique `session_id` index prevents duplicates.
- **A flaky environment listing could falsely end tasks** → only a successful listing marks sessions gone, and `session_removed_at` is cleared if the session reappears.
- **The task list grows without limit** → archiving, and cleanup offers to archive ended tasks older than the session idle cutoff it already uses.

## Migration Plan

1. Ship the database plus dual writes. Backfill happens on reconcile, and the web app switches to `view.tasks`.
2. Rollback: older builds ignore `opendevhub.db` and keep working from `TaskMeta`. Rows created in the meantime come back on the next upgrade through reconcile.
3. Follow-up changes add `branches`/`worktrees` (replacing the `opendevhub*` git config keys), then environments from `state.json`, then pull requests, tickets and reviews.

## Open Questions

- ~~Should AI-review and commit-message sessions get their own kind now?~~ They stay `manual` here. `link-pull-requests-and-tickets` adds the `review` kind with `tasks.pull_request_id` and converts existing review sessions. Commit-message sessions stay `manual`.
- Should archiving a task also offer to remove its sessions and worktrees, or only hide the task? This proposal only hides it. Removal stays with cleanup and pick.
