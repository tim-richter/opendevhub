## 1. Git operations

- [x] 1.1 Add `BasePosition`, `BaseSkipReason` and the base-update outcome types to `shared/types.ts`
- [x] 1.2 Add `GitOps.baseUpstream(p, dir, base)`: `<base>@{u}`, else `<remote>/<base>` when that ref exists (remote = `origin`, else first)
- [x] 1.3 Add `GitOps.updateBase(p, ws, base, { dryRun })`: count ahead/behind, then return up-to-date / diverged / no-upstream / dirty, or fast-forward (`merge --ff-only` when checked out and clean, `fetch . <upstream>:<base>` otherwise)
- [x] 1.4 Unit-test `updateBase` against a real temporary repo for each outcome: stale and checked out, stale and not checked out, dirty, diverged, no upstream, up to date (in `test/server/git/ops.test.ts`)

## 2. Fetch freshness

- [x] 2.1 Add `lastFetch: { remote, at }` to project runtime state and set it after every successful `fetchPrune`, cleanup's included
- [x] 2.2 Add a `BaseFreshness` helper: `ensureFresh(id, remote, { force, maxAgeMs })`, which shares one in-flight fetch per project and skips fresh fetches of the same remote
- [x] 2.3 Test the throttling, forced fetch and concurrent sharing

## 3. Task start

- [x] 3.1 Add the `"base"` setup step ("Updating base") to the task setup step type and the UI's step labels
- [x] 3.2 In `server/tasks/checkout-setup.ts`, for local `where === "worktree"` jobs, fetch (forced) and run `updateBase` once before `taskBranches`, unless the setting is off (fetch only)
- [x] 3.3 Turn a skip reason or fetch failure into each slot's `notice` and an activity-log line. Never fail the task on it
- [x] 3.4 Leave remote-node jobs (`remoteKit`) and `existing` / main-checkout jobs unchanged
- [x] 3.5 Test: a two-variant task on a stale clean `main` branches both variants from the updated `main`; the dirty and offline cases start from local `main` with the notice

## 4. Setting

- [x] 4.1 Add the app-wide preference "Update the base branch before starting a task" (default on) to the stored app preferences and their API
- [x] 4.2 Add a "Tasks" block with the switch to `web/features/settings/git-settings.tsx`

## 5. Position endpoint

- [x] 5.1 Add `GET /api/projects/:id/base-position?base=&branch=&fetch=`, which calls `ensureFresh` and then `updateBase` with `dryRun`, plus `sinceBranch` when `branch` is given
- [x] 5.2 Add `POST /api/projects/:id/base-position/pull` under `withGit`, which returns the new position
- [x] 5.3 Add a `basePositionQuery` and a pull mutation in the web layer, plus mock fixtures for Storybook
- [x] 5.4 Test the route's responses for each outcome and the throttled versus forced fetch

## 6. New task dialog

- [x] 6.1 Show the base status line under Base for worktree tasks (not node, not main-checkout tasks), with the Base input debounced by 300 ms
- [x] 6.2 Write the line's text for each outcome, with "fetched <relative time>", and a loading state
- [x] 6.3 Add Storybook stories for stale, up to date, dirty, diverged, offline and setting-off, plus tests for the wording

## 7. Phase 2: Position section

- [x] 7.1 Add `upstreamAhead` (commits not yet pushed) to `ReviewData` in `server/git/review-actions.ts`
- [x] 7.2 Build the `BranchPosition` SVG component: rows for upstream, local base, branch point, HEAD and the branch's upstream, with counted edges and theme tokens, and no mount animation
- [x] 7.3 Replace the rail's Target section with Position in `web/features/tasks/task-status.tsx`, keeping container and runtime rows, and adding ⟳ fetch and Pull (disabled with the reason as a tooltip)
- [x] 7.4 Show the main-checkout variant as only upstream plus local base
- [x] 7.5 Add ↑ahead ↓behind against the base's upstream to `TaskStatusStrip`
- [x] 7.6 Add stories for behind, ahead-and-behind, pushed with unpushed commits, dirty, main checkout and a long branch name, and run the break-ui worst cases
- [x] 7.7 Update the task page tests for the rail and the strip

## 8. Wrap-up

- [x] 8.1 Run `pnpm exec ultracite fix`, typecheck and the test suite
- [x] 8.2 Run `graphify update .`
