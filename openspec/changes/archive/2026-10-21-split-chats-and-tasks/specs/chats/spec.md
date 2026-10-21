## ADDED Requirements

### Requirement: Sessions are chats unless a variant owns them

Every top-level session in a project's environments SHALL be either a task variant's session or a chat, never both. The system SHALL keep a chat row for each top-level session that no variant records. A chat SHALL have its own id, which its URL uses, so that it exists before its session does. The row SHALL hold the chat id, the session id once it exists, project, environment, directory, the branch and worktree when the directory is a worktree, its origin (`hub`, `opencode` or `internal`), its title, and when it was created. Subagent sessions SHALL NOT be chats.

#### Scenario: Conversation started from Chat

- **WHEN** the user starts a chat in the main checkout of `shop`
- **THEN** a chat row with origin `hub` exists for the new session, and no task is created

#### Scenario: Subagents

- **WHEN** a chat's session spawns subagent sessions
- **THEN** only the top-level session has a chat row

#### Scenario: Variant session

- **WHEN** a task variant creates its session
- **THEN** that session has no chat row

### Requirement: Chats opendevhub starts

When opendevhub creates a session outside a task, it SHALL record the chat row before it reconciles the environment. This applies to a chat from the Chat page, a new conversation on a checkout page, a new worktree started with a conversation, and `/new` in a chat. A session created only to generate text SHALL be recorded with origin `internal`.

#### Scenario: New worktree with a conversation

- **WHEN** the user creates worktree `feature/login` from Chat
- **THEN** the chat row records branch `feature/login` and the worktree's directory

#### Scenario: Generated text

- **WHEN** opendevhub creates a session to draft a commit message
- **THEN** that session has a chat row with origin `internal`

### Requirement: Adopting sessions created elsewhere

When reconcile lists a top-level session that has neither a variant nor a chat row, the system SHALL record it as a chat with origin `opencode` and the session's creation time. While opendevhub is creating a session in a directory, for a variant or a chat, reconcile SHALL NOT adopt unknown sessions in that directory. It SHALL leave them for a later reconcile.

#### Scenario: Session started in opencode directly

- **WHEN** the user creates a session in an environment's opencode outside opendevhub and the environment is reconciled
- **THEN** the session is a chat with origin `opencode`

#### Scenario: Variant session listed while it is being created

- **WHEN** reconcile lists a new session in a directory where a variant is creating its session, before the variant has recorded the session id
- **THEN** no chat row is created for it, and once the variant records the session id it belongs to that variant

### Requirement: Chat titles and removal

A chat's title SHALL follow its session's title on each reconcile. A chat SHALL be marked removed when a successful listing of its environment no longer includes its session, and unmarked when the session is listed again. The user SHALL be able to archive a chat, which hides it from every list and leaves its session as it is. A chat SHALL have no other lifecycle state. If a listing fails, no chat SHALL be marked removed.

#### Scenario: opencode renames the session

- **WHEN** opencode retitles a chat's session after its first turn
- **THEN** the chat shows the new title after the next reconcile

#### Scenario: Session deleted

- **WHEN** a chat's session is deleted and its environment is listed again
- **THEN** the chat is marked removed and is no longer listed as a recent chat

#### Scenario: Archiving a chat

- **WHEN** the user archives a chat whose session is still live
- **THEN** the chat leaves the sidebar and the project page, and its session keeps running

### Requirement: Chats in the snapshot

Each project in the dashboard snapshot SHALL list its chats that are not internal, archived or removed. Each chat SHALL have its session id, title, origin, environment, directory, branch, creation time, last activity, status and pending items, and the task that adopted it, if one did.

#### Scenario: Internal chats hidden

- **WHEN** opendevhub generated a commit message in an internal chat
- **THEN** the snapshot does not list that chat

#### Scenario: Adopted chat

- **WHEN** a task adopted a chat as its variant 1
- **THEN** the snapshot lists the session as that task's variant and no longer as a chat

### Requirement: Recent chats in the sidebar

The sidebar's Chat entry SHALL list the most recently active chats across all projects, newest first, up to ten. Each SHALL show its title and project. A chat waiting on a permission or question SHALL be marked. Each entry SHALL open its chat view. A "Show all" link SHALL open a list of every chat, filterable by project.

#### Scenario: Chat needs the user

- **WHEN** a chat's session waits for permission to run a command
- **THEN** its entry in the sidebar is marked, and clicking it opens the chat view with the permission card

#### Scenario: More than ten chats

- **WHEN** the user has twelve chats
- **THEN** the sidebar lists the ten most recently active and a "Show all" link

### Requirement: Chat diff

A chat view SHALL offer a Changes panel showing its checkout's changes: for a worktree, the branch's commits against its merge base with the base branch, plus uncommitted changes; for the main checkout, uncommitted changes. It SHALL use the same review view as a task's Changes tab, including publishing.

#### Scenario: Chat in a worktree

- **WHEN** the user opens Changes in a chat in worktree `dark-mode` with two commits and one modified file
- **THEN** the panel shows the two commits' changes and the modified file against the base branch
