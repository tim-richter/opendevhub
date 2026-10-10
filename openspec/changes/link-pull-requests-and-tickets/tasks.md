## 1. Schema

- [ ] 1.1 Migration 4: the `tickets`, `pull_requests` and `reviews` tables
- [ ] 1.2 Rebuild `tasks` with `ticket_id` and `pull_request_id` and kind `review`; add `branches.pull_request_id` and `pr_role`, copy `pr_url`/`origin_url` over, then drop those columns
- [ ] 1.3 Migration tests against a seeded version-3 database

## 2. Link repository

- [ ] 2.1 Add `src/server/db/links.ts`: `ensureTicket`, `refreshTicket`, `ensurePull` (URL normalisation and owner/repo/number parsing for Forgejo/Gitea, GitHub and GitLab URLs), `refreshPull`, `linkBranch(branchId, pullId, role)`, `insertReview`, `reviewsOf`, `forPull`, `forTicket`
- [ ] 2.2 Unit tests: URL normalisation, the parsers, unknown lookups returning empty, the joins in `forPull` / `forTicket`

## 3. Write paths

- [ ] 3.1 `Tasks.beginTask` sets `ticket_id` from `req.jira`
- [ ] 3.2 `Publish.publish` links the branch to the printed PR with role `head`; `Publish.info` reads "View PR" from the link
- [ ] 3.3 `Checkouts.createWorktree` with `pull` links the new branch with role `checkout`
- [ ] 3.4 Forgejo `details` and the pulls list refresh PR snapshots; Jira list and detail refresh tickets
- [ ] 3.5 `…/ai-review/session` and quick `…/ai-review` create `review` tasks; `…/ai-review` stores a review row on success

## 4. Backfill

- [ ] 4.1 One-time backfill marked in `meta`: tickets from `tasks.jira`, PRs from branch URLs, review tasks per the title-and-checkout rule
- [ ] 4.2 Tests for each backfill rule, including the title-only case that must not convert

## 5. API

- [ ] 5.1 Add `ticket`, `pullRequests` and `reviewOf` to `TaskView`, filled when the snapshot is built
- [ ] 5.2 Add `GET /api/links/pull?url=`, `GET /api/links/ticket?instance=&key=` and `GET /api/forgejo/pulls/:owner/:repo/:number/ai-reviews`, with validation and RPC types

## 6. Web

- [ ] 6.1 Jira ticket page lists tasks and PRs from `/api/links/ticket`; remove the session scan
- [ ] 6.2 Forgejo PR page: "Made by task", checkout worktrees, earlier AI reviews (outdated marker, open findings in the diff)
- [ ] 6.3 Task page: ticket chip with status, a PR per variant, and the "Review of PR #n" header for review tasks
- [ ] 6.4 Update fixtures, mocks and stories (`jira-page.stories.tsx`, Forgejo stories)

## 7. Wrap-up

- [ ] 7.1 `pnpm exec ultracite fix`, typecheck, unit tests, e2e (`publish.e2e.ts`, `review.e2e.ts`, `tasks.e2e.ts`)
- [ ] 7.2 Run `graphify update .`
