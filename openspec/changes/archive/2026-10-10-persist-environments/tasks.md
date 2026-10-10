## 1. Schema

- [x] 1.1 Add the `environments` table to migration 1 and give `variants.env_id` its foreign key to `environments`
- [x] 1.2 Add the environment verbs to `EventVerb` in `src/server/db/events.ts`

## 2. Repository

- [x] 2.1 Add `src/server/db/environments.ts`: `putMain`, `putTask` (by worktree id), `updateDurable`, `markRemoved`, `listLive` (joined to worktrees/branches into `EnvRecord`), `countOnNode`, writing events in the same transaction
- [x] 2.2 Unit tests, including secret columns never selected into views and no event on a runtime update

## 3. StateStore and environments

- [x] 3.1 Replace `persisted` / `save()` in `StateStore` with repository calls; keep `DURABLE_KEYS` as the rule for when to write
- [x] 3.2 `Environments` create/destroy main and task environments through the repository; variants reference the environment row
- [x] 3.3 Delete `PersistedState`, `loadState`, `saveState` and `StoreOptions.persist` from `config.ts` and their callers and tests
- [x] 3.4 `opendevhub nodes remove` counts environments from the database

## 4. API

- [x] 4.1 Add `worktreeId` to `EnvironmentView`; check that `publicRuntime` still strips secrets

## 5. Wrap-up

- [x] 5.1 `pnpm exec ultracite fix`, typecheck, unit tests, e2e (`environments.e2e.ts`, `cleanup.e2e.ts`, `add-project.e2e.ts`)
- [x] 5.2 Manual check: restart with running main and task containers and confirm they are reattached
- [x] 5.3 Run `graphify update .`
