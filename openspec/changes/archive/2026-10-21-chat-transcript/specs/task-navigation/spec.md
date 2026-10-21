## MODIFIED Requirements

### Requirement: Conversation tab

The Conversation tab SHALL show the selected variant's session laid out as the conversation transcript: the transcript, its pending permission and question cards, the composer pinned to the bottom, the usage button, and the side panel rail with its turns and their changes, and its subagents. Besides the Chat view, which shows the same conversation full-width, it SHALL be the only place in the UI that shows a single session in full. When other top-level sessions have run in the same directory, the tab SHALL list them as threads, with the variant's own session first. The selected thread SHALL be held in the `thread` search parameter. Each thread that belongs to another task SHALL link to that task. The UI SHALL call sessions "conversations", not "sessions".

#### Scenario: Answering a permission

- **WHEN** the variant's session waits for permission to run a command
- **THEN** the Conversation tab shows the permission card above the composer and the user can answer it there

#### Scenario: Several conversations in one worktree

- **WHEN** a manual session was also started in a task variant's worktree
- **THEN** the Conversation tab lists two threads, the variant's session first, and selecting the second shows it with a link to its own task

#### Scenario: Removed session

- **WHEN** the selected variant's session is gone from opencode
- **THEN** the Conversation tab says the conversation was removed, and the other tabs still work while the worktree exists

#### Scenario: Same conversation in Chat

- **WHEN** a task was started from Chat and the user opens its Conversation tab
- **THEN** the tab shows the same transcript, pending cards and side panels as its chat view

#### Scenario: Turn changes from the side panel

- **WHEN** the user opens the Turns panel on the Conversation tab and expands the newest turn
- **THEN** the panel shows the files that turn changed, as the turn list did before
