## Context

Task worktrees are created in `server/tasks/checkout-setup.ts`, inside `envs.withGitWhenFree`. For `job.where === "worktree"`, each variant gets `worktrees.add(p, { base: job.base, … })`. With no base, `worktrees.add` branches from the main checkout's HEAD and `recordBase` writes the main checkout's current branch to `branch.<b>.opendevhubBase` (`server/git/worktrees.ts:309`). Nothing fetches on this path. The only fetch in the app is cleanup's `fetchPrune` (`server/git/cleanup.ts:237`).

Everything downstream reads the recorded base by its local name:

- the Review diff
- `aheadBehind` (`server/git/review-actions.ts:106`)
- the merge-into-base blocker, which compares the main checkout's branch with the base name (`web/features/review/project-review.tsx:484`)
- the specs shell script (`server/specs/specs.ts:60`)

So a stale local base produces a stale task, and none of these places can notice.

Remote-node tasks take their own path (`prepareRemote` / `remoteKit.repo.addWorktree`) and are out of scope.

## Goals / Non-Goals

**Goals:**

- Every new local worktree task starts from the latest base when that can be done without touching the user's work.
- When it can't, the task still starts and the user is told why: in the dialog beforehand, and in the variant's notice and the activity log afterwards.
- The task page shows where the branch stands relative to the base's upstream (phase 2).

**Non-Goals:**

- Rebasing or merging the task branch onto a newer base. The Review page's existing Update action stays the way to do that.
- Remote-node tasks.
- A full scrolling commit graph.
- Background polling fetches.

## Decisions

### Fast-forward the local base instead of branching from the remote ref

There were three options:

- **Branch from `origin/main` and record base `main`.** The Review diff against stale `main` would then show upstream's commits as the task's own.
- **Record `origin/main` as the base.** This breaks the merge blocker's name comparison, and every reader would need to handle remote refs.
- **Fast-forward local `main` to its upstream, then branch exactly as today (chosen).** The base keeps its meaning, so nothing downstream changes, and "behind" on the Review page becomes accurate.

The cost is that opendevhub now moves the user's local base branch, and possibly their main checkout's files. That's acceptable because it only ever fast-forwards, and only does so when the main checkout is clean.

### How the safe fast-forward runs

The new `GitOps.updateBase(p, ws, base)` returns `{ updated: n } | { skipped: reason }`:

1. Resolve the upstream: `git rev-parse --abbrev-ref <base>@{u}`. Without one, fall back to `<remote>/<base>` if `git show-ref --verify refs/remotes/<remote>/<base>` finds it, using the remote rule from `cleanup.ts:184` (`origin`, else the first remote). Neither found → `no-upstream`.
2. Count the commits: `rev-list --left-right --count <base>...<upstream>`. Local-only commits > 0 → `diverged`. Behind 0 → `up-to-date`.
3. If the main checkout's current branch is `<base>`: when `isClean` is false → `dirty`; otherwise `git merge --ff-only <upstream>` in the workspace.
4. Otherwise: `git fetch . <upstream>:<base>`. A local fetch into a branch that isn't checked out only fast-forwards, and git refuses non-fast-forwards on its own, so this is a safety net on top of step 2.

Alternatives considered: `git pull --ff-only` fetches again and depends on the branch being checked out. `update-ref` skips git's fast-forward check.

### Where it hooks in

In `checkout-setup.ts`, inside the existing `if (job.where === "worktree")` block, on the local path (no `remoteKit`), before `taskBranches`. It runs once per task. All slots get a new setup step, `"base"` ("Updating base"), next to the existing `"pushing"` and `"worktree"` steps. A skip reason or fetch failure becomes the slot's `notice`, through the same field `remote.notice` uses, plus an activity-log line. The fetch uses the existing `fetchPrune` with its 60 s timeout. A thrown error is caught and becomes the `fetch-failed` reason.

Running inside `withGitWhenFree` serialises the update with other git work on the project, so concurrent task starts can't race on the base ref.

### Fetch freshness and sharing

