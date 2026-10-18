## Why

The task page stacks everything in one column: title and chips, a row of action buttons, starting cards, a variant switcher, then a tab bar that mixes conversation tabs (with close buttons) and page tabs (Spec, Compare). It's hard to see where a task stands, which variant you're talking to, and whether its checks pass, without changing tabs.

The Changes tab also carries the whole review: publishing, merging, AI review and line comments. That makes a quick look at what changed heavy.

The "Task" design in the opendevhub Control Room canvas (desktop 1440, laptop 1280, mobile 390) fixes this. It puts the task's progress at the top, the variants and their conversations on the left, the work in the middle, and the selected variant's status on the right. It also keeps Changes a simple diff, with the full review on its own page. This change moves the task page to that layout.

## What Changes

- **Header**: a breadcrumb (project / Task / ticket key), the title with one attention pill (Needs you, Working, Idle, Starting, Ended), and on the right only "Compare variants" and a "More task actions" menu. Activity, Open in, Archive and the rest move into the menu.
- **Progress stepper** under the title: Brief → Agents → Pick variant → Review & checks → Publish → Pull request.
  - Each step is worked out from data the page already has, and the current step is highlighted.
  - Pick variant is only shown for tasks that started with two or more variants.
  - Review & checks also waits for an AI review that was started to finish.
  - AI review tasks have no stepper.
- **Left sidebar** with two sections:
  - Variants: one card per active variant, showing number, model, state, branch, +/−, checks and cost.
  - Conversations in the selected variant: replaces the conversation tabs and their close buttons, and holds "New conversation".

  From 768px up to 1024px the sidebar collapses to an icon strip.

- **Variants are hidden when only one is active.** With a single active (non-discarded) variant, the page shows no variant cards, no switcher, no Compare button and no "To V2" labels. This covers a single-variant task, and a multi-variant task after a pick. **BREAKING** (UI only): the sidebar's variant cards replace the `Segmented` variant switcher.
- **Tab bar** for the selected variant: Conversation, Changes (with file count), Terminal, Runtime, plus Spec for spec-first tasks. Compare leaves the tab bar and is opened from the header button. Its URL stays `/compare`.
- **Changes tab becomes a simple diff.** It first lists only the changed files, with an "Uncommitted / vs base" toggle. Clicking a file shows that one file's diff. It has no publishing, merging, AI review or line comments. A "Review changes" button opens the new Review page. **BREAKING** (UI only): publishing and merging move off the Changes tab.
- **New Review page** at `/p/:project/t/:task/review?v=n`. It holds today's full review for the variant's checkout: all diffs, line comments, AI review and Open Code Review, publish, merge. It's reached from the task (Changes tab, status rail, status strip, the Review & checks step) and from a PR review task.
- **Runtime tab gets container controls and per-source logs.**
  - Controls: the container's name, state, opencode health and version, and Restart opencode, Rebuild (with a no-cache option), Stop or Start, and Remove container. Stop and Remove ask for confirmation, and actions on a shared container say which other checkouts they affect.
  - Logs: the selected variant's environment, filterable by All, Setup, Container and opencode. Container and opencode logs are new: a small endpoint reads `docker logs` and the opencode log file inside the container.
- **Right status rail** at wide widths (≥1440px):
  - Target: branch and base, container and its state, local or the remote node.
  - Checks: each check's state, plus Run all.
  - Changes: file count, +/−, and "Review changes".

  This replaces the header's checks button.

- **Laptop width** (768–1439px): no rail. A status strip on the tab-bar row shows the branch, the environment, how many checks fail, and "Review →".
- **Phone width** (<768px):
  - Back button and title.
  - A variant segmented control, only when two or more are active.
  - "Step n of m · <step>" in place of the stepper.
  - Scrollable tabs, plus a Checks tab that holds the rail's content.
  - A branch chip, and the composer pinned at the bottom.
- **Composer** names its target: "To V2 · feat/oauth-b" with two or more active variants, otherwise just the branch.
- **Starting variants** show in the variant list with their setup step. Selecting one shows its setup log in the main area, replacing the grid of starting cards.
- **Left out on purpose**:
  - "Send last output to agent" in the terminal.
  - "Send to agent" on a failed check.
  - Line comments on the Changes tab; they stay on the Review page.

## Capabilities

### New Capabilities

- `task-page-layout`: covers the task page's layout and what each region shows:
  - header, progress stepper, and the variant and conversation sidebar
  - status rail and status strip
  - the simple Changes tab
  - the Runtime tab's controls and logs
  - the composer target label and the phone layout
  - the rule that variant UI only appears when two or more variants are active
- `change-review-page`: the standalone Review page of a task variant's checkout: its URL, how it's reached, and what it holds.

### Modified Capabilities

- `task-navigation`:
  - "Task page tabs": Compare becomes a header action instead of a tab, conversations move out of the tab bar, Changes becomes a simple diff, and a phone-only Checks tab is added.
  - "Variant switcher": the switcher becomes the sidebar's variant cards, or a segmented control on phones, and it's hidden whenever fewer than two variants are active, not just for single-variant tasks.

## Impact

- `apps/opendevhub/src/web/features/tasks/project-task.tsx`: `ProjectTask` is rewritten into header, stepper, sidebar, main and rail regions. `ConversationTabs` becomes a sidebar list. `StartingCard` moves into the variant list.
- New components under `features/tasks/`: `task-header.tsx`, `task-stepper.tsx`, `task-sidebar.tsx`, `task-status.tsx` (the rail and the strip), `task-changes.tsx` (the simple diff) and `task-review.tsx` (the Review page).
- `features/tasks/tasks.ts`: new pure helpers `activeVariants`, `taskSteps`, and `variantState`, with tests.
- `features/review/`: `ProjectReview` moves unchanged to the Review page. The Changes tab reuses `reviewQuery` (including `?file=` for one file's patch) and `PatchView`.
- `features/checkouts/checkout-page.tsx`: `CheckoutRuntime` gets the controls card and the log source filter. The worktree pages get these too, since they share it.
- Server: a new `GET /api/projects/:id/envs/:env/logs?source=container|opencode&lines=n`, plus the same for the project's main environment. `Containers.logs()` reads `docker logs --tail`, and opencode's log is read with `tail` on `/tmp/opendevhub-opencode.log`. Project log lines get an environment tag, so Setup lines can be filtered per environment.
- Routes: a `checks` task tab for phones, and a `review` task page. `/compare` is unchanged.
- `task-conversation.tsx`: thread selection moves to the sidebar. The composer gets a target label.
- Storybook: `task-page.stories.tsx` gets single-variant, two-variant, starting, phone and laptop stories, plus stories for the Changes tab and the Runtime tab.
