## Why

A task's worktree branches from the main checkout's local base branch, and opendevhub never fetches before creating it. When local `main` lags `origin/main`, the task starts from stale code. Nothing on the task page or the Review page shows this, because their ahead/behind counts compare against that same stale local branch. The user only finds out at merge or pull-request time.

## What Changes

- Before a task's worktrees are created, opendevhub fetches the base's remote. When it is safe, it also fast-forwards the local base branch to its upstream, so every variant starts from the latest base. Safe means: a fast-forward only, and the main checkout is untouched or clean.
- When the base can't be fast-forwarded, the task starts from the local base as today, and the reason is recorded in the activity log. The reasons are: uncommitted changes in the main checkout, local commits not on the remote, no upstream, or the remote is unreachable.
- The new task dialog shows one status line under Base. It says whether the base will be updated (and by how many commits), is already up to date, or can't be updated (and why). It also shows how long ago the last fetch was.
- A new Git setting, "Update the base branch before starting a task", is on by default.
- A new endpoint reports a branch's position relative to its upstream and fetches first when the last fetch is older than a threshold.
- Phase 2: the status rail's Target section becomes a Position section. It is a small diagram of the base's upstream, the local base, where the task branched, the task branch's HEAD and its pushed upstream, with commit counts between them and when it last fetched. The rail also gets a ⟳ (fetch) action and a Pull action that runs the same fast-forward. The status strip gains ↑ahead ↓behind against the base's upstream.

## Capabilities

### New Capabilities

- `fresh-task-base`: Fetching and fast-forwarding the base before a task starts, when that's safe. Also covers the fallback when it isn't, the new task dialog's base status line, the setting, and the fetch freshness/throttling rules.

### Modified Capabilities

- `task-page-layout`: In the Status rail requirement, Target becomes Position (the branch-position diagram, fetch and Pull), and the status strip adds ahead/behind against the base's upstream.

## Impact

- **Server**: `server/git/ops.ts` gets a safe fast-forward and an upstream lookup for a branch. The worktree creation path (`server/git/checkouts.ts`, task bring-up in `server/environments/environments.ts`) gets a pre-create fetch and fast-forward step. A new route serves the base position. A last-fetch timestamp is kept per project in runtime state.
- **Web**: Base status line in `web/features/tasks/new-task-dialog.tsx`; Position section in `web/features/tasks/task-status.tsx`; the setting in `web/features/settings/git-settings.tsx`.
- **Shared**: Types for base position and update outcome in `shared/types.ts`; the new setting in project settings.
- **Behaviour**: opendevhub may now fast-forward the user's main checkout when it is clean and on the base. It never merges, rebases or touches uncommitted work.
- **Out of scope**: Tasks whose worktree lives on a remote node keep today's behaviour. A full scrolling repository graph is not part of this change.
- **Dependencies**: None; the diagram is hand-drawn SVG.
