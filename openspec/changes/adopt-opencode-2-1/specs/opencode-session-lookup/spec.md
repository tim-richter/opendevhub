## ADDED Requirements

### Requirement: Looking up one session

When opendevhub needs to know whether one opencode session exists, or to read it, it SHALL ask opencode for that session by id and SHALL NOT search the session list for it. Only a 404 SHALL mean the session is gone. Any other failure SHALL count as "unknown", not as removed.

#### Scenario: Old conversation still exists

- **WHEN** cleanup deletes an archived chat whose session is older than the newest 50 sessions in its environment
- **THEN** opendevhub finds the session by id, deletes it, and reports it as removed

#### Scenario: Session already deleted

- **WHEN** cleanup deletes an archived chat whose session opencode answers 404 for
- **THEN** cleanup reports it as removed without calling delete

#### Scenario: opencode unreachable

- **WHEN** the session lookup times out
- **THEN** cleanup reports the item as skipped with the error, and doesn't report it as removed

### Requirement: Running check without the full list

Before deleting a conversation, cleanup SHALL skip it while the conversation, or any of its subagent sessions, is running or waiting on the user. A running session's root SHALL be found by following `parentID` with single lookups, so it is found even when the root is outside the newest 50 sessions.

#### Scenario: Subagent of an old conversation running

- **WHEN** a subagent session is active and its root is an archived chat's session outside the newest 50
- **THEN** cleanup skips the chat with "its conversation is still running"

### Requirement: Reading every session

Code that has to consider every session in an environment, such as finding stale sessions for cleanup, SHALL follow opencode's list cursor until there is no next page, up to a cap of 2000 sessions. Reaching the cap SHALL be logged. The status monitor MAY keep reading only the newest page, since it already looks up missing sessions it needs one by one.

#### Scenario: Many sessions

- **WHEN** an environment has 120 sessions and cleanup scans for stale ones
- **THEN** all 120 are considered, not just the newest 50
