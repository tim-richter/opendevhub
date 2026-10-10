## 1. Schema

- [ ] 1.1 Migration 3: the `projects` and `environments` tables, and placeholder project rows for project ids already in use
- [ ] 1.2 Rebuild `tasks`, `branches`, `worktrees` and `variants` with foreign keys to `projects` / `environments`, comparing row counts and aborting on mismatch
- [ ] 1.3 Migration tests against a seeded version-2 database

## 2. Repositories

- [ ] 2.1 Add `src/server/db/projects.ts`: `upsertDiscovered(list)` (clears missing), `markMissing(except)`, `get`
- [ ] 2.2 Add `src/server/db/environments.ts`: `putMain`, `putTask` (by worktree id), `updateDurable`, `markRemoved`, `listLive` (joined to worktrees/branches into `EnvRecord`), `countOnNode`
- [ ] 2.3 Unit tests, including secret columns never selected into views

## 3. StateStore and discovery

- [ ] 3.1 `StateStore.setProjects` upserts project rows and marks missing ones
- [ ] 3.2 Replace `persisted` / `save()` in `StateStore` with repository calls; keep `DURABLE_KEYS` as the rule for when to write
- [ ] 3.3 `Environments` create/destroy task environments through the repository; variants reference the environment row

## 4. state.json

- [ ] 4.1 One-time import in `cli.ts` before the store is built, marked in `meta`
- [ ] 4.2 Export `state.json` (existing format, 0600) after each environment change; test that `loadState` reads it back
- [ ] 4.3 `opendevhub nodes remove` counts environments from the database

## 5. API

- [ ] 5.1 Add `worktreeId` to `EnvironmentView`; check that `publicRuntime` still strips secrets

## 6. Wrap-up

- [ ] 6.1 `pnpm exec ultracite fix`, typecheck, unit tests, e2e (`environments.e2e.ts`, `cleanup.e2e.ts`, `add-project.e2e.ts`)
- [ ] 6.2 Manual check: upgrade with running containers, then roll back to the previous build
- [ ] 6.3 Run `graphify update .`
