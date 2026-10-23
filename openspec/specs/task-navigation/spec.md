# task-navigation Specification

## Purpose

How opendevhub organises navigation around tasks: the task page and its tabs, the variant switcher, the Conversation tab that replaces the session page, the Tasks list, secondary worktree pages, and redirects from old URLs.

## Requirements

### Requirement: Task page tabs

The task page at `/p/:project/t/:task` SHALL be where the user works on a task. It SHALL have these tabs:

- Conversation (the default, at the task's path)
- Terminal (`/terminal`)
- Runtime (`/runtime`)
- Spec (`/spec`), for a spec-first task
- Checks (`/checks`), listed only below 768px wide; it holds the status rail's content

The task's changes SHALL be shown in the status rail's Changes section and reviewed on the task's Review page (`/review`); the task page SHALL have no Changes tab, and `/changes` SHALL redirect to the Review page, keeping `v`.

Compare (`/compare`) SHALL be a view of a task with two or more active variants, opened from the header's Compare variants button rather than from the tab bar. Every tab, Compare excepted, SHALL show the selected variant's worktree or session. Conversations SHALL be listed in the sidebar, not in the tab bar. The task's header (breadcrumb, title, attention pill, actions) SHALL stay visible above the tabs.

#### Scenario: Single-variant task

- **WHEN** the user opens a task with one variant
- **THEN** the page shows the tabs Conversation, Terminal and Runtime, with no Compare variants button and no variant cards

#### Scenario: Old Changes link

- **WHEN** the user opens `/p/x/t/abc/changes?v=2`
- **THEN** they land on `/p/x/t/abc/review?v=2`

#### Scenario: Spec-first task

- **WHEN** the user opens a task that started with `opsx-propose`
- **THEN** a Spec tab shows the variant's OpenSpec change

#### Scenario: Opening Compare

- **WHEN** the user clicks Compare variants on a two-variant task
- **THEN** the browser opens `/p/:project/t/:task/compare`, and the tab bar has no Compare tab

#### Scenario: Checks tab off phones

- **WHEN** the user opens `/p/x/t/abc/checks` in a 1280px window
- **THEN** the page shows the checks view, though the tab bar lists no Checks tab

### Requirement: Variant switcher

When a task has two or more active variants, which are variants not discarded, the task page SHALL let the user switch between them:

- as variant cards in the sidebar, from 768px wide
- as a segmented control below 768px

Each SHALL name the variant by number and model. The selected variant SHALL be held in the `v` search parameter. Without `v`, the page SHALL select the picked variant, or else the first variant that was not discarded. Switching variants SHALL keep the current tab and clear `thread`. A task with fewer than two active variants SHALL NOT show the switcher.

#### Scenario: Switching variants on Terminal

- **WHEN** the user is on `/p/x/t/abc/terminal?v=1` and selects variant 2
- **THEN** the URL becomes `/p/x/t/abc/terminal?v=2` and the tab shows variant 2's terminal

#### Scenario: Default variant

- **WHEN** the user opens a three-variant task where variant 3 was picked, without `v`
- **THEN** variant 3 is selected

#### Scenario: Picked task

- **WHEN** a task had two variants and variant 1 was picked, discarding variant 2
- **THEN** the page shows no switcher

### Requirement: Conversation tab

The Conversation tab SHALL show the selected variant's session laid out as the conversation transcript: the transcript, its pending permission and question cards, the composer pinned to the bottom, the usage button, and the side panel rail with its turns and their changes, and its subagents. It SHALL use the same conversation view as a chat. When other top-level sessions have run in the same directory, the tab SHALL list them as threads, with the variant's own session first. The selected thread SHALL be held in the `thread` search parameter. Each thread that is a chat SHALL link to its chat view, and each that belongs to another task SHALL link to that task. The UI SHALL call sessions "conversations" or "chats", not "sessions".

#### Scenario: Answering a permission

- **WHEN** the variant's session waits for permission to run a command
- **THEN** the Conversation tab shows the permission card above the composer and the user can answer it there

#### Scenario: A chat in a task's worktree

- **WHEN** a chat was also started in a task variant's worktree
- **THEN** the Conversation tab lists two threads, the variant's session first, and selecting the second shows it with a link to its chat view

#### Scenario: Removed session

- **WHEN** the selected variant's session is gone from opencode
- **THEN** the Conversation tab says the conversation was removed, and the other tabs still work while the worktree exists

#### Scenario: Task made from a chat

- **WHEN** a task adopted a chat and the user opens its Conversation tab
- **THEN** the tab shows the chat's full history, turns and pending cards

#### Scenario: Same conversation in Chat

- **WHEN** the user opens a chat's view and then a task variant's Conversation tab
- **THEN** both show their conversation the same way: the transcript, the pending cards and the side panels

#### Scenario: Turn changes from the side panel

- **WHEN** the user opens the Turns panel on the Conversation tab and expands the newest turn
- **THEN** the panel shows the files that turn changed, as the turn list did before

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

- a worktree page created by a task variant (`/p/:project/w/:worktree` and its tabs) to that task with the variant selected, mapping `review` to the task's Review page and keeping `terminal` and `runtime`;
- a session page (`/p/:project/{main|w/:worktree}/s/:session`) to the session's task with its variant selected when a variant owns it, with the session as the `thread` when it is not the variant's own session, and otherwise to the session's chat view;
- `/sessions` to `/tasks`.

A session that is neither a variant's nor a known chat yet SHALL redirect to its checkout's page.

#### Scenario: Old review link

- **WHEN** the user opens `/p/x/w/add-login-v2/review`, a worktree variant 2 of task `abc` created
- **THEN** they land on `/p/x/t/abc/review?v=2`

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
