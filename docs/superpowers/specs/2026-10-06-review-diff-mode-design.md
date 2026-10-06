# Review diff mode

The Review tab used to pick its diff for you: the main checkout on its base showed uncommitted
changes, everything else showed the whole branch against its base. On a feature branch in the main
checkout that hid what you had just changed. Now the diff is a choice, remembered per checkout.

## Modes

- **Uncommitted** (default): `git diff` of the checkout, untracked files included
  (`/api/vcs/diff?mode=working`).
- **Compare with `<base>`**: everything since the merge-base with the base, committed or not
  (`mode=branch&base=<base>`). The base is resolved as before: the override, the base recorded at
  worktree creation, opencode's guess, the default branch.

The base is resolved in both modes; ahead/behind, Update from base, Merge into base and Publish
need it whichever diff is shown.

## Server

`GET /api/projects/:id/review?mode=working|branch`. Missing means `working`; anything else is a
400. `branch` without a resolvable base falls back to `working`, and the response's `mode` says
which diff it holds.

## UI

- A toggle in the header: **Uncommitted** | **⇄ `<base>`**. Clicking the base while it is selected
  opens the Compare with dialog; choosing a base there switches to Compare.
- The mode is remembered per project and checkout in `localStorage`
  (`opendevhub:review-mode:<project>:<target>`), so a worktree you switched to Compare stays there.
- Uncommitted with no changes, on a branch ahead of its base, shows a hint:
  "No uncommitted changes. `<branch>` is N commits ahead of `<base>`." with a **Compare with
  `<base>`** button.
- Comment drafts are kept per mode: the key ends in the base for Compare and is empty for
  Uncommitted. The prompt says "uncommitted changes on `<branch>`" in Uncommitted mode.
