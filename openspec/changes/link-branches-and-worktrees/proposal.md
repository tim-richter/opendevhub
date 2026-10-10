## Why

A worktree is removed once its work is merged, but its branch, and the pull request on that branch, live on. Today opendevhub remembers a branch's base, origin, published remote, AGit topic and pull request in `branch.<b>.opendevhub*` git config keys. Those keys are keyed by branch **name**, only readable from inside the container, and invisible to the hub's database. Nothing records which task variant created which branch or worktree. Depends on `persist-tasks`. Like the rest of the series, it replaces the old storage outright: no backfill and no rollback path.

## What Changes

- Add `branches` and `worktrees` tables. A **branch** is a project's named branch that opendevhub made, published, checked out for a pull request, or found in a worktree. A **worktree** is one checkout of a branch at a path, on this machine or a node, with `created_at` / `removed_at`.
- Point variants at their branch and worktree (`variants.branch_id`, `variants.worktree_id`). The `branch` / `directory` text columns are kept for display.
- Record who created a branch or worktree: a task variant, a manual action (the checkouts page or a pull request checkout), or **unmanaged** (found in `git worktree list` without opendevhub having made it).
- Move `opendevhubOrigin`, `opendevhubPr`, `opendevhubPublished` and `opendevhubTopic` into the `branches` row. The database is the only source of truth for them, and the keys are neither written nor read.
- **Keep `opendevhubBase` in git config.** The OpenSpec base check in the container and the remote-node repo setup read it there. The branch row mirrors it.
- Reconcile on every worktree listing: adopt unknown worktrees as unmanaged, mark missing ones `removed_at`, and follow a worktree whose checkout switched to another branch.
- Record events for branches and worktrees: created, adopted, switched, published, removed and deleted.
- Add `worktrees[].createdBy` (task / manual / unmanaged) and `branchId` to the snapshot. Branch rows (with base, published, PR URL) come through a new `GET /api/projects/:id/branches`.
- Picking a variant uses the branch row's `created_by_variant` instead of comparing the variant's branch name, to decide whether a branch is the task's to delete.

## Capabilities

### New Capabilities

- `branch-tracking`: branch rows, what they store, who created them, their events, and the base key that stays in git.
- `worktree-tracking`: worktree rows, their lifecycle, reconcile and events, links from variants, unmanaged worktrees, and the snapshot/API exposure.

### Modified Capabilities

<!-- None in openspec/specs/. Builds on task-persistence (persist-tasks) by adding tables and variant columns to migration 1; its requirements are unchanged. -->

## Impact

- **Server**: `branches` and `worktrees` added to migration 1 in `src/server/db/migrations.ts`; new branch and worktree verbs in `src/server/db/events.ts`; new `src/server/db/checkouts.ts` repository; `git/worktrees.ts` (`add`, `list`, `origins`, `recordBase`), `git/checkouts.ts`, `git/publish.ts` and `git/ops.ts` (published/PR/topic read from the DB), `tasks/tasks.ts` (`runTask`, `pickVariant`), `nodes/repo.ts` (remote worktrees recorded).
- **API**: `Worktree` gains `branchId?` and `createdBy?`. `PublishInfo.pr` now comes from the DB. Adds `GET /api/projects/:id/branches`.
- **Web**: the checkouts list shows the creator ("Task _Add login_ · variant 2", "Pull request #12", "Created outside opendevhub").
- **Data**: the git config keys other than `opendevhubBase` are no longer written or read. Keys left over in existing checkouts are ignored.
