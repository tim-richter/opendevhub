## Context

The reference is the "Task" artboards in the opendevhub Control Room canvas (https://claude.ai/artifact/1NoSAojzn42iCphXN4htg6): `Task.dc.html` (1440), `Task.laptop.dc.html` (1280) and `Task.mobile.dc.html` (390).

Today `ProjectTask` (`features/tasks/project-task.tsx`) renders everything in one column:

1. A provenance breadcrumb.
2. A title row with chips, `CheckoutChecks`, `OpenInMenu`, `ActivityButton` and Archive.
3. Review-of and AI-review notes.
4. A grid of `StartingCard`s.
5. A `Segmented` variant switcher.
6. A `TabBar` that mixes `ConversationTabs` (one tab per conversation, with close and +) and page tabs (Spec, Compare).

Below that, an `<Outlet/>` renders the tab routes inside `TaskPageCtx`.

The Changes tab is `ProjectReview`, which is the full review:

- the changed-files tree and every diff
- the Working, Branch and Turn modes
- line comments, AI review and Open Code Review
- publish and merge

`ReviewData.files[]` carries each file's patch, unless the file is large or binary or ran over the patch budget. Those patches are loaded with `?file=`.

The Runtime tab is `CheckoutRuntime`: forwarded ports, host ports, and `CheckoutLogs`. `CheckoutLogs` is the project's whole log buffer (`Environments.log`), where an own container's lines start with `[branch]`.

The server already has lifecycle actions for each environment, all exposed through `envAction`:

- `startEnv`, `stopEnv`, `rebuildEnv` (with no-cache) and `restartEnvOpencode`
- `removeEnv`
- the project-level `start`, `stop`, `rebuild` and `restart-opencode`, for the main environment

The web API has `envAction(projectId, envId, action)` and `removeEnv`. opencode runs as `nohup opencode serve … > /tmp/opendevhub-opencode.log` inside the container (`server/opencode/runtime.ts`). Nothing reads the container's own output (`docker logs`) yet.

The UI uses Tailwind and shadcn (`@opendevhub/ui`), with semantic tokens (`text-ok`, `text-warn`, `text-running`, `text-destructive`). The design's dark palette maps to these. Its colours aren't copied.

## Goals / Non-Goals

**Goals:**

- Match the design's structure: header, stepper, sidebar, main, rail, with laptop and phone variants.
- Show no variant UI when fewer than two variants are active.
- Make Changes a light diff viewer, and move the full review to its own page.
- Give Runtime the container controls and logs split by source.
- Keep the Conversation, Terminal, Spec and Compare bodies working unchanged inside the new frame.

**Non-Goals** (left out on purpose, or for follow-up changes):

- "Send last output to agent" in the terminal: dropped.
- "Send to agent" on a failed check: dropped for now.
- Line comments on the Changes tab. They stay on the Review page.
- Merging the Review page with the Forgejo pull request page's review mode. Both stay. A PR review task links to the Review page of its checkout.
- Naming variants A/B. We keep V1/V2, because `?v=` is numeric and the rest of the UI says V<n>.
- The global left rail (inbox, projects, connection dot), which is the app shell.
- Streaming logs over the event stream. Polling is enough for now.

## Decisions

### Active variants

Add `activeVariants(task) = task.variants.filter(v => !v.discarded)` to `tasks.ts`. Also add `showsVariants = activeVariants(task).length >= 2`.

`switchableVariants` and `comparesVariants` already exist. They're re-expressed through `activeVariants`, so all three always agree: the Compare button, the switcher and the labels.

A failed start that hasn't been dismissed counts as active. That way it stays visible with its error until the user dismisses it.

**Alternative considered:** counting only running variants. Rejected: an idle variant waiting for a pick still needs to be told apart.

### Stepper as a pure function

Add `taskSteps(task, variant, { review, checks, aiReviewRunning })` to `tasks.ts`. It returns `{ id, label, state: "done" | "current" | "todo" }[]`.

- `review` and `checks` come from `reviewQuery` and `checksQuery`, which share a cache with the Changes tab and the rail.
- `aiReviewRunning` comes from the variant's local AI review and OCR state (`local-ai-review.ts`, and the OCR records in `ai-review-records`).
- Data still loading counts as todo, so the stepper never shows a false "done".

Being pure makes it unit-testable. The scenarios in the spec map one-to-one onto tests.

**Alternative considered:** storing a task phase on the server. Rejected: everything the stepper needs can already be derived.

### Layout: one grid, regions as components

`ProjectTask` becomes a CSS grid:

- `grid-cols-[1fr]` on phones
- `md:grid-cols-[3.5rem_1fr]` from 768px, with the icon sidebar
- `lg:grid-cols-[14rem_1fr]` from 1024px
- `min-[90rem]:grid-cols-[14rem_1fr_17rem]` from 1440px, with the rail

Its regions are new files:

- `task-header.tsx`: breadcrumb, title, pill, actions menu
- `task-stepper.tsx`: the `<ol>` on desktop, the "Step n of m" text on phones
- `task-sidebar.tsx`: the full sidebar and its icon form, with the conversation list in a popover
- `task-status.tsx`: `TaskStatusRail` and `TaskStatusStrip`, both fed by one `useVariantStatus()` hook

Visibility is done in CSS (`hidden md:flex`, `min-[90rem]:…`), not with JS media queries. That's simpler and avoids layout flashes.

### Changes tab: a list, then one diff

`task-changes.tsx` replaces `TaskChanges`' use of `ProjectReview`. It uses `reviewQuery(project, directory, mode)` with the `working` or `branch` mode from the toggle:

- **List:** a flat list of `ReviewFile`s with their status letter, path and +/−. It's flat rather than a tree, as in the design. `changed-files-tree.tsx` stays for the Review page.
- **Diff:** for the selected file (`?file=`), use `file.patch` when it's present, or else fetch it through the existing per-file request. Render it with `LazyPatchView`/`PatchView` and no comment handlers.
- **No auto-select:** nothing is selected on first load, per the design, so the tab stays cheap with large change sets.

**Alternative considered:** a prop on `ReviewTarget` that hides the rest of it. Rejected: `ReviewTarget` carries publish and merge state, comment drafts and AI review polling. A separate small component is easier to keep light.

### Review page

Add a `review` route under the task: `/p/:project/t/:task/review`.

- It reads `v` and renders `ProjectReview` inside `VariantCheckout`, unchanged, under a slim header (back link, title, variant, branch → base).
- It sits outside the task frame, so it gets no sidebar, tabs or rail.
- The back link goes to `/changes?v=n`.
- An AI review task's page gets a "Review changes" action pointing at its checkout's Review page. Today that task shows review findings inline through `TaskReviews`; those stay as a note.

The old worktree redirect, `review` → `changes`, stays as specified. The Changes tab's button is one click from the full review. Leaving that redirect alone also avoids touching the "Old URLs redirect to tasks" requirement, which `split-chats-and-tasks` also changes.

### Runtime controls

`CheckoutRuntime` gets a `RuntimeControls` card first.

- **Which environment:** `envOfDirectory(view, directory)` tells whether the variant has its own container (an env id) or uses the project's main one.
- **Actions:** call `envAction(project, env, action)` for an own container, or the project action for the shared one. Remove calls `removeEnv`.
- **Busy state:** shown from the existing runtime state (`containerState`, `opencode`, and the busy flag if present). A `BusyError` (409) is reported as "another action is running".
- **Shared container:** its Stop, Rebuild and Remove confirmations list the checkouts it serves.

The worktree pages share `CheckoutRuntime`, so they get the card too. That's intended.

### Runtime logs: small endpoints, polled

The server gets two additions:

- `Containers.logs(containerId, lines)`, which runs `docker logs --tail <n> --timestamps`. The Docker runtime reached through the kit already runs `stop` and `inspect` the same way.
- `Environments.envLogs(projectId, envId, source, lines)`:
  - `container` → `Containers.logs`
  - `opencode` → exec `tail -n <n> /tmp/opendevhub-opencode.log` in the container, as the health-check failure path already does
  - `setup` → that environment's lines from the project log buffer

  The main environment is addressed by the project's id, like `VariantView.envId` does.

- **Tagging:** `envLog` already knows the env. The buffer stores `{ envId, at, line }` instead of a string, and the existing `/logs` output is unchanged, rendered from it with the `[branch]` prefix.

The route is `GET /api/projects/:id/envs/:env/logs?source=container|opencode|setup&lines=500`, returning `{ lines: { at?: number; text: string }[]; unavailable?: string }`.

On the client, a `useQuery` per source refetches every 3 seconds while the tab is visible. The filter is a `Segmented` (All / Setup / Container / opencode). All merges the sources by `at`, and appends lines without a time per source.

On a remote node, exec and `docker logs` go through the node's kit, if it supports them. If it doesn't, the source returns `unavailable: "not available on remote nodes yet"`.

**Why polling:** these are tails of logs that change slowly. Polling avoids a new stream type and stops cleanly when the tab closes.

### Conversations move to the sidebar

`ConversationTabs`' logic moves into a `VariantConversations` list in the sidebar: the thread list, start and close mutations, and navigation after a close. On phones the same list is shown as a compact select above the conversation. `TaskConversation` keeps reading `thread`.

### Checks tab route on phones

Add a `checks` task tab route that renders the rail's content full-width. `taskTabs` includes it always. The tab bar marks it `md:hidden`, so it's listed only on phones. Opening it on a wide screen still works.

### Header actions menu

Activity, Open in and Archive move into a shadcn `DropdownMenu`. The Activity item opens the existing activity sheet through a controlled `open` prop. `CheckoutChecks` is no longer used on the task page.

### Composer label

`SessionView` gets an optional `composerLabel` prop, which `TaskConversation` passes in. Chats pass nothing, so the chat page doesn't change.

## Risks / Trade-offs

- **Publish is one click further away.** It's now on the Review page. That's mitigated by Review changes in three places, and by the stepper linking there when Review & checks is current.
- **Polling logs costs an exec per source every 3s.** It only runs while the Runtime tab is visible and the source is in the filter, and `lines` is capped at 2000.
- **`docker logs` may be empty.** opencode is started with `nohup` into a file, so the container's own output is usually just its init process, often empty. Container is still useful for devcontainer images that run services in the foreground. When it's empty, it says so.
- **Changing the log buffer's element type touches `/logs` consumers.** It's mitigated by keeping that API's output identical, rendered from the new elements.
- **Three columns squeeze the conversation at 1440px.** The main column gets `max-w-[52rem]` content.
- **A phone-only route can be hit on desktop.** It's accepted and renders fine.
- **The pending `split-chats-and-tasks` change edits the "Conversation tab" requirement in `task-navigation`.** This change edits only "Task page tabs" and "Variant switcher", so the deltas don't overlap.

## Resolved questions

- **Sidebar at 768–1024px:** it collapses to an icon strip.
- **AI review and Review & checks:** a started AI review or OCR keeps Review & checks current until it finishes.
