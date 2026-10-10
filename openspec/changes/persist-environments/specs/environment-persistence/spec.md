## ADDED Requirements

### Requirement: Environment records

The system SHALL keep an environment row for each project's main environment and for each task environment. Each row SHALL hold its container id, workspace folder, remote user, node, base image key and ref, container password and relay token. Every environment SHALL reference its project row. A task environment SHALL reference its worktree row, and a main environment SHALL reference none. The system SHALL NOT read or write `state.json`.

#### Scenario: Isolated variant

- **WHEN** a task variant gets its own container
- **THEN** a task environment row references the variant's worktree row, and the variant references the environment

#### Scenario: Main container started

- **WHEN** a project's main container starts and gets a container id
- **THEN** the project's main environment row records the container id and workspace folder

#### Scenario: Environment destroyed

- **WHEN** a task environment's container is removed
- **THEN** its row records when it was removed

#### Scenario: Restart reattaches from the database

- **WHEN** opendevhub restarts while a task environment's container is running
- **THEN** it finds the container through the environment row and reattaches to it

### Requirement: Only durable runtime fields are stored

The system SHALL store only the container id, password, workspace folder, relay token and remote user from an environment's runtime. Container state, ports and opencode health SHALL stay in memory.

#### Scenario: Port forwarding changes

- **WHEN** an environment's forwarded ports change
- **THEN** the database is not written

#### Scenario: Container id changes

- **WHEN** an environment's container is recreated with a new id
- **THEN** its row records the new container id

### Requirement: Secrets are not exposed

The database file SHALL be readable only by its owner. Container passwords and relay tokens SHALL NOT appear in the dashboard snapshot or in any API response.

#### Scenario: Snapshot

- **WHEN** the dashboard snapshot is built
- **THEN** no environment's runtime has a password or relay token

### Requirement: Environment changes are recorded as events

The system SHALL append an event when an environment row is created or marked removed, in the same transaction as the change. A task environment's event SHALL carry the task of the variant it was created for. Changes to runtime fields, such as a new container id, SHALL NOT be recorded as events.

#### Scenario: Isolated variant gets a container

- **WHEN** a task variant's own environment is created
- **THEN** an `environment.created` event with that task's id is recorded

#### Scenario: Container recreated

- **WHEN** an environment's container is recreated with a new id
- **THEN** no event is recorded

### Requirement: Nodes CLI checks the database

`opendevhub nodes remove <id>` SHALL refuse to remove a node while environment rows that are not marked removed still reference it.

#### Scenario: Node still in use

- **WHEN** the user removes node `builder` while a task environment runs on it
- **THEN** the command fails and says how many environments use `builder`
