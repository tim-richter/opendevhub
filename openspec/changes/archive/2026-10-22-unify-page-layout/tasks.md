## 1. Layout plumbing

- [x] 1.1 Augment TanStack Router's `StaticDataRouteOption` with `layout?: "index" | "document" | "workspace"` and export the `PageLayout` type
- [x] 1.2 Add a `usePageLayout()` context (default `index`) in `components/page.tsx`
- [x] 1.3 In `shell/shell.tsx`, resolve the deepest matched route's layout via `useMatches()`, provide it through the context, and set `data-layout` on the outlet wrapper
- [x] 1.4 Give the shell's `workspace` wrapper the same top and side padding, no bottom padding, and a fixed height of the remaining viewport (flex column, `min-h-0`)
- [x] 1.5 Make `Page` cap every child except `PageHeader` at `max-w-3xl` when the layout is `document`, and keep `PageHeader` full width
- [x] 1.6 Remove `fillViewport` from `components/page.tsx`

## 2. Declare layouts on routes

- [x] 2.1 ~~In `app.tsx`, declare `document` on the project To-do route~~ Dropped: To-do stays on `index` (see design)
- [x] 2.2 Declare `workspace` on the task Conversation (`/`) and Terminal tab routes, the chat view route and the `/chat` route
- [x] 2.3 Leave every other route on the `index` default and confirm none needs a declaration

## 3. Migrate pages

- [x] 3.1 Dashboard (`features/projects/overview.tsx`): remove `mx-auto max-w-5xl` and replace the hero header with `PageHeader` (title, description, All tasks / All chats as actions)
- [x] 3.2 To-do (`features/projects/project-todos.tsx`): drop the `mx-auto max-w-3xl` wrapper and render its contents straight into the project's `Page`
- [x] 3.3 Jira list and board (`features/jira/jira-page.tsx`): remove `mx-auto` and the board-only `max-w-7xl` switch
- [x] 3.4 Jira ticket: remove `mx-auto max-w-6xl`
- [x] 3.5 Task page (`features/tasks/project-task.tsx`): remove `FILL_TABS` and the `fillViewport` toggle; make the frame fill its workspace parent (flex-1, `min-h-0`) and check that the setup view still renders top-aligned
- [x] 3.6 Chat view (`features/chat/chat-start.tsx` `centred === false`, `chat-view.tsx`): replace `fillViewport` with filling the workspace parent, and keep the centered transcript and composer column
- [x] 3.7 Chat start: replace the hand-copied `min-h-[calc(…)]` / `-mb-*` maths with centering inside the workspace container
- [x] 3.8 Grep for any remaining page-level `mx-auto` or `max-w-*` outer wrappers and remove them

## 4. Stories and verification

- [x] 4.1 Update Storybook stories that render pages (dashboard, todos, jira, task, chat) so they render with the right layout context
- [x] 4.2 In the running app at 1920px and phone width, switch between Dashboard, Tasks, Chats, Jira (list and board), a Jira ticket, Forgejo, project overview, To-do, a checkout, a task (Conversation, Changes, Terminal) and a chat, and check that the title and header actions don't move and that the composer and terminal are pinned to the bottom
- [x] 4.3 Run `pnpm exec ultracite fix`, the type check and the web tests
- [x] 4.4 Run `graphify update .`
