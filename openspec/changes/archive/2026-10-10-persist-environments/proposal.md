## Why

Environments (a project's main container and the containers of isolated worktrees) are stored in `state.json`, separately from the projects, tasks, branches and worktrees that are now in the database. An environment references its worktree by **path**. The tables can't be joined, and the "which container runs this variant" question needs path matching. Depends on `link-branches-and-worktrees`. Like the rest of the series, it replaces the old storage outright: no import and no rollback path.

## What Changes

- Add an `environments` table for the main environment and task environments. It holds what `state.json` keeps today: container id, workspace folder, remote user, image key/ref, node, plus the secrets (container password, relay token). A task environment points at its **worktree row** instead of storing a path, and every environment references its project row.
- Point variants at their environment by foreign key (`variants.env_id` references `environments`).
- Record events when environments are created and removed.
- `opendevhub nodes remove` counts a node's environments from the database.
- **BREAKING (internal)**: remove `state.json`. `PersistedState`, `loadState`/`saveState` and `StoreOptions.persist` are replaced by the environment repository. An existing `state.json` is ignored.

## Capabilities

### New Capabilities

- `environment-persistence`: environment rows (main and task), their link to projects, worktrees and variants, secret handling, their events, and the nodes CLI check.

### Modified Capabilities

<!-- None in openspec/specs/. Project rows come from task-persistence (persist-tasks). -->

## Impact

- **Server**: the `environments` table added to migration 1; new `src/server/db/environments.ts`; environment verbs in `src/server/db/events.ts`; `projects/state.ts` (`StateStore` loses `persisted`/`save` and reads envs from the repository); `environments/environments.ts` (create/destroy envs); `config.ts` (`loadState`/`saveState` and `PersistedState` deleted); `cli.ts` (wiring, `nodes remove`).
- **API**: no shape changes. `EnvironmentView` gains `worktreeId`.
- **Data**: `state.json` is no longer read or written. Secrets move from a 0600 JSON file into the 0600 database. Containers recorded only in an old `state.json` are no longer tracked and have to be removed by hand.
