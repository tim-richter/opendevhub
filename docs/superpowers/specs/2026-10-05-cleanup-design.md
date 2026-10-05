# Cleanup: merged branches, stale containers and images in one place

Date: 2026-10-05
Status: Draft for review
Backlog item: "Cleanup" (Medium).

## Problem

opendevhub makes things it never collects. Tasks and worktrees leave branches behind after they're
merged, each with a worktree folder and maybe a task container. Every change to a project's
devcontainer config builds a new `opendevhub/<project>:<key>-base` image and keeps the old one.
`adopt()` finds task containers it has no record of and only logs `ignoring container …`;
containers of projects removed from the config are skipped silently. Over weeks this fills the
disk and the branch list, and the only way out is git and docker by hand, project by project.

The goal is one page: "what can go, and why?", then remove what you check.

## Scope

In:

- Local branches that are merged into their base, or whose upstream is gone, in every project with
  a running main container — with their worktrees and the worktrees' task containers.
- Orphan task containers, containers of removed projects.
- opendevhub base images no environment uses, and labelled UID images no container uses.
- A `/cleanup` page that scans on demand, lists candidates with reasons, and removes the selected
  ones after a confirmation.

Out: automatic or scheduled cleanup, remote branches, stopped main containers of current projects
(that's Stop, or the idle auto-stop backlog item), Docker build cache, dangling layers and volumes
(`docker system prune` covers those), and a CLI command.

### Success criteria

- A task branch merged into main shows up as "merged into main", checked; cleaning it up deletes
  the branch, its worktree folder and its container.
- A branch squash-merged on the forge (remote branch deleted) shows up as "upstream gone",
  unchecked.
- An unmerged branch with a live upstream is not listed. Neither is the base branch, nor the
  main checkout's current branch.
- A worktree with uncommitted changes is listed unchecked with a warning, and only removed with
  `--force` when the user checked it anyway.
- Superseded base images, orphan task containers and containers of removed projects are listed
  with their reason (and images with their size), and removed when selected.
- Nothing changes until the user confirms; anything that changed since the scan is skipped.

## Approach

A new server module `server/cleanup.ts` with `scan(): Promise<CleanupPlan>` and
`apply(items): Promise<CleanupResult>`, two endpoints, and a top-level page. The scan runs only
when the page asks; it never enters the snapshot. Branch and worktree removal goes through the
orchestrator's existing `removeWorktree`, which already tears down the task container first under
the project's git lock.

Alternatives considered: a cleanup section on each project page plus a global Docker section
(splits the "one place" into many, less shared code); a CLI subcommand (cheap, but not the
dashboard; it could sit on top of this module later).

## Scan

For each project whose main container is running (git runs inside it):

1. `git fetch --prune` on the remote (`origin` when it exists, else the first), timeout 60 s.
   On failure the project gets `warning: "using local refs: <reason>"` and the scan continues.
2. `git for-each-ref refs/heads --format=%(refname:short)%00%(upstream)%00%(upstream:track)` and
   `git worktree list --porcelain`.
3. For each branch, skip it if it is the main checkout's current branch or the base branch. Its
   base is the recorded `branch.<b>.opendevhubBase`, else the remote's HEAD branch
   (`refs/remotes/<remote>/HEAD`), else the main checkout's current branch. Then:
   - **merged** — `git merge-base --is-ancestor <branch> <base>` succeeds. Checked.
   - **upstream gone** — it has an upstream and the track is `[gone]`. Unchecked: "gone" can also
     mean the remote branch was deleted without being merged.
   - otherwise not listed.
4. A listed branch with a linked worktree runs `git status --porcelain` in it; changes set
   `dirty: true` and force the item unchecked. The worktree's task environment, if any, is
   attached as `env`.

A project whose main container isn't running is listed as `skipped: "not running"` (the page
offers Start). Its containers and images are still scanned.

One Docker pass for all projects, from `containers.listManaged()`, `docker image ls` and the
store's environment records:

- **orphan-env** — a container with `opendevhub.env` whose environment has no record.
- **removed-project** (container) — a container with `opendevhub.project` for a project not in
  the store.
- **superseded** — an `opendevhub/<project>:*-base` image of a current project that no environment
  record (`EnvRecord.image.ref`) and no container uses.
- **removed-project** (image) — any `opendevhub/<project>:*` image of a project not in the store,
  not used by a container.
- **uid** — an image with the label `opendevhub.base-project` that is not a base image itself
  (a `vsc-…-uid` image the devcontainer CLI built on top of a base) and that no container uses.

Running containers are unchecked; every other Docker item is checked.

### Labelling base images

`Images` passes `--label opendevhub.base-project=<projectId>` to `devcontainer build` (supported by
the CLI). Labels are inherited, so the UID image `devcontainer up` builds on top of a base carries
it too, which is how the **uid** kind is recognised. Images built before this change have no label
and are never offered; base images are recognised by their `opendevhub/` name either way.

