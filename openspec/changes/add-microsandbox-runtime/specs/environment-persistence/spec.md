## MODIFIED Requirements

### Requirement: Environment records

The system SHALL keep an environment row for each project's main environment and for each task environment. Each row SHALL hold its runtime, container id, workspace folder, remote user, node, base image key and ref, container password and relay token. The runtime SHALL be `devcontainer` or `microsandbox` and SHALL be set when the row is created. The container id SHALL hold the runtime's own handle for the environment: a Docker container id for `devcontainer`, a sandbox name for `microsandbox`. Rows created before this field existed SHALL have the runtime `devcontainer`. Every environment SHALL reference its project row. A task environment SHALL reference its worktree row, and a main environment SHALL reference none. The system SHALL NOT read or write `state.json`.

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

#### Scenario: Sandbox recorded

- **WHEN** a task environment of a `microsandbox` project is created
- **THEN** its row records the runtime `microsandbox` and the sandbox's name as its container id

#### Scenario: Existing rows after upgrade

- **WHEN** opendevhub upgrades a database with environment rows
- **THEN** those rows have the runtime `devcontainer`
