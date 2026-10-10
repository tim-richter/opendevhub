## Context

At this point, the database has `projects`, `tasks`, `variants`, `branches`, `worktrees`, `environments`, `tickets`, `pull_requests` and `reviews`, linked by foreign keys, plus the `events` table that every repository writes to in the same transaction as its change. Nothing reads the events yet. The web app has separate pages for sessions, tasks, checkouts, the Forgejo PR and the Jira ticket. The links between them are only those added in the previous change.

## Goals / Non-Goals

**Goals:**

- One place to see what happened in a project, or everywhere, and when.
- From any entity, one click to what created it and to what it led to.
- The task page answers everything about a piece of work.

**Non-Goals:**

- Recording session content (turns, tool calls). opencode has that, and the session page shows it.
- Recording volatile runtime state changes (container up/down, opencode health, port changes). That would be noise, and the logs page covers it.
- Notifications built on events. `notifier.ts` keeps its own triggers, and building on events is a possible follow-up.
- Undo or audit guarantees. Events are for orientation, not compliance.

## Decisions

### Events come from the earlier changes

The `events` table, the `EventVerb` union and the writes inside the repositories already exist: `persist-tasks` created them, and each later change added its verbs. Adoption already writes a single `*.adopted` event dated at adoption, with no made-up earlier history. This change only reads the table: it adds `page(filter, before, limit)` and `prune(olderThan)` to `src/server/db/events.ts`, and a renderer for every verb. A test fails when a verb in the union has no renderer, so a later change can't add a verb the UI ignores.

### Feed API and live updates

`GET /api/activity` pages by `before=<id>` (keyset pagination, default 50) and filters by `project`, `task`, or `entity=<type>:<id>` (matching the object, or the task for task feeds). `DashboardSnapshot.activity = { latestId }` changes with every event. The web app refetches the first page when it changes, and the client merges by id. This uses the snapshot stream that already exists instead of a second channel.

### Provenance is computed, not stored

`GET /api/provenance/:type/:id` walks the foreign keys upward (session → variant → task → ticket; worktree → branch → variant → task; environment → worktree → …; PR → branches → variants → tasks) and returns an ordered trail plus "led to" lists (task → PRs, reviews). Nothing extra is stored. The trail is always consistent with the rows. Each step has `{ type, id, label, href, removed }`. Removed entities stay in the trail, shown struck through, so history stays readable.

### Task page as hub

The existing task page (variant comparison) becomes a tab of the hub. The header has the title, kind, ticket chip and state. Variants show as rows: model, state, cost/tokens, branch, worktree/environment, session, PR. Other sections are reviews (for review tasks and for the task's PRs) and the spec chain (`proposed_in` / `implemented_in` on the task rows, phase and change on the variants), plus the task's activity feed. Manual tasks render the same page with a single row and no comparison tab.

### Retention

At startup, delete events older than 180 days in batches of 1000. The cleanup plan gets a "reviews" category: reviews whose pull request is closed or merged and whose last review is older than the session idle cutoff, offered unchecked as cleanup already does for idle sessions.

## Risks / Trade-offs

- **Event volume from reconcile** (adopting unmanaged worktrees and sessions every few seconds) → only state _changes_ emit events, and reconcile is idempotent, so a steady state emits nothing.
- **The snapshot changes on every event and makes all clients re-render** → `latestId` is one number. Only the activity view refetches, and other views ignore the change because their memoised selectors don't depend on it.
- **Provenance walks get slow** → each walk is at most about 8 joins on indexed keys over small tables. Measure in tests with 10k tasks and add a cache only if needed.
- **The UI rework touches many pages** → the breadcrumb is one component, and pages adopt it one at a time behind the same data, so tasks can land page by page.

## Open Questions

- Should the global activity page be the dashboard's start page, or stay a separate entry in the shell? This design adds it to the shell navigation and leaves the start page alone.
- Is 180 days the right retention, and should it be a setting? It's a constant for now.