### Plan

```ts
interface CleanupPlan {
  scannedAt: number;
  projects: { id: ProjectId; name: string; warning?: string; skipped?: "not running" }[];
  /** Set when Docker could not be listed; containers and images are then empty. */
  dockerError?: string;
  items: CleanupItem[];
}

type CleanupItem = { id: string; checked: boolean; reason: string } & (
  | { kind: "branch"; projectId: ProjectId; branch: string; base: string; why: "merged" | "upstream-gone";
      worktree?: string; dirty?: boolean; env?: EnvId }
  | { kind: "container"; containerId: string; name?: string; running: boolean; why: "orphan-env" | "removed-project" }
  | { kind: "image"; ref: string; bytes: number; why: "superseded" | "removed-project" | "uid" }
);
```

`id` is stable for the same thing across scans (`branch:<project>:<name>`, `container:<id>`,
`image:<ref>`). `reason` is the human sentence the page shows ("merged into main",
"no environment record", "superseded by a newer config").

## Apply

`POST /api/cleanup` with `{ items: CleanupItem[] }`: the selected items as the scan returned
them. One apply at a time; a second gets 409.

Every item is re-checked just before it is acted on, so a stale page can't delete something that
changed:

- **branch** — still merged into its base (for `merged`) or upstream still gone (for
  `upstream-gone`); a worktree that was clean at scan time must still be clean. Otherwise
  "skipped: changed since scan".
- **container / image** — still unreferenced by any record or container. Otherwise
  "skipped: in use".

Order:

1. **Branches**, per project, under the project's git lock. With a worktree:
   `removeWorktree(id, path, force = dirty, deleteBranch = false)` — it removes the task container
   first and keeps the worktree if the container won't go. Then `git branch -d` for `merged`,
   `git branch -D` for `upstream-gone` (`-d` refuses a squash-merged branch, and the user chose
   it explicitly).
2. **Containers** — `containers.remove` (`docker rm -f`).
3. **Images**, last, so images freed in step 2 can go — `containers.removeImage`. An image still
   in use is "skipped: in use", not a failure.

Result:

```ts
interface CleanupResult {
  results: { id: string; outcome: "removed" | "skipped" | "failed"; message?: string }[];
  freedBytes: number;
}
```

One item failing never stops the rest. A `BusyError` from a project lock makes that item
"skipped: project busy". Each action is logged to its project's log
(`cleanup: deleted branch x (merged into main)`); Docker items without a current project are
logged nowhere but the result.

## API

- `GET /api/cleanup` → `CleanupPlan` (runs a scan).
- `POST /api/cleanup` → `CleanupResult`; 409 while another apply runs; 400 for a malformed body.

Both use the existing `json()` helper in `dashboard-api.ts`.

## UI

A `/cleanup` page with a sidebar entry under Usage, built with Tailwind and shadcn components.

- **Header**: Scan button, "scanned 2 min ago", a live summary of the selection
  ("4 branches, 2 containers, 3 images · 3.1 GB"), and **Clean up selected**.
- **Branches & worktrees** card, grouped by project. Rows: checkbox, branch, badges
  `merged into main` / `upstream gone`, `worktree`, `own container`, and a warning-styled
  `uncommitted changes`. A group shows its fetch warning, or "not running" with a Start button.
- **Containers** card: name, reason, a `running` badge.
- **Images** card: ref, reason, size. A `dockerError` shows in place of both Docker cards.
- Each card has a select-all; select-all leaves risky rows (dirty, upstream gone, running)
  unchecked.
- **Confirm** in a shadcn Dialog: the counts, and each risky item by name ("discards uncommitted
  changes in feature-x").
- After an apply, each row shows its outcome inline (removed / skipped: reason / failed: message)
  with the bytes freed, then the page scans again.
- Empty state: "Nothing to clean up."

## Testing

- `test/server/cleanup.test.ts`, pure functions: parsing `for-each-ref` output with track info;
  the branch verdict (merged, gone, protected base or current branch, dirty → unchecked); picking
  stale containers and images from inspect data, image lists and environment records.
- Same file with a fake runner and store: `scan` per-project isolation and fetch-failure warning;
  `apply` re-validation, ordering (branches, containers, images), `-d` vs `-D`, and one failing
  item not stopping the rest.
- `test/server/images.test.ts`: the base build passes `--label opendevhub.base-project=<id>`.
- `test/server/dashboard-api.test.ts`: the two endpoints, 409 on a concurrent apply.
- `test/e2e/cleanup.e2e.ts` on the fixture repo: a task branch merged into main is cleaned up with
  its worktree and container; an unmerged branch is not listed; a superseded base image is
  removed.
