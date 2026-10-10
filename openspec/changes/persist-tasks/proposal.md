## Why

A task has no record of its own: it exists only as `metadata.opendevhub` on its opencode sessions, plus an in-memory `StartingTask` while it starts. Removing its sessions erases the task, a failed start is forgotten on restart, and sessions started outside a task belong to nothing. That makes it hard to tell what created what. This change gives every session a task, and gives tasks a durable home. Later work will link worktrees, branches, pull requests and tickets to that home.

## What Changes

- Add a local SQLite database (`opendevhub.db` in the state directory, via `node:sqlite`) with numbered schema migrations.
- Persist **tasks** and their **variants** (one variant = one model/agent attempt, with its node, branch, step, error and session). Keep `TaskMeta` on sessions as well, so that existing data and older builds keep working.
- Persist the start-up progress of a task's variants (`StartingTask`). A variant that failed while starting stays visible after a restart until it is dismissed.
- Add **implicit manual tasks**. Every top-level session that doesn't belong to a task gets a task of kind `manual` with one variant. This covers sessions opendevhub starts outside a task (new session, a worktree with a session, generated-text sessions) and sessions it finds that were created elsewhere.
- Record picks and discards on the variant (`picked_at`, `discarded_at`), in addition to the existing `discarded` metadata flag.
- Keep tasks after their sessions are gone. A variant whose session disappears is marked `session_removed_at`. A task whose variants have no live sessions is shown as ended until it is archived.
- Add an **archive task** action, and have cleanup offer to archive ended tasks.
- Backfill on first start: create tasks and variants from the `TaskMeta` of existing sessions, and manual tasks for the other top-level sessions.
- Have the dashboard snapshot list each project's `tasks`. The web app groups sessions by these tasks instead of deriving the groups from session metadata.

## Capabilities

### New Capabilities

- `task-persistence`: the database, the task and variant records, their lifecycle (starting, running, ended, archived), backfill from session metadata, and reconciliation with opencode.
- `manual-tasks`: every top-level session without a task gets an implicit manual task, both when opendevhub starts the session and when it finds one created elsewhere.

### Modified Capabilities

<!-- None: openspec/specs/ is empty; existing task behaviour is not yet specified. -->

## Impact

- **Server**: a new `src/server/db/` module (connection, migrations, task repository). Changes in `tasks/tasks.ts` (begin, run, pick, dismiss), `sessions/sessions.ts` (`startSession`, `generateIn`, `removeSession`), `git/checkouts.ts` (`createWorktree` with a session), `projects/state.ts` (`StartingTask` moves out of memory, snapshot gains `tasks`), `git/cleanup.ts` (archive offers) and `cli.ts` (open the DB, run backfill).
- **API**: `ProjectView` gains `tasks: TaskView[]`. New `POST /api/projects/:id/tasks/:task/archive`. `starting` stays for now but is derived from the DB.
- **Web**: task lists, the task page and the session list read `view.tasks`. Manual tasks render as a single session without the variant chrome.
- **Dependencies**: none new. `node:sqlite` is built in from Node 22.13, which is the current `engines` floor. It logs an experimental warning that we suppress.
- **Data**: new file `~/.local/state/opendevhub/opendevhub.db` (mode 0600). `state.json` and the git config keys are not changed in this change.
