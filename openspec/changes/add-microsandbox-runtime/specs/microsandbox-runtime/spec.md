## ADDED Requirements

### Requirement: Sandboxes are created from devcontainer.json

For a `microsandbox` project, the system SHALL create each environment from the checkout's devcontainer config by translating these keys:

- `image`: the sandbox's image;
- `workspaceFolder`: where the checkout is bind-mounted and where commands run (default `/workspaces/<folder name>`);
- `mounts` of type `bind`: bind mounts;
- `forwardPorts`: guest ports the runtime publishes for port forwarding;
- `containerEnv` and `remoteEnv`: the sandbox's environment;
- `remoteUser` / `containerUser`: the user commands and terminals run as;
- `hostRequirements.cpus` and `hostRequirements.memory`: the sandbox's CPUs and memory;
- `onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand` and `postAttachCommand`: run inside the sandbox at the same points of the lifecycle as the devcontainer CLI runs them.

The checkout SHALL be bind-mounted so that files written in the sandbox belong to the host user who owns the checkout.

#### Scenario: Image config

- **WHEN** a `microsandbox` project's config has `image: "mcr.microsoft.com/devcontainers/typescript-node:22"` and `postCreateCommand: "pnpm install"`
- **THEN** a sandbox is created from that image with the checkout at `/workspaces/<folder>`, and `pnpm install` runs in it once after creation

#### Scenario: Files written in the sandbox

- **WHEN** an agent creates a file in the workspace folder of a sandbox
- **THEN** the file appears in the host checkout, owned by the checkout's owner

### Requirement: Unsupported keys stop the start

The system SHALL refuse to create a sandbox from a config that uses a key the `microsandbox` runtime can't honour: `dockerComposeFile`, `runArgs`, `privileged`, `capAdd`, `securityOpt`, `appPort`, `initializeCommand`, and `mounts` of any type other than `bind`. The error SHALL name every such key. Keys without effect on a sandbox, such as `customizations.vscode`, SHALL be ignored.

#### Scenario: Compose config

- **WHEN** a `microsandbox` project's config sets `dockerComposeFile`
- **THEN** the start fails with a message that Docker Compose isn't supported with microsandbox

#### Scenario: Several unsupported keys

- **WHEN** a config sets both `runArgs` and `privileged`
- **THEN** the error names `runArgs` and `privileged`

### Requirement: Built images are imported

When a `microsandbox` project's config has `build` or `features`, or the user has extra features, the system SHALL build its image with `devcontainer build` on the node, as for the `devcontainer` runtime, and import it into microsandbox with `docker save` piped into `msb load`. The imported image SHALL be tagged with the image key, and an image already imported under that key SHALL be reused. Building SHALL require Docker on the node. When it is missing, the start SHALL fail with a message saying that Docker is needed to build this config.

#### Scenario: Dockerfile config

- **WHEN** a `microsandbox` project's config has `build.dockerfile: "Dockerfile"`
- **THEN** the image is built with `devcontainer build`, loaded into microsandbox, and the sandbox is created from it

#### Scenario: Unchanged key files

- **WHEN** a task environment starts and an image with the project's current image key is already loaded on the node
- **THEN** no build or import runs

### Requirement: Task environments start from a snapshot

The system SHALL keep a snapshot per project and image key of a sandbox that has run `onCreateCommand` and `updateContentCommand`, without any checkout mounted. A task environment SHALL be restored from that snapshot when it exists, with its worktree bind-mounted at restore time, and then run the remaining lifecycle commands. When no snapshot exists, the task environment SHALL be created from the image and the snapshot SHALL be made for later ones. A snapshot SHALL be removed when its image key is no longer used.

#### Scenario: Second task environment

- **WHEN** a second task variant of a `microsandbox` project starts after the first one created the snapshot
- **THEN** its sandbox is restored from the snapshot, and `onCreateCommand` doesn't run again

### Requirement: Network allowlist

When `customizations.opendevhub.microsandbox.network.allow` lists hosts, the system SHALL create the sandbox so that it can reach only those hosts. Hosts that opendevhub itself needs from inside the sandbox, such as the agent's model provider and the Git remote, SHALL be added automatically. Without the key, outgoing network access SHALL be unrestricted.

#### Scenario: Allowlisted sandbox

- **WHEN** a config allows `registry.npmjs.org` and an agent in the sandbox requests `example.com`
- **THEN** the request is refused, and requests to `registry.npmjs.org` and the model provider succeed

### Requirement: Credentials are delivered as secrets

In a `microsandbox` environment, the system SHALL deliver the agent's API keys as microsandbox secrets, each allowed only for its provider's hosts, so that the key's value never appears in the guest. Keys listed in `customizations.opendevhub.microsandbox.secrets` SHALL be read from the host environment and delivered the same way, each allowed for the hosts the config lists. A secret whose value is missing on the host SHALL fail the start with a message naming the variable.

#### Scenario: Agent key

- **WHEN** an agent's process in a sandbox reads the variable holding its model provider key
- **THEN** it sees a placeholder, and requests to the provider's host still authenticate

#### Scenario: Missing project secret

- **WHEN** a config lists the secret `NPM_TOKEN` and the host has no `NPM_TOKEN`
- **THEN** the start fails with a message that `NPM_TOKEN` is not set

### Requirement: Host-affecting microsandbox settings need approval

The system SHALL treat these settings of a `microsandbox` config as host-affecting: bind mounts other than the checkout, `forwardPorts`, the network allowlist (including its absence), the secrets and the hosts each is allowed for, and the build context and options when an image is built. They SHALL be gated by the project's container config approval like a devcontainer config's host-affecting settings. A change of runtime SHALL itself need approval.

#### Scenario: New bind mount

- **WHEN** an agent adds a bind mount of `~/.ssh` to a `microsandbox` project's config
- **THEN** the next start waits for the user to approve the change

#### Scenario: Runtime switched to devcontainer

- **WHEN** an agent changes a project's runtime from `microsandbox` to `devcontainer`
- **THEN** the next start waits for approval and shows the runtime change

### Requirement: Editors that attach to containers are unavailable

For a `microsandbox` environment, the dashboard SHALL NOT offer editors that open a Docker container (VS Code's attached-container target, JetBrains Gateway's Docker target). Editors that open the host checkout, the in-browser editor and terminals SHALL stay available.

#### Scenario: Editor menu

- **WHEN** the user opens the editor menu of a `microsandbox` task environment
- **THEN** the attached-container entries are absent and opening the host folder is offered
