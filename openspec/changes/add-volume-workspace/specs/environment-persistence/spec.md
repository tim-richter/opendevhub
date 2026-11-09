## MODIFIED Requirements

### Requirement: Environment records

The system SHALL keep an environment row for each project's main environment and for each task environment. Each row SHALL hold its container id, workspace folder, remote user, node, workspace mode (`bind` or `volume`), base image key and ref, container password and relay token. Every environment SHALL reference its project row. A task environment SHALL reference its worktree row, and a main environment SHALL reference none. The system SHALL NOT read or write `state.json`.

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

#### Scenario: Workspace mode recorded

- **WHEN** an environment is created for a project whose workspace mode is `volume`
- **THEN** its row records `volume`, and rows created before the migration read as `bind`
