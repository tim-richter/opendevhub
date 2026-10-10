## ADDED Requirements

### Requirement: Environment records

The system SHALL keep an environment row for each project's main environment and for each task environment. Each row SHALL hold its container id, workspace folder, remote user, node, base image key and ref, container password and relay token. A task environment SHALL reference its worktree row, and a main environment SHALL reference none.

#### Scenario: Isolated variant

- **WHEN** a task variant gets its own container
- **THEN** a task environment row references the variant's worktree row, and the variant references the environment

#### Scenario: Main container started

- **WHEN** a project's main container starts and gets a container id
- **THEN** the project's main environment row records the container id and workspace folder

#### Scenario: Environment destroyed

- **WHEN** a task environment's container is removed
- **THEN** its row records when it was removed

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

### Requirement: Import from state.json

On the first start after the upgrade, the system SHALL import every project runtime and environment from `state.json` in one transaction. A task environment SHALL be matched to the live worktree row at its path, or else to a new worktree row for that path marked unmanaged. The import SHALL run only once.

#### Scenario: Upgrade with running containers

- **WHEN** opendevhub starts for the first time after the upgrade and `state.json` lists a project runtime and two task environments
- **THEN** the database has a main environment and two task environments with the same container ids, and opendevhub reattaches to those containers

#### Scenario: Import runs once

- **WHEN** opendevhub restarts after the import
- **THEN** `state.json` is not imported again

### Requirement: Export to state.json for rollback

For one minor release, whenever an environment row changes, the system SHALL write `state.json` from the database in its existing format, with mode 0600.

#### Scenario: Rollback after creating an environment

- **WHEN** a task environment is created after the upgrade and the user then starts an older opendevhub
- **THEN** the older build finds that environment in `state.json`

### Requirement: Nodes CLI checks the database

`opendevhub nodes remove <id>` SHALL refuse to remove a node while environment rows that are not marked removed still reference it.

#### Scenario: Node still in use

- **WHEN** the user removes node `builder` while a task environment runs on it
- **THEN** the command fails and says how many environments use `builder`
