## 1. Derived state

- [x] 1.1 Add `activeVariants` and `showsVariants` to `features/tasks/tasks.ts`, and re-express `switchableVariants`/`comparesVariants` through them
- [x] 1.2 Add `variantState(variant, session)` → Working / Needs you / Idle / Starting / Failed, and `taskAttention(task, sessions)` for the header pill
- [x] 1.3 Add `taskSteps(task, variant, { review, checks, aiReviewRunning })` returning ordered steps with done/current/todo
- [x] 1.4 Unit-test 1.1–1.3 in `test/web/features/tasks/tasks.test.ts`: single variant, after pick, failed-not-dismissed, two running, picked+pushed, AI review running, AI review task (no steps), and loading data counted as todo

## 2. Header and stepper

- [x] 2.1 Create `task-header.tsx`: breadcrumb (project / kind / ticket), title, attention pill, secondary metadata (PR badges, from chat, review-of, usage)
- [x] 2.2 Add the More task actions `DropdownMenu` with Activity (controlled sheet), Open in, and Archive; add Compare variants when `showsVariants`; add Review changes for AI review tasks
- [x] 2.3 Create `task-stepper.tsx`: the `<ol aria-label="Task progress">` with check marks and `aria-current="step"`, the current Review & checks step linking to the Review page, and a "Step n of m · label" phone form

## 3. Sidebar

- [x] 3.1 Create `task-sidebar.tsx` with variant cards (number, model, state, branch, +/−, checks n/m, cost), shown only when `showsVariants`; selecting sets `v` and clears `thread`
- [x] 3.2 Move `ConversationTabs` logic into a `VariantConversations` list (select, close, New conversation · fresh context), titled "Conversations in V<n>" or "Conversations"
- [x] 3.3 Add the icon form for 768–1023px: variant numbers with state dots, a conversations popover, and New conversation
- [x] 3.4 Show starting and failed variants as cards with their setup step; render the setup log and Dismiss in the main area when one is selected; remove the `StartingCard` grid

## 4. Status rail and strip

- [x] 4.1 Add a `useVariantStatus()` hook in `task-status.tsx` (branch, base, env and its state, node, review stats, checks) on `reviewQuery`/`checksQuery`
- [x] 4.2 Build `TaskStatusRail` (Target, Checks with Run all, Changes with Review changes → Review page)
- [x] 4.3 Build `TaskStatusStrip` for the tab-bar row (branch · env · n failing · Review → Review page)
- [x] 4.4 Add the `checks` task tab route rendering the rail's content; add `checks` to `taskTabs` and `TaskTab`; list it in the tab bar only below `md`

## 5. Changes tab

- [x] 5.1 Create `task-changes.tsx`: the Uncommitted / vs base toggle (`working`/`branch`) with counts, and a flat file list (status, path, +/−), with no file selected on load
- [x] 5.2 On select, set `?file=` and show that one file's diff with `LazyPatchView`, fetching its patch when it's missing (large, over budget); clear the selection when the file leaves the list
- [x] 5.3 Keep the main-checkout note; add the Review changes button; drop `ProjectReview` from the tab
- [x] 5.4 Story for the Changes tab: empty, list only, file selected, large file

## 6. Review page

- [x] 6.1 Add the `review` task route outside the task frame, rendering `ProjectReview` in `VariantCheckout` with `v`'s default
- [x] 6.2 Build its slim header: back to `/changes?v=n`, title, variant (when `showsVariants`), branch → base; handle a removed worktree
- [x] 6.3 Point the Changes tab button, rail, strip and stepper at it

## 7. Runtime tab

- [x] 7.1 Add a `RuntimeControls` card to `CheckoutRuntime`: container name/state, opencode state/version, own vs shared, local vs node
- [x] 7.2 Wire Restart opencode, Rebuild (+ without cache), Stop/Start and Remove (own container only) to `envAction`/`removeEnv` or the project actions; confirmations for Stop/Remove, listing affected checkouts for the shared container; map 409 to "another action is running"
- [x] 7.3 Server: store log entries as `{ envId, at, line }` in `Environments`' buffer, keeping `/logs` output unchanged; test it
- [x] 7.4 Server: add `Containers.logs(id, lines)` (`docker logs --tail --timestamps`) and `Environments.envLogs(project, env, source, lines)` for `setup`, `container` and `opencode` (`tail` of `/tmp/opendevhub-opencode.log`), returning `unavailable` with a reason when the container is stopped or the node can't serve it; test it
- [x] 7.5 Server: add `GET /api/projects/:id/envs/:env/logs?source=&lines=` (main environment addressed by the project id), capped at 2000 lines
- [x] 7.6 Web: `envLogs` in `api.ts`, a polled query (3s while visible), and the All / Setup / Container / opencode filter with merge by time, follow-the-end, and the unavailable message
- [x] 7.7 Stories for the Runtime tab: own container running, shared container, stopped, log sources

## 8. Page frame

- [x] 8.1 Rewrite `ProjectTask` as the responsive grid (phone / `md` icon sidebar / `lg` full sidebar / `min-[90rem]` rail), keeping `fillViewport` for the full-height tabs
- [x] 8.2 Tab bar: Conversation, Changes with file count, Terminal, Runtime, Spec (when spec-first), Checks (phone only); no conversation tabs, no Compare tab
- [x] 8.3 Phone header: back link, title, Task actions button, variant segmented control only when `showsVariants`, branch chip, and a thread select on the Conversation tab
- [x] 8.4 Remove the `Segmented` switcher and the header `CheckoutChecks` from the task page; check `/compare` still renders `TaskCompare` and keeps its redirects

## 9. Composer

- [x] 9.1 Add an optional `composerLabel` to `SessionView`'s composer; pass "To V<n> · branch" or "branch" from `TaskConversation`
- [x] 9.2 Check the chat page's composer is unchanged

## 10. Stories and checks

- [x] 10.1 Extend `task-page.stories.tsx`: single variant, two variants (needs you + working), starting variant, picked task, AI review task, plus phone (390), narrow laptop (900), laptop (1280) and wide (1440) viewports
- [x] 10.2 Run `pnpm exec ultracite fix`, typecheck and tests; run `graphify update .`
- [ ] 10.3 Walk through the spec scenarios in the running app at 390, 900, 1280 and 1440 widths
