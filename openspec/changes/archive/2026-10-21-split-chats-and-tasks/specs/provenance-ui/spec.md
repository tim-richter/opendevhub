## MODIFIED Requirements

### Requirement: Task hub page

The task page SHALL show, across its header and tabs:

- in the header: the task's title, kind, state, ticket, status, pull requests and the reviews of them, or, for a review task, its reviews;
- the selected variant's session (Conversation), worktree changes (Changes), terminal and runtime;
- on Compare: each variant with its model, state, cost, tokens, branch, worktree, environment, session and pull request;
- on Spec: the spec chain, linking to the proposing and implementing tasks;
- the task's activity, from its header's Activity button.

For a task with one variant, it SHALL show the same page with no variant switcher and no Compare tab. For a draft, it SHALL show the brief, links and plan instead of the tabs.

#### Scenario: Multi-variant task

- **WHEN** the user opens a task with three variants, one of them published, and switches to Compare
- **THEN** the tab lists the three variants with their branches and sessions, the published one with its pull request

#### Scenario: Spec chain

- **WHEN** the user opens the Spec tab of a task that implements a change another task proposed
- **THEN** the tab links to the proposing task

#### Scenario: Task made from a chat

- **WHEN** the user opens a task made from a chat, with no extra variants
- **THEN** the page shows its single conversation, changes, terminal and runtime, without a variant switcher or Compare tab

### Requirement: Created-by chips

The task, chat, worktree, branch and environment lists SHALL show what created each entry: the task and variant, a chat, a manual action, a pull request checkout, or "created outside opendevhub". Each SHALL link to its origin. A chat adopted from opencode SHALL read "started in opencode". A task made from a chat SHALL read "from chat".

#### Scenario: Worktree list

- **WHEN** the checkouts list shows a worktree made by variant 1 of task "Add login"
- **THEN** its chip reads "Add login · variant 1" and links to the task page

#### Scenario: Chat from opencode

- **WHEN** the chats list shows a chat whose session was created in opencode
- **THEN** its chip reads "started in opencode"

#### Scenario: Worktree made for a chat

- **WHEN** the checkouts list shows a worktree created from the Chat page
- **THEN** its chip names the chat and links to its chat view
