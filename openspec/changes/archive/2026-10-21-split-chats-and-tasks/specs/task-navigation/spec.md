## MODIFIED Requirements

### Requirement: Conversation tab

The Conversation tab SHALL show the selected variant's session: its pending permission and question cards, its turns with their changes, its subagents, and its usage. It SHALL use the same conversation view as a chat. When other top-level sessions have run in the same directory, the tab SHALL list them as threads, with the variant's own session first. The selected thread SHALL be held in the `thread` search parameter. Each thread that is a chat SHALL link to its chat view, and each that belongs to another task SHALL link to that task. The UI SHALL call sessions "conversations" or "chats", not "sessions".

#### Scenario: Answering a permission

- **WHEN** the variant's session waits for permission to run a command
- **THEN** the Conversation tab shows the permission card and the user can answer it there

#### Scenario: A chat in a task's worktree

- **WHEN** a chat was also started in a task variant's worktree
- **THEN** the Conversation tab lists two threads, the variant's session first, and selecting the second shows it with a link to its chat view

#### Scenario: Removed session

- **WHEN** the selected variant's session is gone from opencode
- **THEN** the Conversation tab says the conversation was removed, and the other tabs still work while the worktree exists

#### Scenario: Task made from a chat

- **WHEN** a task adopted a chat and the user opens its Conversation tab
- **THEN** the tab shows the chat's full history, turns and pending cards

### Requirement: Tasks page

The global Tasks page at `/tasks` SHALL list the tasks of all projects that are not archived, grouped by project, with drafts in their own group. It SHALL be filterable by state and by what needs the user, and SHALL replace the Sessions page. Each entry SHALL link to its task page. Chats SHALL NOT be listed on it.

#### Scenario: Tasks needing the user

- **WHEN** the user opens `/tasks` filtered to what needs them
- **THEN** it lists the tasks whose sessions wait on a permission or question, each linking to its task's Conversation tab

#### Scenario: Chats are not tasks

- **WHEN** the user has three chats and one task in project `app`
- **THEN** `/tasks` lists only the task

#### Scenario: Old sessions link

- **WHEN** the user opens `/sessions?status=running`
- **THEN** they are redirected to `/tasks` with the matching filter

### Requirement: Tasks start inside a project

The New task dialog SHALL always be opened for one project and SHALL NOT offer a project picker. The dashboard SHALL NOT have a New task button. The `n` shortcut and the command palette's New task command SHALL be available only on project pages (the project, its tasks and its worktrees), and SHALL open the dialog for that project. An entry point outside a project that starts or drafts a task (for example from a Jira ticket) SHALL make the user choose the project first. A chat in a project SHALL make a task only through Make task.

#### Scenario: Shortcut on the dashboard

- **WHEN** the user presses `n` on the dashboard
- **THEN** no dialog opens

#### Scenario: Shortcut in a project

- **WHEN** the user presses `n` on a task page of project `app`
- **THEN** the New task dialog opens for `app` and shows no project field

#### Scenario: Start from a Jira ticket

- **WHEN** the user clicks Start task on ticket `APP-42` and chooses project `app`
- **THEN** the New task dialog opens for `app` with the ticket filled in

#### Scenario: Chat does not start a task

- **WHEN** the user picks project `app` on the Chat page and sends a message
- **THEN** a chat starts in `app` and no task is created

### Requirement: Secondary worktree pages

The main checkout and every worktree not created by a task variant SHALL keep a standalone page at `/p/:project/main` or `/p/:project/w/:worktree`, with the tabs Conversations, Changes, Terminal and Runtime. The Conversations tab SHALL list the chats and the tasks whose sessions run in that checkout, each linking to its chat view or task page, and SHALL offer to start a new chat there. A new chat SHALL open its chat view. The project page's Worktrees section SHALL list only these checkouts.

#### Scenario: Pull request checkout

- **WHEN** the user opens a worktree that checked out pull request #38
- **THEN** its page shows Conversations, Changes, Terminal and Runtime, and its Conversations tab lists the chats and tasks run there

#### Scenario: New chat in the main checkout

- **WHEN** the user starts a new chat on the main checkout's page
- **THEN** a chat is created and the browser opens its chat view, with no task created

### Requirement: Old URLs redirect to tasks

The system SHALL redirect, replacing the history entry:

- a worktree page created by a task variant (`/p/:project/w/:worktree` and its tabs) to that task with the variant selected, mapping `review` to `changes` and keeping `terminal` and `runtime`;
- a session page (`/p/:project/{main|w/:worktree}/s/:session`) to the session's task with its variant selected when a variant owns it, with the session as the `thread` when it is not the variant's own session, and otherwise to the session's chat view;
- `/sessions` to `/tasks`.

A session that is neither a variant's nor a known chat yet SHALL redirect to its checkout's page.

#### Scenario: Old review link

- **WHEN** the user opens `/p/x/w/add-login-v2/review`, a worktree variant 2 of task `abc` created
- **THEN** they land on `/p/x/t/abc/changes?v=2`

#### Scenario: Old session link of a task

- **WHEN** the user opens `/p/x/w/add-login-v1/s/ses_1`, the session of variant 1 of task `abc`
- **THEN** they land on `/p/x/t/abc?v=1`

#### Scenario: Old session link of a chat

- **WHEN** the user opens `/p/x/main/s/ses_9`, a chat's session
- **THEN** they land on `/chat/x/c_9`

### Requirement: Project page lists tasks, not sessions

The project page SHALL show the sections Needs you, Drafts, Tasks, Ended tasks, Chats and Worktrees. Needs you SHALL list the tasks and chats waiting on the user, each linking to its Conversation tab or chat view. Chats SHALL list the project's recent chats, each linking to its chat view. Notifications and links built by the server (provenance session steps, notices) SHALL point at the session's task when a variant owns it, and at its chat view otherwise.

#### Scenario: Session started in opencode

- **WHEN** a session was started in opencode in the main checkout
- **THEN** the project page lists it under Chats, and not under Tasks

#### Scenario: Notification for a chat

- **WHEN** the user clicks a notification that a chat's session needs permission
- **THEN** the browser opens that chat's view

#### Scenario: Notification for a task

- **WHEN** the user clicks a notification that a task variant's session needs permission
- **THEN** the browser opens that task on its Conversation tab
