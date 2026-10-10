## Why

A task has no record of its own: it exists only as `metadata.opendevhub` (`TaskMeta`) on its opencode sessions, plus an in-memory `StartingTask` while it starts. Removing its sessions erases the task, a failed start is forgotten on restart, and sessions started outside a task belong to nothing. That makes it hard to tell what created what. This change gives every session a task, and gives tasks a durable home. Later work will link worktrees, branches, environments, pull requests and tickets to that home.

opendevhub has no users yet, so this series replaces the old storage outright: no backfill, no dual writes, no rollback path.

## What Changes

- Add a local SQLite database (`opendevhub.db` in the state directory, via `node:sqlite`) with a numbered migration runner. Until the first release, the series edits migration 1 in place.
- Add a **projects** table. Discovery upserts one row per project and marks projects it no longer finds as missing instead of deleting them, so their tasks survive. Tasks, and the tables later changes add, reference it by foreign key.
- Persist **tasks** and their **variants** (one variant = one model/agent attempt, with its node, branch, step, error and session). The database is the only record of a task.
- Move the spec chain (`TaskSpec`: phase, change, archived folder, proposed in, implemented in) from session metadata into the task and variant rows.
- **BREAKING (internal)**: remove `TaskMeta` from session metadata, together with `parseTaskMeta`, `patchTaskMetadata` and `discardMetadata`. `SessionView.task` becomes a reference to the session's task row.
- Persist the start-up progress of a task's variants (`StartingTask`). A variant that failed while starting stays visible after a restart until it is dismissed.
- Add **implicit manual tasks**. Every top-level session that doesn't belong to a task gets a task of kind `manual` with one variant. This covers sessions opendevhub starts outside a task (new session, a worktree with a session, generated-text sessions) and sessions it finds that were created elsewhere.
- Record picks and discards on the variant (`picked_at`, `discarded_at`).
- Keep tasks after their sessions are gone. A variant whose session disappears is marked `session_removed_at`. A task whose variants have no live sessions is shown as ended until it is archived.
- Add an **archive task** action, and have cleanup offer to archive ended tasks.
- Add an append-only **events** table and record what happens to tasks, variants and sessions in it. Later changes record events for their own entities, and `show-provenance` builds the feed and UI on it.
- Have the dashboard snapshot list each project's `tasks`. The web app groups sessions by these tasks instead of deriving the groups from session metadata.

## Capabilities

### New Capabilities

- `task-persistence`: the database, the project registry, the task and variant records, their lifecycle (starting, running, ended, archived), the spec chain, the events table with task, variant and session events, and reconciliation with opencode.
- `manual-tasks`: every top-level session without a task gets an implicit manual task, both when opendevhub starts the session and when it finds one created elsewhere.

### Modified Capabilities

<!-- None: openspec/specs/ is empty; existing task behaviour is not yet specified. -->

## Impact

- **Server**: a new `src/server/db/` module (connection, migrations, project, task and event repositories). Changes in `tasks/tasks.ts` and `tasks/request.ts` (begin, run, pick, dismiss; `TaskMeta` helpers removed), `sessions/sessions.ts` (`startSession`, `generateIn`, `removeSession`), `sessions/status.ts` and `sessions/usage.ts` (task lookup by session id), `specs/specs.ts` (spec chain reads and writes), `git/checkouts.ts` (`createWorktree` with a session), `projects/` discovery (project upsert), `projects/state.ts` (`StartingTask` moves out of memory, snapshot gains `tasks`), `git/cleanup.ts` (discard check, archive offers) and `cli.ts` (open the DB).
- **API**: `ProjectView` gains `tasks: TaskView[]`. `SessionView.task` changes from `TaskMeta` to `{ id, kind, n, discarded }`. New `POST /api/projects/:id/tasks/:task/archive`. `ProjectView.starting` is removed.
- **Web**: task lists, the task page, the spec panel, the Jira page and the session list read `view.tasks` and the new `SessionView.task`. Manual tasks render as a single session without the variant chrome.
- **Dependencies**: none new. `node:sqlite` is built in from Node 22.13, which is the current `engines` floor. It logs an experimental warning that we suppress.
- **Data**: new file `~/.local/state/opendevhub/opendevhub.db` (mode 0600). Sessions no longer carry `metadata.opendevhub`. Existing sessions are adopted as manual tasks like any other session found outside a task.
