## MODIFIED Requirements

### Requirement: Chat view

The page `/chat/:project/:task` SHALL show the task's conversation full-width, laid out as the conversation transcript: the transcript, the pending permission and question cards, the composer pinned to the bottom, and the side panel rail. The composer SHALL behave as the Conversation tab's composer, including `/new` and `/interrupt`. A single-line header SHALL name the task, the project and the checkout, SHALL show the usage button, and SHALL link to the task page. Until the conversation exists, the view SHALL show how far the variant has got, as the Conversation tab does. A task with more than one variant SHALL show its first variant that was not discarded. When the task or project doesn't exist, the page SHALL say so and link to `/chat`.

#### Scenario: Going to the task's changes

- **WHEN** the user is in a chat whose task works in worktree `dark-mode` and follows the header's task link
- **THEN** the task page opens, where Changes, Terminal and Runtime show `dark-mode`

#### Scenario: Worktree still starting

- **WHEN** the chat view opens while the new worktree's container is starting
- **THEN** the view shows the starting step instead of the conversation, and the conversation replaces it once it starts

#### Scenario: `/new` in a chat

- **WHEN** the user sends `/new` in a chat view
- **THEN** a new conversation starts in the same checkout and the browser opens that conversation's chat view

#### Scenario: Unknown task

- **WHEN** the user opens `/chat/shop/missing`
- **THEN** the page says the chat was not found and links to `/chat`

#### Scenario: Chat after the first message

- **WHEN** the user sent the first message from `/chat` and the conversation has started
- **THEN** the chat view shows that message as a bubble at the top of the transcript and the composer at the bottom, with no usage cards above them
