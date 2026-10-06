# Review: diff, feedback and local git

Date: 2026-10-03
Status: Draft for review
Depends on: nothing. [Publish](2026-10-03-publish-design.md) builds on this.

## Problem

Once an agent finishes, there's nowhere in the dashboard to see what it changed, tell it what
to fix, or land the change. Review works on one **target**: a worktree or the main checkout.
It answers "what did the agent change?", sends your line comments back to the agent, and
offers local git actions: commit, update from base, merge into base.

## Verified opencode facts (2.0.22)

| Need | Endpoint | Notes |
| --- | --- | --- |
| Diff | `GET /api/vcs/diff?mode=working\|branch\|committed&base=` | `[{ file, patch, additions, deletions, status }]`. `branch` compares the merge-base with `base` against the working copy, untracked files included (checked against a live server). |
| Base and branch | `GET /api/vcs`, `GET /api/vcs/base` | `/api/vcs` → `{ branch: { current, default } }`. `/api/vcs/base` answers 503 "Choose a review base" when history is ambiguous; it did so after a plain `git checkout -b`. |
| Working copy status | `GET /api/vcs/status` | `[{ file, additions, deletions, status }]` |
| Send a prompt | `POST /api/session/:sid/prompt` | `{ text, delivery?: "steer" \| "queue" }`, asynchronous |
| Text from session context | `POST /api/session/:sid/generate` | `{ prompt }` → `{ text }`, without changing the session history |

## Recording the base

`/api/vcs/base` can't be relied on, so opendevhub records the base itself. When a worktree is
created (`createWorktree`, which the tasks feature also uses), it runs
`git config branch.<branch>.opendevhubBase <base>`. The base is the given one, or the
workspace's current branch if none was given. It lives in the repository, so it's visible from
the host and the container and survives restarts. This is a small change to `worktrees.ts`.

## Diff

`GET /api/projects/:id/review?directory=<dir>`

```ts
{
  directory: string;
  branch?: string;               // undefined on a detached HEAD
  base?: { name: string; source: "config" | "opencode" | "default" };
  ahead: number; behind: number; // `git rev-list --left-right --count base...HEAD`
  dirty: boolean;                // uncommitted changes, from /api/vcs/status
  files: { file; status; additions; deletions; patch }[];
  truncated?: boolean;
}
```

- **Base.** Resolved in this order: `branch.<b>.opendevhubBase`, then `/api/vcs/base`, then the
  default branch from `/api/vcs`. The UI can override it, and `?base=` overrides it for one
  request.
- **Which diff.** Uncommitted changes (`mode=working`) by default, or `mode=branch&base=<base>`
  when chosen; see [the diff mode design](2026-10-06-review-diff-mode-design.md).
- **Size cap.** Responses carry at most 2 MB of patches. Larger files are listed with their
  stats only; their patch loads on demand with `?file=`.
- **Safety.** Every path goes through `checkDirectory`.
- **Refresh.** When the target's sessions go idle (from the monitor), after every git action,
  and on the refresh button.

**UI.** A **Review** tab on the project page (`/p/:id/review/:target?`), plus links from
worktree and session rows.

- On the left, a file list with status and +/−. On the right, a unified diff with line numbers.
- Files over 400 changed lines start collapsed, and binary files just say "binary".
- The header shows the target, the base (with a picker) and ahead/behind counts.
- No syntax highlighting in the first version.

## Comments → agent

- **Anchoring.** Clicking a line number opens a comment box anchored to `file:line`: the
  new-side line, or the old-side line for a deleted line. A general comment box sits at the top.
- **Drafts.** Kept in `localStorage`, keyed by project, target and base, so a reload doesn't
  lose them.
- **Sending.** **Send to agent (n)** combines the comments into one prompt and posts it to the
  target's most recent session, or to one you pick, or to a new one. It uses
  `delivery: "queue"` when that session is running. The route is
  `POST /api/projects/:id/sessions/:sid/prompt`, shared with tasks; whichever ships first adds
  it. The prompt looks like:

  ```
  Review feedback on <branch> (compared with <base>). Address each point, then reply with what you changed.

  1. src/auth.ts:42
     > +  if (token == null) return next();
     This skips auth for missing tokens; it should 401.

  2. General: please add a test for the redirect.
  ```

  Each quote is the commented line plus up to 2 lines before it, taken from the patch.
- **After sending,** the comments are cleared and appended to a "sent" list for that target.

## Local git actions

All of these run in the container, under the project's git lock, on `directory` only, with the
base passed as a ref. Hooks therefore see the container's toolchain, and commits use the same
identity the agent commits with.

| Action | Enabled when | Does |
| --- | --- | --- |
| **Commit** | `dirty` | `git add -A && git commit -m <msg>`. The message is prefilled by `generate` on the target's session ("Write a conventional commit message for the uncommitted changes"). You can edit it; if `generate` fails it starts empty. |
| **Update from base** | `behind > 0` | `git rebase <base>`, or `git merge <base>` if the branch has been pushed. On a conflict it runs `--abort`, lists the conflicting files and offers **Ask agent to resolve**, which sends a prompt to rebase or merge and resolve the conflicts. The repo is never left mid-rebase. |
| **Merge into base** | `ahead > 0` and `!dirty`, with the main checkout clean and on `<base>` | `git -C <workspace> merge --no-ff <branch>`, or `--ff-only` if you choose. Afterwards it offers to remove the worktree and delete the branch. |

"Pushed" means the branch has an upstream or is recorded as published (see the publish spec).

- **Missing identity.** If the container has no `user.name`/`user.email`, the error says so,
  with a hint: set them in the devcontainer, or run `git config --global` in
  `postCreateCommand`.
- **Errors in general.** Failures surface as the existing `CommandError` (the last 5 lines of
  output), on the Review tab and in the project log.

## Not covered

Syntax highlighting, a side-by-side diff, and reviewing an existing PR from a forge.

## Delivery

1. Base recording, the diff, and comments → agent.
2. Local git actions.

## Testing

- **Unit:** base resolution order; the review prompt composer (quoting, anchoring deleted
  lines); the size cap.
- **Integration** (fake opencode and runner): the review route, `checkDirectory` rejection,
  rebase conflict → abort.
- **e2e:** commit, update from base and merge into base against a local repo in a real
  container.

## Open questions

1. Commit identity: should the container's git config win, or should opendevhub pass the host's
   `user.name`/`user.email` with `-c` on the commits it makes?
2. Should **Merge into base** also push the base branch, or leave that to you?
