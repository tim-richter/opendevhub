## 1. Schema

- [x] 1.1 Add the `tickets`, `pull_requests` and `reviews` tables to migration 1
- [x] 1.2 In migration 1, add `tasks.ticket_id` / `tasks.pull_request_id` and kind `review`; replace `branches.pr_url` / `origin_url` with `pull_request_id` and `pr_role`, and update their readers from `link-branches-and-worktrees`
- [x] 1.3 Add `ticket.linked`, `pull_request.linked` and `review.run` to `EventVerb`

## 2. Link repository

- [x] 2.1 Add `src/server/db/links.ts`: `ensureTicket`, `refreshTicket`, `ensurePull` (URL normalisation and owner/repo/number parsing for Forgejo/Gitea, GitHub and GitLab URLs), `refreshPull`, `linkBranch(branchId, pullId, role)`, `insertReview`, `reviewsOf`, `forPull`, `forTicket`, writing link and review events in the same transaction
- [x] 2.2 Unit tests: URL normalisation, the parsers, unknown lookups returning empty, the joins in `forPull` / `forTicket`, events on link but not on refresh

## 3. Write paths

- [x] 3.1 `Tasks.beginTask` sets `ticket_id` from `req.jira`
- [x] 3.2 `Publish.publish` links the branch to the printed PR with role `head`; `Publish.info` reads "View PR" from the link
- [x] 3.3 `Checkouts.createWorktree` with `pull` links the new branch with role `checkout`
- [x] 3.4 Forgejo `details` and the pulls list refresh PR snapshots; Jira list and detail refresh tickets
- [x] 3.5 `…/ai-review/session` and quick `…/ai-review` create `review` tasks; `…/ai-review` stores a review row on success

## 4. API

- [x] 4.1 Add `ticket`, `pullRequests` and `reviewOf` to `TaskView`, filled when the snapshot is built
- [x] 4.2 Add `GET /api/links/pull?url=`, `GET /api/links/ticket?instance=&key=` and `GET /api/forgejo/pulls/:owner/:repo/:number/ai-reviews`, with validation and RPC types

## 5. Web

- [x] 5.1 Jira ticket page lists tasks and PRs from `/api/links/ticket`; remove the snapshot scan
- [x] 5.2 Forgejo PR page: "Made by task", checkout worktrees, earlier AI reviews (outdated marker, open findings in the diff)
- [x] 5.3 Task page: ticket chip with status, a PR per variant, and the "Review of PR #n" header for review tasks
- [x] 5.4 Update fixtures, mocks and stories (`jira-page.stories.tsx`, Forgejo stories)

## 6. Wrap-up

- [x] 6.1 `pnpm exec ultracite fix`, typecheck, unit tests, e2e (`publish.e2e.ts`, `review.e2e.ts`, `tasks.e2e.ts`)
- [x] 6.2 Run `graphify update .`
