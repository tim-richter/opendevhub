## 1. Schema

- [ ] 1.1 Add the `branches` and `worktrees` tables and `variants.branch_id` / `variants.worktree_id` to migration 1, with foreign keys to `projects`
- [ ] 1.2 Add the branch and worktree verbs to `EventVerb` in `src/server/db/events.ts`

## 2. Checkout repository

- [ ] 2.1 Add `src/server/db/checkouts.ts`: `ensureBranch` (insert-or-keep creator), `updateBranch`, `branchesOf`, `insertWorktree`, `reconcileWorktrees(projectId, listing)`, `linkVariant`, each writing its events in the same transaction
- [ ] 2.2 Unit tests: creator kept on conflict, path reuse gives a new row, branch switch, unmanaged adoption, failed listing is a no-op, events emitted only on change

## 3. Write paths

- [ ] 3.1 `Tasks.runTask` and the remote-node path record branch and worktree rows after `git worktree add` and link the variant
- [ ] 3.2 `Checkouts.createWorktree` records creator `manual`, or `pull` with the origin URL; remove the `opendevhubOrigin` write
- [ ] 3.3 `Publish.publish` writes the published remote, publish time, topic and PR URL to the branch row; remove the git config writes; `Publish.info` and `GitOps` read from the DB only
- [ ] 3.4 `Worktrees.recordBase` and `nodes/repo.ts` still write `opendevhubBase` and mirror it to the branch row
- [ ] 3.5 `Checkouts.removeWorktree` and branch deletion set `removed_at` / `deleted_at`

## 4. Reconcile

- [ ] 4.1 Call `reconcileWorktrees` after every successful listing (`refreshWorktrees`, env monitor, remote environments)
- [ ] 4.2 Replace `Worktrees.origins` / `Worktree.origin` with the branch row's `origin_url`

## 5. Pick

- [ ] 5.1 `pickVariant` decides branch ownership from the branch row's creator instead of comparing the variant's branch name
- [ ] 5.2 Update the pick tests and `tasks.e2e.ts`

## 6. API and web

- [ ] 6.1 Add `branchId` and `createdBy` to `Worktree` in `shared/types.ts` and the snapshot
- [ ] 6.2 Add `GET /api/projects/:id/branches` with an RPC client type
- [ ] 6.3 The checkouts list shows the creator, linking to the task, the PR, or "Created outside opendevhub"
- [ ] 6.4 Update fixtures and stories

## 7. Wrap-up

- [ ] 7.1 `pnpm exec ultracite fix`, typecheck, unit tests, e2e (`publish.e2e.ts`, `review.e2e.ts`, `cleanup.e2e.ts`)
- [ ] 7.2 Run `graphify update .`
