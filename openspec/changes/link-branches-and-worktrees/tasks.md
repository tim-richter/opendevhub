## 1. Schema

- [ ] 1.1 Migration 2: the `branches` and `worktrees` tables, `variants.branch_id` / `variants.worktree_id`, and a `meta` table for per-project backfill marks
- [ ] 1.2 Migration tests: upgrading a version-1 database keeps tasks and variants intact

## 2. Checkout repository

- [ ] 2.1 Add `src/server/db/checkouts.ts`: `ensureBranch` (insert-or-keep creator), `updateBranch`, `branchesOf`, `insertWorktree`, `reconcileWorktrees(projectId, listing)`, `linkVariant`
- [ ] 2.2 Unit tests: creator kept on conflict, path reuse gives a new row, branch switch, unmanaged adoption, variant linking by directory, failed listing is a no-op

## 3. Write paths

- [ ] 3.1 `Tasks.runTask` and the remote-node path record branch and worktree rows after `git worktree add` and link the variant
- [ ] 3.2 `Checkouts.createWorktree` records creator `manual`, or `pull` with the origin URL; stop writing `opendevhubOrigin`
- [ ] 3.3 `Publish.publish` writes the published remote, publish time, topic and PR URL to the branch row; stop writing the git config keys; `Publish.info` and `GitOps` read from the DB
- [ ] 3.4 `Worktrees.recordBase` and `nodes/repo.ts` still write `opendevhubBase` and mirror it to the branch row
- [ ] 3.5 `Checkouts.removeWorktree` and branch deletion set `removed_at` / `deleted_at`

## 4. Reconcile and backfill

- [ ] 4.1 Call `reconcileWorktrees` after every successful listing (`refreshWorktrees`, env monitor, remote environments)
- [ ] 4.2 Run the one-time git config backfill per project (one `--get-regexp` call) and record it in `meta`
- [ ] 4.3 Replace `Worktrees.origins` / `Worktree.origin` with the branch row's `origin_url`

## 5. Pick

- [ ] 5.1 `pickVariant` decides branch ownership from the branch row's creator instead of `TaskMeta.branch`
- [ ] 5.2 Update the pick tests and `tasks.e2e.ts`

## 6. API and web

- [ ] 6.1 Add `branchId` and `createdBy` to `Worktree` in `shared/types.ts` and the snapshot
- [ ] 6.2 Add `GET /api/projects/:id/branches` with an RPC client type
- [ ] 6.3 The checkouts list shows the creator, linking to the task, the PR, or "Created outside opendevhub"
- [ ] 6.4 Update fixtures and stories

## 7. Wrap-up

- [ ] 7.1 `pnpm exec ultracite fix`, typecheck, unit tests, e2e (`publish.e2e.ts`, `review.e2e.ts`, `cleanup.e2e.ts`)
- [ ] 7.2 Run `graphify update .`
