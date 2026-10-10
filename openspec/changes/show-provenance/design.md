## Context

At this point, the database has `projects`, `tasks`, `variants`, `branches`, `worktrees`, `environments`, `tickets`, `pull_requests` and `reviews`, linked by foreign keys. Rows have creation and removal times but no history: a variant that was discarded only shows `discarded_at`, not who discarded it or what else happened. The web app has separate pages for sessions, tasks, checkouts, the Forgejo PR and the Jira ticket. The links between them are only those added in the previous change.

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

### Schema (migration 5)

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,           -- monotonic, used as cursor
  at          INTEGER NOT NULL,
  project_id  TEXT REFERENCES projects (id),  -- NULL for events with no project (e.g. a ticket refresh)
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'variant', 'system')),
  actor_id    TEXT,                          -- variant: '<task>/<n>'
  verb        TEXT NOT NULL,                 -- e.g. 'task.started', 'worktree.removed'
  object_type TEXT NOT NULL,                 -- task | variant | branch | worktree | environment | session | pull_request | ticket | review
  object_id   TEXT NOT NULL,
  task_id     TEXT,                          -- denormalised for the task feed
  data        TEXT                           -- JSON, small: names, URLs, error text
);
CREATE INDEX events_project ON events (project_id, id);
CREATE INDEX events_object  ON events (object_type, object_id, id);
CREATE INDEX events_task    ON events (task_id, id) WHERE task_id IS NOT NULL;
```

Verbs are a closed TypeScript union, so the UI can render each one deliberately.

### Events are written inside the repositories

Each repository method that changes state (`createTask`, `markSessionsGone`, `pick`, `insertWorktree`, `reconcileWorktrees`, `linkBranch`, `insertReview`, …) inserts its event in the same transaction. Call sites can't forget an event, and a rolled-back change leaves no event behind. The actor is passed in from the API layer (`user` for requests, `variant` for writes a task's setup job makes for its variant, `system` for reconcile and backfill). _Alternative considered:_ SQLite triggers. Rejected: triggers don't know the actor, and verbs like `session.adopted` vs `session.started` depend on the code path.

### Backfill is not replayed as events

Backfill and adoption of existing rows write a single `system` event per entity (`*.adopted`), dated now, not a fake history. Earlier history isn't known, and the UI says so ("tracked since …").

### Feed API and live updates

`GET /api/activity` pages by `before=<id>` (keyset pagination, default 50) and filters by `project`, `task`, or `entity=<type>:<id>` (matching the object, or the task for task feeds). `DashboardSnapshot.activity = { latestId }` changes with every event. The web app refetches the first page when it changes, and the client merges by id. This uses the snapshot stream that already exists instead of a second channel.

### Provenance is computed, not stored

`GET /api/provenance/:type/:id` walks the foreign keys upward (session → variant → task → ticket; worktree → branch → variant → task; environment → worktree → …; PR → branches → variants → tasks) and returns an ordered trail plus "led to" lists (task → PRs, reviews). Nothing extra is stored. The trail is always consistent with the rows. Each step has `{ type, id, label, href, removed }`. Removed entities stay in the trail, shown struck through, so history stays readable.

### Task page as hub

The existing task page (variant comparison) becomes a tab of the hub. The header has the title, kind, ticket chip and state. Variants show as rows: model, state, cost/tokens, branch, worktree/environment, session, PR. Other sections are reviews (for review tasks and for the task's PRs) and the spec chain (`proposedIn` / `implementedIn`, still read from `TaskSpec`), plus the task's activity feed. Manual tasks render the same page with a single row and no comparison tab.

### Retention

At startup, delete events older than 180 days in batches of 1000. The cleanup plan gets a "reviews" category: reviews whose pull request is closed or merged and whose last review is older than the session idle cutoff, offered unchecked as cleanup already does for idle sessions.

## Risks / Trade-offs

- **Event volume from reconcile** (adopting unmanaged worktrees and sessions every few seconds) → only state _changes_ emit events, and reconcile is idempotent, so a steady state emits nothing.
- **The snapshot changes on every event and makes all clients re-render** → `latestId` is one number. Only the activity view refetches, and other views ignore the change because their memoised selectors don't depend on it.
- **Provenance walks get slow** → each walk is at most about 8 joins on indexed keys over small tables. Measure in tests with 10k tasks and add a cache only if needed.
- **The UI rework touches many pages** → the breadcrumb is one component, and pages adopt it one at a time behind the same data, so tasks can land page by page.

## Migration Plan

Migration 5 adds `events`. No backfill of history. Each existing entity gets an `adopted` event lazily, the first time a repository touches it, or not at all. Rollback: older builds ignore the table.

## Open Questions

- Should the global activity page be the dashboard's start page, or stay a separate entry in the shell? This design adds it to the shell navigation and leaves the start page alone.
- Is 180 days the right retention, and should it be a setting? It's a constant for now.
