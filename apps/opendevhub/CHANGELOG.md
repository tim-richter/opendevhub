# opendevhub

## 0.5.0

### Minor Changes

- [`6171239`](https://github.com/tim-richter/opendevhub/commit/617123911dc50c9e36bf4219dad5859affda0f36) Thanks [@tim-richter](https://github.com/tim-richter)! - Checks can be grouped: give checks the same `group` and the Checks panel shows them under one heading with a **Run group** button and a count of how many passed. Groups can be set in `devcontainer.json` or in the project's settings.

  A check's timeout is no longer capped at 7200 seconds: any positive number of whole seconds works.

  The checks editor shows groups as boxes you can add, rename and remove, and checks can be dragged (or moved with the arrow keys) to reorder them within and between groups. **Copy mine to team** opens the team's checks with your own merged in, to review and save to `devcontainer.json`.

- [#22](https://github.com/tim-richter/opendevhub/pull/22) [`6b1d67a`](https://github.com/tim-richter/opendevhub/commit/6b1d67a5c3a05c8cc7415654c47df0226ae853df) Thanks [@tim-richter](https://github.com/tim-richter)! - Add personalization: devcontainer Features, a setup command, a dotfiles repository and mounts (folders or volumes) that you add to every project's containers, or to one project's. They are kept in opendevhub's config.json and never in the repository. Set them in Settings → Personalization and in each project's settings.

- [`6171239`](https://github.com/tim-richter/opendevhub/commit/617123911dc50c9e36bf4219dad5859affda0f36) Thanks [@tim-richter](https://github.com/tim-richter)! - Teams can share more project settings in `devcontainer.json` under `customizations.opendevhub`: the project's name, sidebar letters and color, and its Jira and Forgejo links, alongside checks, isolation and key files. The project's settings pages mark values that come from the team, and a **Just me / Team** switch saves a setting to your own config or to `devcontainer.json`, keeping its comments and formatting. Forwarded ports can be saved to the file's `forwardPorts` the same way.

  Your own checks are now laid over the team's by name instead of replacing the whole list: a check with a new name is added, one with a team check's name replaces it for you, and **Turn off** stops you running a team check. If you had saved your own list before, team checks that aren't in it now run as well.

  `sshAgent` in `devcontainer.json` is no longer read; turn ssh-agent forwarding off in `~/.config/opendevhub/config.json` instead.

### Patch Changes

- [#23](https://github.com/tim-richter/opendevhub/pull/23) [`1f810bb`](https://github.com/tim-richter/opendevhub/commit/1f810bb0f703ca3d53ad396963363a816901831f) Thanks [@Hedvegia](https://github.com/Hedvegia)! - Fix worktree host paths on macOS with Docker Desktop: bind mount sources the daemon reports under `/host_mnt/...` are mapped back to the machine path, so new worktrees (for example from a Jira ticket) are recorded at an existing folder instead of the non-existent `/host_mnt` one.

- [`5a7d1b3`](https://github.com/tim-richter/opendevhub/commit/5a7d1b325b5f09d5203e3f3a061111a2b840a923) Thanks [@tim-richter](https://github.com/tim-richter)! - Fix `devcontainer up` and terminals still failing with `posix_spawnp failed` on macOS after a `pnpm install` while opendevhub is running: node-pty's `spawn-helper` execute bit is now restored right before each spawn, not only at startup.

- [#20](https://github.com/tim-richter/opendevhub/pull/20) [`abcc22d`](https://github.com/tim-richter/opendevhub/commit/abcc22da312139d85dcde78fd64160445acc102e) Thanks [@tim-richter](https://github.com/tim-richter)! - Build the dashboard with React Compiler, so components re-render less without hand-written memoization.

## 0.4.0

### Minor Changes

- [`afc7002`](https://github.com/tim-richter/opendevhub/commit/afc700279bd9ca6e47cdbad80883cd139714d66e) Thanks [@tim-richter](https://github.com/tim-richter)! - Open a chat's checkout terminal from its right sidebar alongside Turns and Changes. The terminal fills the sidebar on desktop and opens in a sheet on smaller screens.

- [#19](https://github.com/tim-richter/opendevhub/pull/19) [`2a96fc9`](https://github.com/tim-richter/opendevhub/commit/2a96fc95f9f766d2b3cbd1ff70f3475f919cf7b5) Thanks [@tim-richter](https://github.com/tim-richter)! - Reviews show changed images as their before and after versions instead of "binary", in checkouts and Forgejo pull requests.

- [`0a81fb6`](https://github.com/tim-richter/opendevhub/commit/0a81fb673d7d28df36cbb584e6a8d066414343b4) Thanks [@tim-richter](https://github.com/tim-richter)! - The sidebar's header holds the project's Overview, Pull requests and Tickets (filtered to what the project is linked to) in place of Jump to and the footer buttons. The Tickets page takes raw JQL as a filter and saves views as presets, and a project can be linked to tickets by JQL as well as by board. The composer offers Start when its container is stopped, and Chat's start page can hand its message to New task.

- [`7b6bbf3`](https://github.com/tim-richter/opendevhub/commit/7b6bbf38e9759a4d678656f98df891e61d73f75b) Thanks [@tim-richter](https://github.com/tim-richter)! - Usage and Cleanup move into Settings, and the sidebar's footer gets icon buttons for the dashboard, pull requests and tickets. A project can be linked to a Jira board and a Forgejo repository in its settings; the sidebar then lists that project's open tickets and pull requests.

- [`c0799e1`](https://github.com/tim-richter/opendevhub/commit/c0799e1b5bdd2566ffd6f8c877732a52254f4c56) Thanks [@tim-richter](https://github.com/tim-richter)! - Each session has its own page: click a session's title in a checkout. It shows the session's cost, tokens by kind, how full its context window is, its subagents, and its turns, newest first, each with its prompt, duration, cost, tokens, tool calls and the agent's last reply. Expand a turn to see what it changed and comment on the lines; the comments go to that session. A box on the page sends the session another prompt.

- [`c0799e1`](https://github.com/tim-richter/opendevhub/commit/c0799e1b5bdd2566ffd6f8c877732a52254f4c56) Thanks [@tim-richter](https://github.com/tim-richter)! - Scan folders are now set in Settings → Projects and saved, replacing the `--root` CLI option. The overview links there when no projects are found.

- [`0a81fb6`](https://github.com/tim-richter/opendevhub/commit/0a81fb673d7d28df36cbb584e6a8d066414343b4) Thanks [@tim-richter](https://github.com/tim-richter)! - A project's tasks live in one Tasks card on its overview, filtered by state (Open, Needs you, Working, Idle, Drafts, Ended) and by title, in place of the sidebar's Tasks button and the overview's separate Drafts, Tasks and Ended tasks sections. Tasks waiting on you answer in place inside the card, and ended ones archive from it. The sidebar no longer lists the linked repository's open pull requests; its Pull requests button opens them. The composer's agent picker starts at the first agent opencode lists instead of showing no agent.

### Patch Changes

- [`bbdd00d`](https://github.com/tim-richter/opendevhub/commit/bbdd00d807231bfdd558b050721bc90068f8ff4d) Thanks [@tim-richter](https://github.com/tim-richter)! - Preserve strings when parsing devcontainer checks and reject invalid JSONC. Recover from saved config or state files whose top-level value is not an object, keeping a backup. Reject invalid `.lock` components in worktree branch names before invoking Git. Keep text diffs visible when their content mentions Git's binary patch marker.

- [`97d442a`](https://github.com/tim-richter/opendevhub/commit/97d442add507b80e4a4b9b6d30dbcca770861f85) Thanks [@tim-richter](https://github.com/tim-richter)! - Confirmations (removing sessions, worktrees and containers, rebuilds, discarding task variants, clearing AI reviews) now open an in-app dialog instead of the browser's `confirm()` prompt.

- [`c0799e1`](https://github.com/tim-richter/opendevhub/commit/c0799e1b5bdd2566ffd6f8c877732a52254f4c56) Thanks [@tim-richter](https://github.com/tim-richter)! - All dashboard pages now use the full window width, so moving to and from review pages no longer shifts the layout.

- [`07297d1`](https://github.com/tim-richter/opendevhub/commit/07297d19d2a42be84c6112d7d13fbd99ef3ff7ac) Thanks [@tim-richter](https://github.com/tim-richter)! - Compare modified images in the review as 2-up, swipe, onion skin or a pixel difference; the chosen view is remembered. Modified images start collapsed and only load once opened.

- [`c0799e1`](https://github.com/tim-richter/opendevhub/commit/c0799e1b5bdd2566ffd6f8c877732a52254f4c56) Thanks [@tim-richter](https://github.com/tim-richter)! - Token counts now include cache reads and writes, so usage reflects every token a model processed. Task variants also show their context size, the "total tokens" number opencode shows for a session.

- [`760f8f5`](https://github.com/tim-richter/opendevhub/commit/760f8f51c0277767b9b5d5249b1aba5e14d94c97) Thanks [@tim-richter](https://github.com/tim-richter)! - Use Hono RPC for typed dashboard requests and validate API inputs while preserving existing URLs, live updates, and terminal connections.

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
