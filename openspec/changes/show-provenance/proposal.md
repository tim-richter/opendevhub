## Why

After the previous changes, the database knows how tasks, variants, branches, worktrees, environments, sessions, pull requests, tickets and reviews relate. But it keeps only the current state, and the dashboard still shows each entity on its own. "What created this?", "what happened to this ticket?" and "what changed while I was away?" are still hard to answer from the UI, which was the goal of this whole series. Depends on `link-pull-requests-and-tickets`.

## What Changes

- Add an append-only `events` table recording what happened, when, who did it (the user, a task variant, or opendevhub itself) and to what: task started/ended/archived, variant failed/picked/discarded, worktree created/removed, environment created/removed, session started/adopted/removed, branch published/deleted, pull request linked, review run, ticket linked.
- Add an activity feed: per project and across all projects, newest first, paginated, filterable by entity. It's live through the existing snapshot stream (the snapshot carries the latest event id).
- Add a **provenance trail** on every entity page: a breadcrumb from the origin down. For example, _Ticket APP-42 › Task "Add login" › Variant 2 (opus) › Branch task/add-login-2 › Worktree › Container › Session_, with the pull request and reviews alongside. Each part links to its page.
- Make the **task page the hub**. It shows the ticket, every variant (model, state, cost, branch, worktree, environment, session, PR), reviews, the spec chain (proposed in / implemented in), and the task's own activity.
- Add a "Created by" chip to sessions, worktrees, branches and environments in the lists, and "Linked" panels on the PR and ticket pages, built on the lookups from the previous change.
- Retention: events older than 180 days are deleted at startup. Cleanup also offers to delete reviews of pull requests that are closed and older than the session idle cutoff.

## Capabilities

### New Capabilities

- `activity-log`: the event table, what is recorded where, the feed API with paging and filters, live updates, and retention.
- `provenance-ui`: the breadcrumb trail, the task hub page, "Created by" chips, and the PR and ticket panels.

### Modified Capabilities

<!-- None in openspec/specs/. -->

## Impact

- **Server**: migration 5; new `src/server/db/events.ts`. Event writes go in the repositories (`tasks`, `checkouts`, `environments`, `links`) so that every state change and its event are in the same transaction. New activity routes; `DashboardSnapshot.activity` (latest event id); cleanup (`git/cleanup.ts`) for reviews.
- **API**: `GET /api/activity?project=&entity=&before=&limit=` and `GET /api/provenance/:type/:id`.
- **Web**: a new activity page and per-project feed; a breadcrumb component used on the session, task, checkout, PR and ticket pages; the task page reworked as the hub; chips in the session, worktree and environment lists.
- **Data**: the event table grows with use, bounded by retention.