Each project's runtime state (`store.runtime(id)`) gets `lastFetch?: { remote: string; at: number }`, set after each successful `fetchPrune`. That includes cleanup's fetch, which then counts towards freshness. A per-project in-flight promise map in a small `BaseFreshness` helper shares concurrent fetches. The threshold is a 5-minute constant. Task start always fetches, so it never starts from refs that are up to 5 minutes old. Only the read endpoint is throttled.

We use our own timestamp rather than `FETCH_HEAD`'s mtime: it survives across containers and doesn't depend on which checkout fetched.

### Position endpoint

`GET /api/projects/:id/base-position?base=<name>&fetch=1` returns a `BasePosition` (in `shared/types.ts`):

```ts
interface BasePosition {
  base: string;
  remote?: string;
  upstream?: string;
  ahead: number; // local base commits not on upstream
  behind: number; // upstream commits not on local base
  /** What starting a task (or Pull) would do. */
  update:
    | { kind: "ff"; commits: number }
    | { kind: "up-to-date" }
    | { kind: "skip"; reason: BaseSkipReason };
  lastFetchAt?: number;
}
type BaseSkipReason =
  | "dirty"
  | "diverged"
  | "no-upstream"
  | "fetch-failed"
  | "disabled";
```

It reuses `updateBase`'s resolution logic in a dry-run mode, so the dialog's prediction and the actual start can't disagree. The web side wraps it in a TanStack Query (`basePositionQuery`) with `staleTime` of about 30 s. The dialog debounces Base input (300 ms) before changing the query key.

`POST /api/projects/:id/base-position/pull` runs `updateBase` under `withGit` for the rail's Pull action, and returns the new `BasePosition`.

### Setting

This is an app-wide preference, "Update the base branch before starting a task" (default `true`). It sits in the Git settings page as a switch under a new "Tasks" block, stored with the existing app preferences. When it's off, `updateBase` is skipped (`disabled`) but the fetch still runs, so the dialog's counts stay true.

### Phase 2: Position section

The rail section is hand-drawn inline SVG plus HTML labels, with at most two lanes (base line, branch line). Runs of commits are one edge labelled with a count. No graph library: the topology is fixed (upstream → local base → merge-base → HEAD → branch upstream), so a layout algorithm would add weight without adding value. Colours come from the existing theme tokens.

Data:

- the variant's `ReviewData` (already loaded: ahead/behind against the base, dirty, pushed)
- `BasePosition` for the base (upstream gap)
- one new field on `ReviewData`, `upstreamAhead` (commits to push), from `rev-list --count @{u}..HEAD` when pushed

The commits the upstream gained since branching come from `rev-list --count <merge-base>..<upstream>`. That's added to `BasePosition` as `sinceBranch` when a `branch` query parameter is given.

The section doesn't animate on mount. The skill guidance is that UI seen tens of times a day shouldn't animate, so count changes only transition colour and opacity (150 ms). The strip adds ↑/↓ against the upstream, using the same icons as the Review toolbar.

## Risks / Trade-offs

- [Moving files in the user's main checkout while their editor is open] → Only a fast-forward, only when clean. The variant notice and activity log say it happened. The setting turns it off.
- [Fetch is slow or prompts for credentials, delaying task start] → `fetchPrune` already has a 60 s timeout and runs with the container's ssh-agent forwarding. A timeout falls back to the local base with a notice. The dialog's throttled pre-fetch usually makes the start-time fetch quick.
- [The dialog's prediction drifts from what happens at start (someone pushes between them)] → Start always re-fetches and re-evaluates. The dialog line is advisory and says "fetched <time> ago".
- [Base typed as a remote ref (`origin/main`) or a tag] → `<base>@{u}` doesn't resolve and `<remote>/<base>` won't exist, so the result is `no-upstream`, the base is left alone and the task branches from it as today.
- [Detached main checkout with an empty Base] → There is no base to update. Same as today, no status line.
- [Cleanup's fetch counting towards freshness while fetching a different remote] → `lastFetch` records the remote, and freshness only counts a fetch of the same remote.

## Migration Plan

No data migration. `lastFetch` is runtime-only and starts empty, so the first read fetches. The setting defaults to on. Rollback is reverting the change: tasks then branch from the local base again.

## Open Questions

- Should the Review page's ↓behind also be shown against the upstream (not just the local base) once phase 2 lands? This is left out for now so the Review page keeps its meaning.
