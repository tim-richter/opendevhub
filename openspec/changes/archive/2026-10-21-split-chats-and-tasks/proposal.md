## Why

Chat and Task have merged into one thing that is neither. Every message sent from Chat creates a task: a one-variant task for a new worktree, a **manual** task for a checkout. Every session found in opencode is also wrapped in a manual task. So the Tasks list is full of plain conversations, and a task, which should be opendevhub's opinionated unit of work with a goal, links, variants and a spec flow, looks the same as a quick chat. Users can't tell when to use which. The `manual-tasks` capability exists only to keep up the rule that every session must belong to a task.

## What Changes

- **A chat is a plain opencode conversation in a checkout.** It may be in the main checkout, an existing worktree, or a new worktree that Chat creates. The user controls it as they would in opencode: models, commands, files. It shows the checkout's diff (the branch against its merge base, plus uncommitted changes). It has no goal, links or lifecycle beyond its session existing. **BREAKING**: starting a chat no longer creates a task.
- **A task wraps chats.** A task is owned by opendevhub and is opinionated: a title, a **brief**, optional links (Jira ticket, pull request, OpenSpec change), and one or more variants. **Each variant is a chat.** A variant's Conversation tab and a standalone chat are the same view.
- **Manual tasks are removed.** **BREAKING**: sessions that opendevhub starts outside a task, and sessions found in opencode, become chats. Existing manual tasks are migrated into chats. Sessions opendevhub starts only to generate text (commit messages, briefs) are internal chats and are never listed.
- **Draft tasks.** A task can be created before any agent runs, for example from a Jira ticket, and stays `draft` until the user starts it. Starting it adds its variants.
- **Make task from a chat.** A chat in a worktree gets a **Make task** action. The new task **adopts** the chat as variant 1: the same session, worktree and branch, with nothing copied. A dialog offers an AI-drafted, editable brief, suggested ticket and pull request links, and two options: _write a spec from this conversation_ (runs `opsx-propose` in the same conversation) and _add more variants_ (new worktrees from the base branch, prompted with the brief). Chats in the main checkout can't be made into tasks yet.
- **Navigation.** The sidebar's Chat entry lists recent chats across projects, with a mark on chats that need the user. Chat URLs are keyed by conversation: `/chat/:project/:chat`. The Tasks page and the project's Tasks section list only tasks. Needs you lists both chats and tasks. Checkout pages list the chats and tasks that ran there. This supersedes the "every session belongs to a task" part of task-centric navigation. The task stays the only page for a task's work, but a chat is now a page of its own.

## Capabilities

### New Capabilities

- `chats`: chat records. Covers which sessions are chats, adopting sessions found in opencode, internal chats, a chat's title and removal, the recent chats list in the sidebar, chats on the project and checkout pages, and how a chat is shown inside a task.
- `chat-to-task`: making a task from a chat. Covers the Make task action and dialog, adopting the chat as variant 1, the drafted brief, suggested links, the spec option and extra variants.
- `draft-tasks`: tasks without variants. Covers creating a draft (from the New task dialog or a ticket), the `draft` state, starting it, and how drafts are listed.

### Modified Capabilities

- `chat-tab`: the first message starts a chat, not a task. Chat views are keyed by conversation and link to the chat's task only when one adopted it. Old task-keyed chat URLs redirect.
- `manual-tasks`: all requirements removed, replaced by `chats`.
- `task-navigation`: the Conversation tab's threads link to chats. The Tasks page lists tasks only. Needs you covers chats. Secondary checkout pages start chats. The project page gains a Chats section. Session redirects go to the chat when no task owns the session. The Chat exception in "Tasks start inside a project" goes away.
- `task-persistence`: a task has kind `task` or `review` only. A session belongs to at most one variant. There is a new `draft` state. Variants can be added to an existing task. Chat events are added.
- `provenance-ui`: the manual-task variant of the task page and the "started in opencode" task chip move to chats.
- `ticket-links`: a ticket can be linked to a draft task or to a task made from a chat, not only to one started from the ticket.

## Impact

- **Database**: a new migration adds a `chats` table (one row per chat, keyed by its own id, with the session id once it exists) and moves manual tasks into it. No code writes kind `manual` any more; the column's CHECK is left as it is (see design). `branches`/`worktrees` `created_by = 'manual'` stay; they describe who made the checkout, not a task.
- **Server**: `server/sessions/chat.ts` (start no longer goes through `Tasks`); `server/sessions/reconcile.ts` (adopt into chats); `server/db/tasks.ts` (manual-task paths removed, drafts, add variants); a new `server/db/chats.ts`; `server/tasks/tasks.ts` (`addVariants`, `adoptChat`); text generation (internal chats); `dashboard-api.ts` routes for chats, drafts and Make task.
- **Shared types**: `TaskKind` loses `manual`; `TaskState` gains `draft`; a new `ChatSummary` appears in the project snapshot; `SessionSummary.task` becomes optional by design.
- **Web**: `features/chat/*` (routes by session, Make task), sidebar recent chats (`shell/shell.tsx`), `features/tasks/*` (drop manual handling, draft state, Start), `features/projects/*` (Chats section, Needs you), `features/checkouts/*` (secondary pages list chats), `features/activity/created-by-chip.tsx`, `features/jira/*` (create draft from a ticket), fixtures and stories.
- **Notifications and provenance links** for a chat point at the chat view, not a task.
- The local `opendevhub.db` must run the new migration. Manual-task ids in old events stay as plain text and stop resolving to a task.
