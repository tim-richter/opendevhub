## Why

Environments (a project's main container and the containers of isolated worktrees) are stored in `state.json`, separately from the tasks, branches and worktrees that are now in the database. An environment references its worktree by **path** and its project by an id with nothing in the database behind it. The tables can't be joined, and the "which container runs this variant" question needs path matching. Projects have no row at all because they're rediscovered from the filesystem on each start, so nothing can reference a project with a foreign key. Depends on `link-branches-and-worktrees`.

## What Changes

- Add a `projects` table: one row per discovered project (id, path, name, devcontainer path, first seen, missing since). Discovery upserts rows. A project that's no longer found is marked missing, not deleted, so its tasks and history survive.
- Add an `environments` table for the main environment and task environments. It holds what `state.json` keeps today: container id, workspace folder, remote user, image key/ref, node, plus the secrets (container password, relay token). A task environment points at its **worktree row** instead of storing a path.
- Point variants at their environment by foreign key (`variants.env_id` references `environments`).
- Add foreign keys from `tasks`, `branches` and `worktrees` to `projects`. The migration adds a project row for every `project_id` already in use.
- Import `state.json` into the database once at startup. The file is then kept as a one-way **export** for one minor release, so a rollback still finds its containers, and dropped after that.
- `opendevhub nodes remove` counts a node's environments from the database.
- **BREAKING (internal)**: `PersistedState`, `loadState`/`saveState` and `StoreOptions.persist` are replaced by the environment repository. The `state.json` export format is unchanged.

## Capabilities

### New Capabilities

- `project-registry`: project rows, upserted by discovery, marked missing instead of deleted, and the anchor for foreign keys.
- `environment-persistence`: environment rows (main and task), their link to worktrees and variants, secret handling, the `state.json` import and export, and the nodes CLI check.

### Modified Capabilities

<!-- None in openspec/specs/. -->

## Impact

- **Server**: migration 3; new `src/server/db/environments.ts` and `src/server/db/projects.ts`; `projects/state.ts` (`StateStore` loses `persisted`/`save` and reads envs from the repository); `projects/discovery.ts` (upsert/mark missing); `environments/environments.ts` (create/destroy envs); `config.ts` (`loadState`/`saveState` become import/export); `cli.ts` (wiring, `nodes remove`).
- **API**: no shape changes. `EnvironmentView` gains `worktreeId`.
- **Data**: `state.json` is imported once and then written as an export only. Secrets move from a 0600 JSON file into the 0600 database.
