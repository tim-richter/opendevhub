## ADDED Requirements

### Requirement: Conversations started in a task get a briefing

When a conversation is started in an existing task's variant (the New conversation action, the `/new` command, a spec implementation started in a new conversation, or a review started as a new conversation in the task), the system SHALL attach a task briefing to the new opencode session before the conversation's first prompt is sent. A variant's own first session SHALL NOT get a briefing, since it starts with the task's prompt.

#### Scenario: New conversation from the task sidebar

- **WHEN** the user clicks New conversation in a task whose variant has a session
- **THEN** the new session has the instruction entry `opendevhub-task` holding the task briefing, set before any prompt is sent to it

#### Scenario: New conversation with a first prompt

- **WHEN** the user types `/new fix the failing test` in a task conversation
- **THEN** the briefing is attached to the new session first, and the prompt `fix the failing test` is sent after it

#### Scenario: Starting a task

- **WHEN** the user starts a new task
- **THEN** its variants' first sessions get no briefing entry

### Requirement: Briefing contents

The briefing SHALL be one markdown string built without an LLM, from the task and the variant's checkout, and SHALL contain:

- the task's title and brief, and the linked ticket's key and summary when the task has one;
- the variant's branch, the base it was created from, and the checkout path;
- the commits on the branch since the base (one line each, newest first, at most 30, with a count of any left out), a diffstat against the base, and the checkout's uncommitted changes, each said to be empty when it is;
- for a spec-first task, the change name, the task's phase, the count of checked and total items in the change's `tasks.md`, and the path of the change's folder;
- the titles of the variant's earlier conversations, oldest first.

A section whose data cannot be read SHALL be left out rather than fail the briefing. The briefing SHALL tell the agent it is starting a fresh conversation in an ongoing task and that git and the change folder are the record of earlier work.

#### Scenario: Task with commits

- **WHEN** a conversation is started in a variant whose branch has 3 commits since its base and 2 uncommitted files
- **THEN** the briefing lists the 3 commits newest first, the diffstat against the base, and the 2 uncommitted files

#### Scenario: Spec-first task implementing

- **WHEN** a conversation is started in a spec-first task implementing change `add-export` with 4 of 9 tasks checked
- **THEN** the briefing names `add-export`, the implementing phase, `4/9` tasks done, and the path `openspec/changes/add-export/`

#### Scenario: Git fails

- **WHEN** reading the branch's commits fails
- **THEN** the briefing is still attached, without the commits section

### Requirement: Briefing failure does not block the conversation

If the briefing cannot be built or attached, including when the environment's opencode answers 404 to the instructions route, the system SHALL still start the conversation and send its first prompt, and SHALL log the failure with the session and task ids. The user SHALL NOT see an error for it.

#### Scenario: Older opencode

- **WHEN** a conversation is started in an environment whose opencode answers 404 to `PUT /api/experimental/session/:id/instructions/entries/opendevhub-task`
- **THEN** the conversation opens as before, without a briefing, and a warning is logged

### Requirement: The user sees the briefing

The conversation view SHALL show the session's `opendevhub-task` instruction entry, as opencode holds it, as a collapsed row labelled Task briefing at the start of the transcript. Expanding it SHALL show the briefing text as markdown. A session without the entry, or whose opencode cannot list its entries, SHALL show no such row.

#### Scenario: Reading the briefing

- **WHEN** the user opens a task conversation that was given a briefing
- **THEN** the transcript starts with a collapsed Task briefing row, and expanding it shows the briefing's markdown
