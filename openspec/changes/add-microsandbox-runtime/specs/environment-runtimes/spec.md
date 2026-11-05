## ADDED Requirements

### Requirement: Environments run on a runtime

The system SHALL start, run commands in, inspect, list, stop and remove every environment through a runtime. Two runtimes SHALL exist: `devcontainer`, which behaves as environments did before this change, and `microsandbox`. No code outside a runtime SHALL call the `devcontainer`, `docker` or `msb` CLIs to act on an environment.

#### Scenario: Existing project is unchanged

- **WHEN** a project whose config names no runtime starts its main environment
- **THEN** it starts with the `devcontainer` runtime, with the same CLI calls, labels and mounts as before

#### Scenario: Terminal in a microsandbox environment

- **WHEN** the user opens a terminal in an environment of a `microsandbox` project
- **THEN** the shell runs inside the sandbox through the `microsandbox` runtime

### Requirement: A project selects its runtime

The system SHALL read a project's runtime from `customizations.opendevhub.runtime` in its devcontainer config, with the project's `config.json` entry taking precedence. Accepted values SHALL be `devcontainer` and `microsandbox`, and the default SHALL be `devcontainer`. An unknown value SHALL fail the start with a message naming it. A project's main environment and all of its task environments SHALL use the same runtime.

#### Scenario: config.json overrides the repository

- **WHEN** `devcontainer.json` sets `runtime: "microsandbox"` and the project's `config.json` entry sets `runtime: "devcontainer"`
- **THEN** the project's environments start with the `devcontainer` runtime

#### Scenario: Unknown runtime

- **WHEN** a project's config sets `runtime: "firecracker"`
- **THEN** the start fails with a message that `firecracker` is not a known runtime

### Requirement: Changing a project's runtime

When a project's resolved runtime differs from the runtime its existing environment was created with, the system SHALL NOT reuse that environment. Starting it SHALL fail with a message that a rebuild is needed. A rebuild SHALL remove the old environment through its original runtime and create a new one with the new runtime.

#### Scenario: Switch to microsandbox

- **WHEN** a project with a running devcontainer changes its runtime to `microsandbox` and the user rebuilds it
- **THEN** the old container is removed with the `devcontainer` runtime and a sandbox is created with the `microsandbox` runtime

#### Scenario: Start without rebuild

- **WHEN** a project's runtime changed and the user starts its existing environment
- **THEN** the start fails with a message asking for a rebuild

### Requirement: Nodes report the runtimes they can run

The system SHALL check each node for each runtime separately. A node SHALL support `devcontainer` when Docker and the devcontainer CLI are reachable, as today. It SHALL support `microsandbox` when `msb` is on the PATH of a non-interactive shell and `msb` reports that the host can run microVMs. A node SHALL be usable when it supports at least one runtime. The system SHALL place an environment only on a node that supports its project's runtime. The dashboard SHALL show which runtimes each node supports, and why a runtime is missing.

#### Scenario: Node without KVM

- **WHEN** a Linux node has Docker but no `/dev/kvm`
- **THEN** it supports `devcontainer` only, and the dashboard says microVMs can't run there

#### Scenario: Microsandbox project on an unsupported node

- **WHEN** a task variant of a `microsandbox` project is assigned to a node that doesn't support `microsandbox`
- **THEN** the variant fails before any environment is created, naming the node and the missing runtime

#### Scenario: Node with only msb

- **WHEN** a node has `msb` with working microVM support but no Docker
- **THEN** it is usable for `microsandbox` projects whose config needs no image build

### Requirement: Runtimes find their environments after a restart

Every runtime SHALL tag the environments it creates with their project and environment id, and SHALL list the environments it manages on a node by those tags. After opendevhub restarts, the system SHALL reattach to a running environment through the runtime recorded in its row.

#### Scenario: Restart with a running sandbox

- **WHEN** opendevhub restarts while a task environment of a `microsandbox` project is running
- **THEN** it finds the sandbox through the `microsandbox` runtime and reattaches opencode and the relay

### Requirement: Runtimes expose guest ports to the host

Every runtime SHALL give the host an address for a port inside the environment: for the opencode server, the relay and forwarded ports. The rest of the system SHALL use only that address and SHALL NOT assume the environment has an IP address reachable from the host.

#### Scenario: Relay in a sandbox

- **WHEN** the relay starts in a `microsandbox` environment
- **THEN** the host reaches it through a port the runtime published on the node's loopback, or through the node's gateway tunnel for a remote node
