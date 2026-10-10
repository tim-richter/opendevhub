## 1. Database foundation

- [ ] 1.1 Add `src/server/db/database.ts`: open `stateDir()/opendevhub.db` (mode 0600) with `node:sqlite` `DatabaseSync`, set `journal_mode=WAL` and `foreign_keys=ON`, and suppress only the `node:sqlite` ExperimentalWarning
- [ ] 1.2 Add `src/server/db/migrations.ts`: ordered SQL migrations applied per transaction and tracked with `PRAGMA user_version`; refuse to start when the database is newer than the code
- [ ] 1.3 Migration 1: the `tasks` and `variants` tables and indexes from design.md
- [ ] 1.4 Tests: fresh database, re-opening, pending migrations, newer-than-code error (in-memory and temp-file databases)

## 2. Task store

- [ ] 2.1 Add `src/server/db/tasks.ts` `TaskStore` with typed row mappers: `createTask`, `updateVariant`, `attachSession`, `adoptSession`, `markSessionsGone`, `pick`, `dismissStarting`, `archive`, `listForProject`
- [ ] 2.2 Add `TaskView`/`VariantView` to `src/shared/types.ts`, with state derived as `starting`/`running`/`ended`
- [ ] 2.3 On startup, mark variants still in a setup step without a session as `failed` ("interrupted: opendevhub restarted")
- [ ] 2.4 Add `TaskStore` to `HubDeps` and open it in `cli.ts`; use an in-memory store in test helpers
- [ ] 2.5 Unit tests for every `TaskStore` method, including the unique session index and idempotent adoption

## 3. Tasks write through the store

- [ ] 3.1 `Tasks.beginTask` creates the task and variant rows; `runTask` records step, branch, directory, env id, session id and error via `updateVariant` (TaskMeta writes unchanged)
- [ ] 3.2 Replace `StateStore.startingTasks` with reads from `TaskStore`; keep `StartingVariant.log` in memory only
- [ ] 3.3 `Tasks.dismissStarting` and `pickVariant` update the store (`picked_at`/`discarded_at`) alongside the metadata
- [ ] 3.4 Update the tasks tests and e2e (`tasks.e2e.ts`) for persisted starts, restart failure and picks

## 4. Manual tasks and reconcile

- [ ] 4.1 `Sessions.startSession`, `Sessions.generateIn` (new session) and `Checkouts.createWorktree` (with a session) create a manual task before `reconcile`
- [ ] 4.2 In session reconcile for an environment, after a successful listing: attach sessions with `TaskMeta` (backfilling task and variant), adopt other top-level sessions as manual tasks, update manual titles, copy `discarded` from metadata, and set or clear `session_removed_at`
- [ ] 4.3 Skip the removal marks when the listing failed or the environment is unreachable
- [ ] 4.4 Tests: adoption, the TaskMeta-before-attach race, subagents skipped, title following, backfill of a multi-variant task, offline environment backfilled later

## 5. API and snapshot

- [ ] 5.1 Add `tasks: TaskView[]` (non-archived) to `ProjectView` in `StateStore.snapshot`; derive `starting` from it for now
- [ ] 5.2 Add `POST /api/projects/:id/tasks/:task/archive` to `api/projects.ts` with validation and a Hono RPC client type
- [ ] 5.3 Cleanup plan offers to archive ended tasks past the idle cutoff (`git/cleanup.ts`, cleanup UI item)

## 6. Web app

- [ ] 6.1 Replace `taskSessions` grouping with `view.tasks` in `features/tasks`, the overview, the session list and the shell
- [ ] 6.2 Render manual tasks as their single session (no variant comparison or pick), and ended tasks collapsed with an Archive action
- [ ] 6.3 Show starting and failed variants from `view.tasks`, then remove `ProjectView.starting` and its consumers
- [ ] 6.4 Update mocks/fixtures and stories for the new snapshot shape

## 7. Wrap-up

- [ ] 7.1 Run `pnpm exec ultracite fix`, typecheck, unit tests and e2e
- [ ] 7.2 Check the rollback path by hand: an older build still runs against the same opencode sessions
- [ ] 7.3 Run `graphify update .`
