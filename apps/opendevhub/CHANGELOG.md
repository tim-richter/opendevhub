# opendevhub

## 0.3.0

### Minor Changes

- [#16](https://github.com/tim-richter/opendevhub/pull/16) [`0acd4d7`](https://github.com/tim-richter/opendevhub/commit/0acd4d7a996a7f6e3d33289aec724a10757d2614) Thanks [@tim-richter](https://github.com/tim-richter)! - Dashboard design pass: neutral theme with Geist, a task-first sidebar, a side-by-side comparison for task variants, links between pull requests, checkouts and tickets, a flat Settings page, relative timestamps everywhere, folded question forms, and a phone-friendly Review tab.

### Patch Changes

- [`85e96f2`](https://github.com/tim-richter/opendevhub/commit/85e96f277d0eaf9b41f138771c22369c677d467d) Thanks [@tim-richter](https://github.com/tim-richter)! - Filter the Forgejo inbox by organization and team. Add "Rebuild without cache" to container menus, which rebuilds the image without Docker's layer cache. Fix reading a container's environment through the devcontainer CLI, which mangled `env -0`. Remove the Review link from session rows.

- [`ebed09e`](https://github.com/tim-richter/opendevhub/commit/ebed09e241da10b5e52f3425ebdfab52d7619441) Thanks [@tim-richter](https://github.com/tim-richter)! - Warn when the forwarded ssh-agent holds no keys: the checkout page shows "ssh-agent has no keys" and the log says to run `ssh-add` on this machine, instead of git in the container failing with "Permission denied (publickey)" while the agent shows as forwarded. The warning clears by itself once a key is added. The Git and ssh docs now explain loading your key into the agent and how to troubleshoot ssh in containers.

## 0.2.2

### Patch Changes

- [#12](https://github.com/tim-richter/opendevhub/pull/12) [`fc4493f`](https://github.com/tim-richter/opendevhub/commit/fc4493f7453dd78c078aa4a1d73b4d4ad303d746) Thanks [@tim-richter](https://github.com/tim-richter)! - Fix Forgejo and Jira tokens getting stuck behind "The OS credential store is unavailable or locked": replacing or clearing a token no longer fails when the old keychain entry can't be read or deleted (for example after denying the macOS keychain prompt). Credential store errors now say whether access was denied, no prompt could be shown, or the native module failed to load, and the underlying cause is logged with the secret redacted.

## 0.2.1

### Patch Changes

- [#10](https://github.com/tim-richter/opendevhub/pull/10) [`45293ed`](https://github.com/tim-richter/opendevhub/commit/45293edab71cbb3a3292d43bcaae664982c61c06) Thanks [@tim-richter](https://github.com/tim-richter)! - Fix `devcontainer up` and terminals failing with `posix_spawnp failed` on macOS: node-pty 1.1.0's `spawn-helper` ships without its execute bit, so opendevhub now restores it on startup.

## 0.2.0

### Minor Changes

- [`7a6b612`](https://github.com/tim-richter/opendevhub/commit/7a6b6126b9e15de17e01dd56d6af943450b88130) Thanks [@tim-richter](https://github.com/tim-richter)! - Expand the Forgejo integration with paginated authored, review-requested, and assigned inboxes; PR descriptions, reviews, inline discussion, and CI checks; selected-feedback handoff to local sessions or new tasks; in-memory TanStack Query caching and request cancellation; remembered navigation and a changed-files navigator; and connection testing before saving credentials.

- [#8](https://github.com/tim-richter/opendevhub/pull/8) [`59e35b4`](https://github.com/tim-richter/opendevhub/commit/59e35b46e1beae6f2ea7e359d922efcd817ffe4c) Thanks [@tim-richter](https://github.com/tim-richter)! - Split the Forgejo pull request page into **Address feedback** and **Review** modes. Address feedback shows reviewers' inline comments in the diff and gathers comments, reviews, failing checks and AI findings into one handoff to an agent. Review adds an AI review: an agent reviews the head commit in a checkout of the PR (or quickly, from the diff alone), and its findings appear in the diff as suggestions to accept, edit or dismiss before you submit your review.

- [`59f9c43`](https://github.com/tim-richter/opendevhub/commit/59f9c4384742a15014424bb589ec71b7d1c77036) Thanks [@tim-richter](https://github.com/tim-richter)! - Add an optional Forgejo integration configured in Settings, with tokens in the OS credential store and automatic migration from legacy settings. A single sidebar link opens all authored pull requests with state filters and unified or side-by-side diffs using the existing renderer.

- [`b6582b4`](https://github.com/tim-richter/opendevhub/commit/b6582b4cb6499a62d3b801ca3c67f755cba39965) Thanks [@tim-richter](https://github.com/tim-richter)! - Add an optional self-hosted Jira integration with protected personal access tokens, assigned-ticket browsing, key and text search, and ticket details. Create agent tasks from tickets and retain the originating ticket and description in session metadata, with links and original requirements available during worktree review.

- [`e00656b`](https://github.com/tim-richter/opendevhub/commit/e00656bc673c03c26b8694435fbe32ff4154446a) Thanks [@tim-richter](https://github.com/tim-richter)! - Add an interactive Terminal tab for every checkout, including remote worktrees, with a remembered bash, zsh, sh, or fish selector and session reconnection.
