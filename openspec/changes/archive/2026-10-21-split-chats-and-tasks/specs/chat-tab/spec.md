## MODIFIED Requirements

### Requirement: Chat in the sidebar

The sidebar's main navigation SHALL have a Chat entry that opens `/chat`, with the recent chats listed under it. The entry SHALL be marked active on `/chat` and on every chat view under it. Choosing Chat SHALL always open an empty start composer, even when a chat view is open.

#### Scenario: Opening Chat

- **WHEN** the user clicks Chat in the sidebar
- **THEN** the browser opens `/chat` and shows the start composer

#### Scenario: New chat from a chat

- **WHEN** the user is on `/chat/shop/c_1` and clicks Chat
- **THEN** the browser opens `/chat` with an empty composer

### Requirement: Chat view

The page `/chat/:project/:chat` SHALL show the chat's conversation full-width: pending permission and question cards, the turns, and the composer at the bottom. The composer SHALL behave as the Conversation tab's composer, including `/new` and `/interrupt`. A header SHALL name the chat, the project and the checkout, and SHALL offer Changes and Make task. Until the conversation exists, the view SHALL show how far the new worktree has got. When the session belongs to a task variant, the page SHALL redirect to that task with the variant selected. When the chat or project doesn't exist, the page SHALL say so and link to `/chat`. The old path `/chat/:project/:task` SHALL redirect to the task's page.

#### Scenario: Worktree still starting

- **WHEN** the chat view opens while the new worktree's container is starting
- **THEN** the view shows the starting step instead of the conversation, and the conversation replaces it once it starts

#### Scenario: `/new` in a chat

- **WHEN** the user sends `/new` in a chat view
- **THEN** a new chat starts in the same checkout and the browser opens its chat view

#### Scenario: Chat that became a task

- **WHEN** the user opens `/chat/shop/c_1` after a task adopted chat `c_1` as variant 1
- **THEN** the browser opens that task with variant 1 selected

#### Scenario: Unknown chat

- **WHEN** the user opens `/chat/shop/missing`
- **THEN** the page says the chat was not found and links to `/chat`

## REMOVED Requirements

### Requirement: First message starts a task

**Reason**: A chat no longer creates a task. A chat is its own entity, and tasks are made deliberately (New task dialog, a draft, or Make task). **Migration**: Replaced by "First message starts a chat". Use Make task in the chat view to turn a chat into a task.

## ADDED Requirements

### Requirement: First message starts a chat

Sending the first message SHALL start a chat in the chosen checkout. The first message SHALL be handled like a message sent from the Conversation tab's composer: a `/name` of a known opencode command runs that command with the rest as arguments, mentions go along as attachments, and anything else is a prompt.

- For "New worktree", the hub SHALL create a worktree on a branch named from the message, in the project's default environment, start a session there, and send the first message once it exists. No task SHALL be created.
- For the main checkout or an existing worktree, the hub SHALL start a new session in that checkout and send the first message to it.

The session SHALL be recorded as a chat with origin `hub`. After the hub accepts the message, the browser SHALL open `/chat/:project/:chat`, replacing `/chat` in the history. For "New worktree", the hub SHALL answer with the chat id while the worktree is set up, and the chat view SHALL show progress until the session exists. The chosen project SHALL be remembered on this browser as the last chatted-in project.

#### Scenario: Prompt in a new worktree

- **WHEN** the user sends `add a dark mode toggle` with project `shop` and "New worktree"
- **THEN** a worktree is created, the browser opens its chat view, the agent receives the prompt once the session starts, and the Tasks list is unchanged

#### Scenario: Command in the main checkout

- **WHEN** the user sends `/opsx-propose add dark mode` with the main checkout of `shop`
- **THEN** a new chat in the main checkout runs `opsx-propose` with the arguments `add dark mode`, and no task is created

#### Scenario: Start fails

- **WHEN** the worktree cannot be created
- **THEN** the chat view shows the failure and offers to go back to `/chat` with the message kept

#### Scenario: Request rejected

- **WHEN** the hub rejects the start (for example, the chosen directory isn't a checkout of the project)
- **THEN** the start composer stays on `/chat` with the message kept and shows the error
