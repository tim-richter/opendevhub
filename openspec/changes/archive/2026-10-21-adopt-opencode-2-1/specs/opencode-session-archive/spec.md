## ADDED Requirements

### Requirement: Archiving in opencode too

When opendevhub archives a conversation, it SHALL also set the opencode session to archived:

- archiving a chat archives the chat's session
- archiving a task archives every session of the task's variants, including closed and discarded ones
- closing one task conversation archives that session

Subagent sessions SHALL NOT be archived separately; opencode lists them under their parent. Archiving in opendevhub SHALL succeed even when the opencode call fails. The opencode side is best effort.

#### Scenario: Archiving a chat

- **WHEN** the user archives a chat whose environment runs opencode 2.1
- **THEN** opendevhub sends `PATCH /api/session/<id>` with `archived: true`, and opencode's own clients show the session as archived

#### Scenario: opencode call fails

- **WHEN** the user archives a task while its container is stopped
- **THEN** the task is archived in opendevhub right away, and its sessions are archived in opencode once the container runs again

### Requirement: Restoring

Restoring an archived task SHALL unarchive the opencode sessions of its variants that aren't discarded. Sessions of conversations closed on their own, and of discarded variants, SHALL stay archived.

#### Scenario: Restoring a task

- **WHEN** the user restores an archived task with two variants and one closed conversation
- **THEN** the two variants' sessions are unarchived in opencode and the closed conversation's session stays archived

### Requirement: Catching up

For each environment whose opencode reports version 2.1 or later, the monitor SHALL find sessions that opendevhub has archived (an archived chat, an archived task's sessions, a closed conversation) but opencode lists as not archived. It SHALL archive them in opencode, at most once per session per run of opendevhub. Catching up SHALL only ever archive. A live conversation that someone archived in opencode itself SHALL be left archived, since only an explicit restore in opendevhub unarchives. Sessions that opendevhub doesn't track as a chat or task conversation SHALL be left alone.

#### Scenario: Archived while opendevhub was down

- **WHEN** opendevhub restarts and finds an archived chat whose opencode session isn't archived
- **THEN** it archives the session in opencode

#### Scenario: User unarchives in opencode

- **WHEN** someone unarchives an archived chat's session in the opencode TUI
- **THEN** opendevhub archives it again on the next catch-up, and logs that it did

### Requirement: Older opencode

On an environment whose opencode reports a version before 2.1, opendevhub SHALL NOT send archive changes and SHALL NOT show errors about it. Archiving in opendevhub SHALL work as before.

#### Scenario: Live chat archived in opencode

- **WHEN** someone archives a live chat's session in the opencode TUI
- **THEN** opendevhub neither unarchives it nor archives the chat

#### Scenario: opencode 2.0.32

- **WHEN** the user archives a chat in an environment running opencode 2.0.32
- **THEN** the chat is archived in opendevhub and no request is sent to opencode
