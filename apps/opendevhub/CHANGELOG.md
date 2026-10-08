# opendevhub

## 0.2.0

### Minor Changes

- [`7a6b612`](https://github.com/tim-richter/opendevhub/commit/7a6b6126b9e15de17e01dd56d6af943450b88130) Thanks [@tim-richter](https://github.com/tim-richter)! - Expand the Forgejo integration with paginated authored, review-requested, and assigned inboxes; PR descriptions, reviews, inline discussion, and CI checks; selected-feedback handoff to local sessions or new tasks; in-memory TanStack Query caching and request cancellation; remembered navigation and a changed-files navigator; and connection testing before saving credentials.

- [#8](https://github.com/tim-richter/opendevhub/pull/8) [`59e35b4`](https://github.com/tim-richter/opendevhub/commit/59e35b46e1beae6f2ea7e359d922efcd817ffe4c) Thanks [@tim-richter](https://github.com/tim-richter)! - Split the Forgejo pull request page into **Address feedback** and **Review** modes. Address feedback shows reviewers' inline comments in the diff and gathers comments, reviews, failing checks and AI findings into one handoff to an agent. Review adds an AI review: an agent reviews the head commit in a checkout of the PR (or quickly, from the diff alone), and its findings appear in the diff as suggestions to accept, edit or dismiss before you submit your review.

- [`59f9c43`](https://github.com/tim-richter/opendevhub/commit/59f9c4384742a15014424bb589ec71b7d1c77036) Thanks [@tim-richter](https://github.com/tim-richter)! - Add an optional Forgejo integration configured in Settings, with tokens in the OS credential store and automatic migration from legacy settings. A single sidebar link opens all authored pull requests with state filters and unified or side-by-side diffs using the existing renderer.

- [`b6582b4`](https://github.com/tim-richter/opendevhub/commit/b6582b4cb6499a62d3b801ca3c67f755cba39965) Thanks [@tim-richter](https://github.com/tim-richter)! - Add an optional self-hosted Jira integration with protected personal access tokens, assigned-ticket browsing, key and text search, and ticket details. Create agent tasks from tickets and retain the originating ticket and description in session metadata, with links and original requirements available during worktree review.

- [`e00656b`](https://github.com/tim-richter/opendevhub/commit/e00656bc673c03c26b8694435fbe32ff4154446a) Thanks [@tim-richter](https://github.com/tim-richter)! - Add an interactive Terminal tab for every checkout, including remote worktrees, with a remembered bash, zsh, sh, or fish selector and session reconnection.
