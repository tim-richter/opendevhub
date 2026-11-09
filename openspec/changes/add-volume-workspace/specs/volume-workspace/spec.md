## ADDED Requirements

### Requirement: Workspace mode setting

The system SHALL let a project choose `bind` or `volume` as its workspace mode with `workspace` in the project's `config.json` entry, and SHALL treat a missing or invalid value as `bind`. A `workspace` value in `devcontainer.json` SHALL be ignored.

#### Scenario: Default

- **WHEN** a project's entry has no `workspace`
- **THEN** its environments bind-mount the project folder as before

#### Scenario: Set by the repository

- **WHEN** `devcontainer.json` sets `customizations.opendevhub.workspace` to `volume` and the project's entry has no `workspace`
- **THEN** the project's workspace mode is `bind`

### Requirement: Volume-backed main environment

When a project's workspace mode is `volume`, the system SHALL start its main environment with its workspace mounted from a named Docker volume instead of the project folder. The volume SHALL be named after the environment and SHALL survive stopping and rebuilding the container. The environment SHALL read its devcontainer configuration and build context from the Hub's repository.

#### Scenario: First start

- **WHEN** a `volume` project's main environment starts for the first time
- **THEN** the container's workspace folder is backed by a volume named after the environment, and the project folder is not mounted

#### Scenario: Rebuild keeps the code

- **WHEN** a `volume` environment's container is rebuilt
- **THEN** the new container mounts the same volume and its files are unchanged

### Requirement: Seeding from origin

The system SHALL seed an empty volume workspace by cloning the Hub repository's `origin` inside the container, as a partial clone with the branch the Hub has checked out, using the environment's forwarded credentials. The system SHALL NOT clone into a workspace that already holds a repository. If the repository has no `origin`, the start SHALL fail with a message that says so.

#### Scenario: Clone on first start

- **WHEN** a `volume` environment starts with an empty workspace and the repository has an `origin`
- **THEN** the repository is cloned into the workspace folder inside the container

#### Scenario: Restart

- **WHEN** a `volume` environment restarts and its workspace already holds a repository
- **THEN** no clone runs and the files are untouched

#### Scenario: No origin

- **WHEN** a `volume` project's repository has no `origin`
- **THEN** the start fails with an error naming the missing remote, and no container is left running

### Requirement: Lifecycle commands run after seeding

The system SHALL run the configuration's `onCreateCommand`, `updateContentCommand` and `postCreateCommand` for a `volume` environment only after the workspace has been seeded, and SHALL NOT repeat them on later starts.

#### Scenario: Command sees the code

- **WHEN** a `volume` environment is created and its `onCreateCommand` lists the workspace folder
- **THEN** the cloned files are present when it runs

### Requirement: No host path for volume environments

A `volume` environment's checkout SHALL have no host path. The dashboard SHALL NOT offer actions that need a host path for it and SHALL keep the terminal, in-browser editor and attach entries.

#### Scenario: Open in menu

- **WHEN** the dashboard shows a `volume` environment's open-in menu
- **THEN** it lists no entry that opens a folder on the host

### Requirement: Task environments need bind mode

The system SHALL refuse to start a task environment for a `volume` project and SHALL say that task environments need `bind` mode until volume worktrees are supported. It SHALL NOT fall back to a bind mount.

#### Scenario: Task on a volume project

- **WHEN** a task asks for an environment on a `volume` project
- **THEN** the request fails with that message and no container starts

### Requirement: Volume removal is explicit

The system SHALL NOT remove a `volume` environment's volume when the container is stopped or rebuilt. Removing the environment or its project SHALL require the caller to confirm that uncommitted and unpushed work in the volume will be lost, and SHALL remove the volume with it once confirmed.

#### Scenario: Removal without confirmation

- **WHEN** removal of a `volume` environment is requested without confirmation
- **THEN** it is refused and the volume remains

#### Scenario: Confirmed removal

- **WHEN** removal is requested with confirmation
- **THEN** the container and its volume are removed

### Requirement: Approval gate and the workspace mount

The system SHALL NOT require approval for the workspace mount it sets itself. A `workspaceMount` in the project's `devcontainer.json` SHALL be replaced in `volume` mode, the user SHALL be told, and the value SHALL stay part of the approval surface.

#### Scenario: Own mount

- **WHEN** a `volume` environment starts with a config that sets no `workspaceMount`
- **THEN** no approval is requested for the volume mount

#### Scenario: Config sets a mount

- **WHEN** `devcontainer.json` sets `workspaceMount` and the project is in `volume` mode
- **THEN** the environment uses the volume, logs that the config's mount was replaced, and the config's value is still approved or pending as before

### Requirement: Platform note

The system SHALL allow `volume` mode on any node and SHALL show on a Linux node that it gives no speed-up.

#### Scenario: Linux

- **WHEN** a project on a Linux node is set to `volume`
- **THEN** the settings show a note that bind mounts are already native there
