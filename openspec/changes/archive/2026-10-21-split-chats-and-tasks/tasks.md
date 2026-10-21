## 1. Shared checkout setup

- [x] 1.1 Extract the worktree → image → container → session → first-message pipeline from `Tasks` (`server/tasks/tasks.ts`) into a `CheckoutSetup` job with a progress sink interface; variants report through a sink that writes `variants` rows
- [x] 1.2 Check that the existing task-start tests (one variant, several variants, failing variant, remote node, restart during setup) pass unchanged

## 2. Database

- [x] 2.1 Add migration 2: create `chats` (design decision 1) and its indexes (`project_id, archived_at`; unique `session_id`), and add `tasks.plan`
- [x] 2.2 In the same migration, move manual tasks into chats (`'c_' || task_id`, origin from `session.adopted` events), clear `branches.created_by_task/variant` that point at manual variants, and delete the manual variants and tasks
- [x] 2.3 Add `server/db/chats.ts`: insert (with origin and step), set step/session, sync title, mark/unmark removed, archive, adopt (set `adopted_*`), get by id or session, and list for the snapshot (not internal, archived, removed or adopted)
- [x] 2.4 Write the events `chat.started`, `chat.discovered`, `chat.removed`, `chat.archived` and `chat.adopted` in the same transaction as each change
- [x] 2.5 Remove the manual-task paths from `server/db/tasks.ts` (`adoptSession`, manual title sync, `manual` kind); drop `manual` from `TaskKind` in `shared/types.ts`
- [x] 2.6 Tests: migration of a database with manual tasks (adopted and hub-started, one archived, one with a manual worktree branch); chat CRUD; events are written once and a steady reconcile writes none

## 3. Reconcile and sessions

- [x] 3.1 In `server/sessions/reconcile.ts`, adopt unknown top-level sessions as chats with origin `opencode`, extend the "creating in this directory" guard to chats, and move title sync and removal marking to chats
- [x] 3.2 Make sessions opendevhub starts outside a task (checkout-page conversation, `/new`, a new worktree with a conversation) record a `hub` chat before reconcile
- [x] 3.3 Make text generation (commit and publish messages) record its session as an `internal` chat
- [x] 3.4 Leave `SessionSummary.task` unset for chat sessions; attribute their usage to no task
- [x] 3.5 Tests: an opencode session becomes a chat; a variant session being created is not adopted; a generated-text session is internal and not in the snapshot

## 4. Tasks: drafts and adding variants

- [x] 4.1 Split `beginTask` into "insert task" and `addVariants(task, specs)` (numbers continue after `MAX(n)`); `startTask` = insert + add
- [x] 4.2 Make `taskState` return `draft` for a task with no variants; add `draft` to `TaskState`
- [x] 4.3 Add API routes: create a draft (stores `plan`), edit a draft, and start a draft (adds variants to the same task)
- [x] 4.4 Add a draft-from-ticket route that titles from the ticket, uses its description as the brief, and links it (`ticket.linked`)
- [x] 4.5 Include `plan` and the brief in the task snapshot; include drafts in the ticket lookup
- [x] 4.6 Tests: draft → start keeps the task id and numbers variants 1..n; adding variants to a running task numbers them after the last; a draft from a ticket is listed by the ticket lookup

## 5. Chat start without tasks

- [x] 5.1 Rewrite `Chat.start` (`server/sessions/chat.ts`): "New worktree" creates a `hub` chat and runs `CheckoutSetup` with the chat's sink (branch named from the message); a checkout starts a session, records the chat and sends the message; return `{ chat }`
- [x] 5.2 Update `ChatStartResult` and `web/api.ts`; add `GET /api/projects/:id/chats/:chat` (returns the chat, or `adoptedBy` with task and variant) and `POST …/chats/:chat/archive`
- [x] 5.3 Tests: neither target creates a task; a new-worktree chat reports steps and gets its session; a failed worktree records step `failed` on the chat

## 6. Make task

- [x] 6.1 Add `GET /api/projects/:id/chats/:chat/brief`: `generate()` on the chat's own session with the brief prompt; plus suggestions for Jira keys from the branch and user messages, and a PR whose head is the branch
- [x] 6.2 Add `POST /api/projects/:id/chats/:chat/task`: validate (worktree, not adopted, not internal, live session), then in one transaction insert the task, variant 1 from the chat, `adopted_*`, `chat.adopted`, and the ticket/PR links
- [x] 6.3 After commit: send `opsx-propose <brief>` when `spec` is set (marking the task spec-first and variant 1 phase `propose`), then `addVariants` for the extra variants from the branch's base
- [x] 6.4 Tests: plain adoption keeps the session and adds no message; a double submit is rejected; a main-checkout chat is rejected; the spec option runs the command; an extra variant failing keeps the task and variant 1

## 7. Web: shared conversation and chat pages

- [x] 7.1 Extract the conversation body from the Conversation tab into a shared `Conversation` component; use it in both the task tab and the chat view
- [x] 7.2 Change the chat routes to `/chat/$projectId/$chat`; redirect task ids (by prefix) to the task page, and adopted chats to their task with the variant selected
- [x] 7.3 Chat view header: title, project, checkout, Changes (a review view in a sheet or split pane), Make task (disabled with a reason for the main checkout), Archive
- [x] 7.4 `make-task-dialog.tsx`: title, brief (draft fills it unless the user has typed; failure message), ticket and PR fields with suggestions, spec option, extra variants with model/agent; on success open the task's Conversation tab
- [x] 7.5 Update the start composer to navigate to `/chat/:project/:chat` and show setup progress from the chat's step
- [x] 7.6 Stories: chat view (starting, conversation, main checkout), make-task dialog (drafting, drafted, draft failed, with suggestions)

## 8. Web: navigation and lists

- [x] 8.1 Sidebar: the ten most recent chats under Chat, with a needs-you mark, and "Show all" going to a chats list filterable by project
- [x] 8.2 Project page: sections Needs you (chats and tasks), Drafts, Tasks, Ended tasks, Chats, Worktrees; remove manual-task handling from `task-rows.tsx` and `tasks.ts`
- [x] 8.3 Tasks page: tasks only, with a Drafts group
- [x] 8.4 Draft task page: brief, links, plan, Start (opens the New task dialog prefilled and adds variants) and Edit; add "Save as draft" to `new-task-dialog.tsx`
- [x] 8.5 Jira ticket page: a Create draft action next to Start task, with project choice
- [x] 8.6 Secondary checkout pages: the Tasks tab becomes Conversations (chats and tasks); a new conversation starts a chat and opens its view
- [x] 8.7 Conversation tab threads link to chat views for chat sessions; old session-page redirects go to the chat view when no variant owns the session
- [x] 8.8 Created-by chips: "started in opencode" on chats, "from chat" on tasks made from a chat, and worktrees made for a chat link to it (`created-by-chip.tsx`, `activity.ts`)
- [x] 8.9 Notifications and provenance session steps point at the chat view for chat sessions (`shared/notices.ts`, `server/db/provenance.ts`)
- [x] 8.10 Update `web/mocks/fixtures.ts` (chats, a draft, an adopted chat, no manual tasks) and the affected stories and web tests

## 9. Wrap-up

- [x] 9.1 Run `pnpm exec ultracite fix`, typecheck and the full test suite
- [ ] 9.2 Check by hand in the running app: chat in a new worktree → Make task with one extra variant and the spec option; an opencode-started session shows as a chat; a draft from a ticket → Start
- [x] 9.3 Run `graphify update .`
