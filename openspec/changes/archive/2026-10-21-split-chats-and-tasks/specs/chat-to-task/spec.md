## ADDED Requirements

### Requirement: Make task action

A chat view SHALL offer a Make task action when the chat's checkout is a worktree, the chat isn't internal, its session exists, and no task has adopted it. For a chat in the main checkout, the action SHALL be disabled and say that only chats in a worktree can become tasks.

#### Scenario: Chat in a worktree

- **WHEN** the user opens a chat in worktree `dark-mode`
- **THEN** the header offers Make task

#### Scenario: Chat in the main checkout

- **WHEN** the user opens a chat in the main checkout
- **THEN** Make task is disabled and says only chats in a worktree can become tasks

### Requirement: Make task dialog

Make task SHALL open a dialog with: the title, filled with the chat's title; the brief; a ticket field; a pull request field; an option to write a spec from the conversation; and a number of extra variants, with model and agent for each, defaulting to none. While the dialog is open, the system SHALL draft the brief from the chat's session context without adding to its history, and fill the field when the draft arrives unless the user has already typed in it. The ticket field SHALL suggest the Jira keys found in the branch name and the conversation. The pull request field SHALL suggest a pull request whose head is the chat's branch.

#### Scenario: Brief drafted

- **WHEN** the user opens Make task in a chat about adding a dark mode toggle
- **THEN** the brief field fills with a drafted summary of the goal, decisions and open points, and the chat's transcript gains no message

#### Scenario: User typed first

- **WHEN** the user types in the brief before the draft arrives
- **THEN** the draft does not replace the typed text

#### Scenario: Ticket suggested from branch

- **WHEN** the chat's branch is `APP-42-dark-mode`
- **THEN** the ticket field suggests `APP-42`

#### Scenario: Draft fails

- **WHEN** the brief cannot be drafted
- **THEN** the field stays editable and empty, says the draft failed, and the user can still make the task

### Requirement: Task adopts the chat

Confirming Make task SHALL create a task of kind `task` with the given title, the brief as its prompt, and the chosen links. Its variant 1 SHALL record the chat's session, environment, directory, branch, worktree, the model of the chat's latest turn, and step `session`. In the same transaction, the chat row SHALL record the task that adopted it and stop being listed as a chat. Nothing SHALL be sent to the session. The browser SHALL then open the task's Conversation tab. Opening the old chat view SHALL redirect to the task with variant 1 selected.

#### Scenario: Plain conversion

- **WHEN** the user makes a task "Dark mode" from a chat in worktree `dark-mode` with no options
- **THEN** a running task "Dark mode" exists with one variant whose session is the chat's session, and the Conversation tab shows the chat's full history

#### Scenario: Old chat link

- **WHEN** the user opens the chat view of a chat that a task adopted
- **THEN** the browser is redirected to that task with variant 1 selected

#### Scenario: Chat adopted twice

- **WHEN** two Make task requests for the same chat arrive
- **THEN** one creates the task and the other is rejected because the chat already belongs to a task

### Requirement: Spec from the conversation

When _write a spec from this conversation_ is chosen, the task SHALL be spec-first, variant 1 SHALL record spec phase `propose`, and the system SHALL run `opsx-propose` in the adopted session with the brief as its arguments.

#### Scenario: Spec option

- **WHEN** the user makes a task with the spec option
- **THEN** the adopted conversation runs `opsx-propose` with the brief, and the task page shows a Spec tab

### Requirement: Extra variants from the brief

Each extra variant SHALL be added to the task as variant 2 onwards and set up as a new task variant: a new worktree from the base branch of the chat's branch, its own session, and the brief as its first prompt, or `opsx-propose` with the brief when the spec option is chosen. A failing extra variant SHALL NOT undo the adoption.

#### Scenario: Two extra variants

- **WHEN** the user makes a task with two extra variants on different models
- **THEN** the task has variants 1 to 3: variant 1 is the adopted chat, and variants 2 and 3 start in new worktrees with the brief

#### Scenario: Extra variant fails

- **WHEN** an extra variant's worktree cannot be created
- **THEN** that variant records step `failed`, and the task and variant 1 are kept

### Requirement: Conversion is recorded

Making a task from a chat SHALL record a `chat.adopted` event with the session id and the new task's id, in the same transaction as the adoption, with actor `user`.

#### Scenario: Activity after conversion

- **WHEN** the user makes a task from a chat
- **THEN** the task's activity shows that it was made from that chat
