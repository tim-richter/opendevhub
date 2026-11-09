## ADDED Requirements

### Requirement: A checkpoint before each user message

The transcript SHALL show a checkpoint directly above each user message: a divider with a "Restore checkpoint" button. The button SHALL have a tooltip saying that the conversation and the files go back to before this message. The button SHALL be turned off while the session is running, and its tooltip SHALL say to wait for the agent to stop.

#### Scenario: Checkpoints between turns

- **WHEN** a conversation has three user messages
- **THEN** the transcript shows three checkpoints, one above each user message

#### Scenario: Agent at work

- **WHEN** the session is running
- **THEN** every "Restore checkpoint" button is turned off

### Requirement: Restoring a checkpoint

Clicking "Restore checkpoint" SHALL stage a revert at that user message in opencode, and the checkout's files SHALL be changed back with it. That message and every message after it SHALL be hidden from the transcript. When the composer is empty, it SHALL be filled with the restored message's text. When opencode refuses because the session is busy, the view SHALL say the agent is still working and change nothing.

#### Scenario: Rewinding a wrong turn

- **WHEN** the user restores the checkpoint above "now switch everything to Redux"
- **THEN** that message and the agent's replies after it disappear from the transcript, the files the agent changed in those turns go back to how they were, and the composer holds "now switch everything to Redux"

#### Scenario: Composer holds a draft

- **WHEN** the user restores a checkpoint while the composer holds an unsent draft
- **THEN** the draft stays as it is

#### Scenario: Restoring further back

- **WHEN** a revert is staged and the user restores a checkpoint above an earlier message
- **THEN** the staged revert moves back to that message, and redo still returns to the state before the first restore

### Requirement: The staged revert and redo

While a revert is staged, the view SHALL show a bar directly above the composer. The bar SHALL say how many messages are hidden and list the files that were changed back. It SHALL have a "Redo" button. Redo SHALL clear the staged revert, bringing back every hidden message and putting the files back as they were before the first restore. The "Redo" button SHALL be turned off while the session is running. The staged revert SHALL be read from opencode, so it SHALL show after a reload and in every browser.

#### Scenario: Undoing a restore

- **WHEN** a revert is staged and the user clicks "Redo"
- **THEN** the hidden messages are shown again, the files are as they were before the restore, and the bar is gone

#### Scenario: Seen after a reload

- **WHEN** a revert is staged and the user reloads the page
- **THEN** the messages are still hidden and the bar with "Redo" is shown

### Requirement: Sending makes the revert permanent

Sending a message while a revert is staged SHALL make the revert permanent: the hidden messages SHALL be dropped from the conversation, the files SHALL stay as restored, and redo SHALL no longer be offered. The bar SHALL say this before the user sends.

#### Scenario: Trying again differently

- **WHEN** a revert is staged and the user sends "use Zustand instead"
- **THEN** the bar disappears, the hidden messages do not come back, and the agent answers "use Zustand instead" with the files as restored
