## 1. Database foundation

- [x] 1.1 Add `src/server/db/database.ts`: open `stateDir()/opendevhub.db` (mode 0600) with `node:sqlite` `DatabaseSync`, set `journal_mode=WAL` and `foreign_keys=ON`, and suppress only the `node:sqlite` ExperimentalWarning
- [x] 1.2 Add `src/server/db/migrations.ts`: ordered SQL migrations applied per transaction and tracked with `PRAGMA user_version`; refuse to start when the database is newer than the code
- [x] 1.3 Migration 1: the `projects`, `tasks`, `variants` and `events` tables and indexes from design.md (later changes in the series edit this migration in place)
- [x] 1.4 Tests: fresh database, re-opening, pending migrations, newer-than-code error (in-memory and temp-file databases)

## 2. Projects and events

- [x] 2.1 Add `src/server/db/events.ts`: the `EventVerb` union (project, task, variant and session verbs) and `record(tx, event)`
- [x] 2.2 Add `src/server/db/projects.ts` `ProjectStore`: `upsertAll` (insert, update, clear and set `missing_since`, with `project.discovered` / `project.missing` events) and `get`
- [x] 2.3 Call `ProjectStore.upsertAll` from project discovery before the snapshot is built
- [x] 2.4 Tests: discovery upsert, missing and returning projects, events only on change

## 3. Task store

- [x] 3.1 Add `src/server/db/tasks.ts` `TaskStore` with typed row mappers: `createTask`, `updateVariant`, `attachSession`, `adoptSession`, `markSessionsGone`, `pick`, `setSpec`, `dismissStarting`, `archive`, `listForProject`, `bySession`, each writing its events in the same transaction with the actor passed in
- [x] 3.2 Add session-creation claims to `TaskStore` (`claim(env, directory)` returning a release function; `isClaimed`)
- [x] 3.3 Add `TaskView`/`VariantView` to `src/shared/types.ts`, with state derived as `starting`/`running`/`ended`
- [x] 3.4 On startup, mark variants still in a setup step without a session as `failed` ("interrupted: opendevhub restarted")
- [x] 3.5 Add `ProjectStore` and `TaskStore` to `HubDeps` and open them in `cli.ts`; use in-memory stores in test helpers
- [x] 3.6 Unit tests for every `TaskStore` method, including the unique session index, idempotent adoption, claims and emitted events

## 4. Tasks write through the store, TaskMeta removed

- [x] 4.1 `Tasks.beginTask` creates the task and variant rows; `runTask` records step, branch, directory, env id, session id and error via `updateVariant`, claims the directory around `createSession`, and creates sessions without `opendevhub` metadata
- [x] 4.2 Replace `StateStore.startingTasks` with reads from `TaskStore`; keep `StartingVariant.log` in memory only
- [x] 4.3 `Tasks.dismissStarting` and `pickVariant` update the store (`picked_at`/`discarded_at`) only
- [x] 4.4 `specs.ts` reads the spec chain from `TaskStore` and writes it with `setSpec` (phase, change, archived on the variant; `proposed_in`/`implemented_in` on the tasks)
- [x] 4.5 `usage.ts`, `status.ts` and `cleanup.ts` find a session's task and discard state through `TaskStore.bySession`
- [x] 4.6 Change `SessionView.task` to `{ id, kind, n, discarded }`; delete `TaskMeta`, `parseTaskMeta`, `patchTaskMetadata` and `discardMetadata`
- [x] 4.7 Update the tasks, specs, usage, status and cleanup tests and e2e (`tasks.e2e.ts`) for persisted starts, restart failure, picks and the spec chain

## 5. Manual tasks and reconcile

- [x] 5.1 `Sessions.startSession`, `Sessions.generateIn` (new session) and `Checkouts.createWorktree` (with a session) claim the directory, create the session and a manual task before `reconcile`
- [x] 5.2 In session reconcile for an environment, after a successful listing: adopt top-level sessions without a variant row in unclaimed directories as manual tasks, update manual titles, and set or clear `session_removed_at`
- [x] 5.3 Skip the removal marks when the listing failed or the environment is unreachable
- [x] 5.4 Tests: adoption, a claimed directory deferring adoption until the attach, subagents skipped, title following, removal and reappearance

## 6. API and snapshot

- [x] 6.1 Add `tasks: TaskView[]` (non-archived) to `ProjectView` in `StateStore.snapshot`, and remove `ProjectView.starting`
- [x] 6.2 Add `POST /api/projects/:id/tasks/:task/archive` to `api/projects.ts` with validation and a Hono RPC client type
- [x] 6.3 Cleanup plan offers to archive ended tasks past the idle cutoff (`git/cleanup.ts`, cleanup UI item)

## 7. Web app

- [x] 7.1 Replace `taskSessions` grouping with `view.tasks` in `features/tasks`, the overview, the session list and the shell
- [x] 7.2 Move readers of `session.task` (spec panel and `features/specs`, checkouts, Jira page, review, new-task dialog) to the new `SessionView.task` and `TaskView.spec` / `VariantView.spec`
- [x] 7.3 Render manual tasks as their single session (no variant comparison or pick), and ended tasks collapsed with an Archive action
- [x] 7.4 Show starting and failed variants from `view.tasks`
- [x] 7.5 Update mocks/fixtures and stories for the new snapshot shape

## 8. Wrap-up

- [x] 8.1 Run `pnpm exec ultracite fix`, typecheck, unit tests and e2e
- [x] 8.2 Run `graphify update .`
