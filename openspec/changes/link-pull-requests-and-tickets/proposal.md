## Why

Pull requests and Jira tickets are where work starts and ends, but opendevhub connects them to its own work only loosely:

- a task carries only a JSON copy of its ticket, and the Jira page finds a ticket's tasks by scanning every task in the snapshot;
- a published branch remembers its pull request only as a URL string;
- an AI review session is linked to its pull request only through its title (`AI review: PR #12 …`), and its findings are thrown away once the dialog closes.

Nobody can answer "which task produced this PR?", "what happened to this ticket?" or "what did the last AI review say?". Depends on `persist-environments`. Like the rest of the series, it replaces the old storage outright: no backfill and no rollback path.

## What Changes

- Add a `tickets` table (Jira instance + key, URL, title snapshot) and a `pull_requests` table (URL, forge kind, owner/repo/number, title/state snapshot, head/base).
- Point tasks at their ticket (`tasks.ticket_id`), set from the Jira source when a task starts from a ticket.
- Point branches at a pull request (`branches.pull_request_id`, with `pr_role`): `head` when opendevhub published the branch and the forge printed a pull request, `checkout` when the branch was made to check out a pull request. These links replace the `branches.pr_url` and `origin_url` columns from `link-branches-and-worktrees`.
- Add **review tasks**: AI review sessions become tasks of kind `review` that point at their pull request (`tasks.pull_request_id`), instead of manual tasks found by title.
- Add a `reviews` table: each AI review run (in a checkout session, or quick from the diff) records the pull request, head commit, session, summary and findings.
- Add lookups in both directions:
  - a task's ticket and its pull requests (through its variants' branches);
  - a pull request's tasks, branches, worktrees and reviews;
  - a ticket's tasks and pull requests.
- Show these links on the Jira ticket page (replacing the snapshot scan), the Forgejo pull request page ("Made by task …", "Checked out in …", "Earlier AI reviews"), and the task page.
- Record events when a ticket or pull request is linked and when a review runs.

## Capabilities

### New Capabilities

- `pull-request-links`: pull request rows and their events, their links to branches (head/checkout) and tasks, snapshots refreshed from the forge, and lookups from a PR.
- `ticket-links`: ticket rows and their events, tasks started from tickets, lookups from a ticket (tasks, and PRs through branches), and the Jira page using them.
- `ai-review-records`: review tasks and stored review runs with findings, and the pull request page listing earlier reviews.

### Modified Capabilities

<!-- None in openspec/specs/. Adds task kind `review` and task columns to migration 1, which task-persistence (persist-tasks) creates. -->

## Impact

- **Server**: the `tickets`, `pull_requests` and `reviews` tables and the new task and branch columns added to migration 1; link and review verbs in `src/server/db/events.ts`; new `src/server/db/links.ts`; `tasks/tasks.ts` (ticket link), `git/publish.ts` and `git/checkouts.ts` (PR links), `api/forgejo.ts` (review tasks and review rows, snapshot refresh on details), `api/jira.ts` and `api/projects.ts` (lookups), `integrations/ai-review.ts`.
- **API**:
  - `TaskView` gains `ticket?`, `pullRequests[]` and `reviewOf?`.
  - New `GET /api/links/pull?url=` and `GET /api/links/ticket?instance=&key=`.
  - `GET /api/forgejo/pulls/:owner/:repo/:number/ai-reviews` lists stored reviews.
- **Web**: the Jira page, the Forgejo PR page and AI review dialog, and the task page.
- **Data**: findings are stored for the first time (they are the model's text plus file/line). The task kind constraint gains `review` in migration 1.
