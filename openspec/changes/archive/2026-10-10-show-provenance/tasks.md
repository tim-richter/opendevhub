## 1. Event queries

- [x] 1.1 Add `page(filter, before, limit)` with labels joined in and `prune(olderThan)` to `src/server/db/events.ts`
- [x] 1.2 Unit tests: keyset paging, filters (project, task, entity), pruning in batches

## 2. API

- [x] 2.1 `GET /api/activity` with `project`, `task`, `entity`, `before` and `limit`, with validation and RPC types
- [x] 2.2 `GET /api/provenance/:type/:id` walking the foreign keys into an ordered trail plus "led to" lists, with removed flags
- [x] 2.3 `DashboardSnapshot.activity.latestId`
- [x] 2.4 Retention at startup (180 days), and the "reviews" category in the cleanup plan

## 3. Web: shared pieces

- [x] 3.1 A `ProvenanceBreadcrumb` component (shadcn breadcrumb, struck-through removed steps)
- [x] 3.2 An `ActivityFeed` component: a renderer for every `EventVerb` (with a test that none is missing), load more, refetch on `latestId` change
- [x] 3.3 A `CreatedByChip` component

## 4. Web: pages

- [x] 4.1 Session page, checkout page, Forgejo PR page and Jira ticket page show the breadcrumb
- [x] 4.2 Task page reworked as the hub: header, variant rows, reviews, spec chain, activity; existing comparison as a tab; manual tasks single-row
- [x] 4.3 Activity page in the shell navigation; activity section on the project page
- [x] 4.4 Created-by chips in the session, worktree/branch and environment lists
- [x] 4.5 Stories and fixtures for the new components and pages

## 5. Wrap-up

- [x] 5.1 Performance check: provenance walk and first feed page with 10k tasks seeded
- [x] 5.2 `pnpm exec ultracite fix`, typecheck, unit tests, e2e
- [x] 5.3 Run `graphify update .`
