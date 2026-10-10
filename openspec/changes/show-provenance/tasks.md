## 1. Schema and event store

- [ ] 1.1 Migration 5: the `events` table and indexes
- [ ] 1.2 Add `src/server/db/events.ts`: the `EventVerb` union, `record(tx, event)`, `page(filter, before, limit)` with labels joined in, `prune(olderThan)`
- [ ] 1.3 Unit tests: keyset paging, filters (project, task, entity), pruning in batches

## 2. Recording

- [ ] 2.1 Pass an actor (`user` / variant / `system`) from the API layer, the task setup job and reconcile into the repositories
- [ ] 2.2 Record events inside the transactions of the task, checkout, environment and link repositories; `*.adopted` for adoption and backfill
- [ ] 2.3 Tests: one event per change, none on a steady-state reconcile, none after a rolled-back change

## 3. API

- [ ] 3.1 `GET /api/activity` with `project`, `task`, `entity`, `before` and `limit`, with validation and RPC types
- [ ] 3.2 `GET /api/provenance/:type/:id` walking the foreign keys into an ordered trail plus "led to" lists, with removed flags
- [ ] 3.3 `DashboardSnapshot.activity.latestId`
- [ ] 3.4 Retention at startup (180 days), and the "reviews" category in the cleanup plan

## 4. Web: shared pieces

- [ ] 4.1 A `ProvenanceBreadcrumb` component (shadcn breadcrumb, struck-through removed steps)
- [ ] 4.2 An `ActivityFeed` component: event rendering per verb, load more, refetch on `latestId` change
- [ ] 4.3 A `CreatedByChip` component

## 5. Web: pages

- [ ] 5.1 Session page, checkout page, Forgejo PR page and Jira ticket page show the breadcrumb
- [ ] 5.2 Task page reworked as the hub: header, variant rows, reviews, spec chain, activity; existing comparison as a tab; manual tasks single-row
- [ ] 5.3 Activity page in the shell navigation; activity section on the project page
- [ ] 5.4 Created-by chips in the session, worktree/branch and environment lists
- [ ] 5.5 Stories and fixtures for the new components and pages

## 6. Wrap-up

- [ ] 6.1 Performance check: provenance walk and first feed page with 10k tasks seeded
- [ ] 6.2 `pnpm exec ultracite fix`, typecheck, unit tests, e2e
- [ ] 6.3 Run `graphify update .`
