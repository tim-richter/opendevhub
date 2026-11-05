## Why

Every environment opendevhub starts is a Docker container that shares the host's kernel. Agents run unreviewed code in those containers, and the agent's API keys sit in their environment. [microsandbox](https://docs.microsandbox.dev) runs OCI images as microVMs, each with its own kernel. It also has a per-sandbox network allowlist and secrets that are substituted into outgoing requests and never enter the guest. Offering it as a second, opt-in runtime gives projects that want it a much stronger boundary. Projects that need the devcontainer ecosystem keep it.

## What Changes

- **Environment runtime seam.** Environment lifecycle (up, exec, inspect, list, stop, remove, logs, copy-in, reach a guest port) goes through a runtime interface instead of calling the `devcontainer` and `docker` CLIs directly. The current code becomes the `devcontainer` runtime, with unchanged behavior.
- **Per-project runtime choice.** `customizations.opendevhub.runtime` in `devcontainer.json`, overridable in the project's `config.json` entry, selects `devcontainer` (default) or `microsandbox`. The choice applies to the project's main environment and to all of its task environments.
- **Translation from devcontainer.json.** For `microsandbox` projects, opendevhub reads the same `devcontainer.json` and maps the subset that fits onto a sandbox: `image`, `workspaceFolder`, `mounts` (bind), `forwardPorts`, `containerEnv` / `remoteEnv`, `remoteUser`, lifecycle commands run inside the guest, and `hostRequirements` for CPU and memory. Settings it can't honour (Docker Compose, `runArgs`, `privileged`, `capAdd`, `securityOpt`, `appPort`) make the start fail with a message that names them. They are never silently ignored.
- **Network allowlist and secrets.** New keys `customizations.opendevhub.microsandbox.network.allow` and `…microsandbox.secrets` are passed through to microsandbox. The agent's API keys are delivered as microsandbox secrets, scoped to their provider's host, instead of as plain environment variables.
- **Images.** An `image` config is pulled by microsandbox. A `build` config or one with features is built with `devcontainer build` as today, then imported with `docker save | msb load`. So Docker is needed to build those images but not to run them.
- **Snapshots for task environments.** A task environment of a `microsandbox` project starts from a snapshot of the project's prepared base when one exists, with its worktree mounted at restore time.
- **Node preflight.** A node is ready for `microsandbox` projects when `msb` is on its PATH and the host can run microVMs (KVM on Linux, Apple Silicon on macOS). Docker stays required only for Dockerfile and feature builds. Nodes report which runtimes they support. A `microsandbox` project is placed only on nodes that support it.
- **Approval surface.** The host-affecting part of a `microsandbox` config (bind mounts, published ports, network allowlist, secret hosts) is gated by the same per-project approval as devcontainer configs.
- **Not supported with microsandbox:** Docker Compose configs, and editors that attach to a container (VS Code's attached-container URI, JetBrains Gateway's Docker target). The dashboard hides those editor entries for `microsandbox` environments. Terminals, the in-browser editor and opencode work as before.

## Capabilities

### New Capabilities

- `environment-runtimes`: the runtime interface, selecting a project's runtime, which node can run which runtime, and the behaviour every runtime must provide (labels and discovery, reattach after restart, reaching opencode and the relay).
- `microsandbox-runtime`: how a `microsandbox` environment is created from `devcontainer.json`, which keys are translated, refused or added, image import, snapshots, secrets and allowlist, its host-affecting approval surface, and what is unavailable.

### Modified Capabilities

- `environment-persistence`: environment rows record the runtime they were created with, and the container id field holds the runtime's own handle (a sandbox name for microsandbox).

## Impact

- **Code:** `apps/opendevhub/src/server/environments/` (`containers.ts` becomes the devcontainer runtime; `environments.ts` stops assuming Docker ids, labels and `docker inspect`; `config.ts`, `config-surface.ts`, `images.ts`, `credentials.ts`, `editors.ts`), `network/relay/runtime.ts` (guest address), `nodes/preflight.ts` and `nodes/registry.ts` (runtime support), `db/migrations.ts` (new migration appended), dashboard editor menu and project settings.
- **Dependencies:** the `msb` CLI on nodes that run microsandbox projects. No new npm dependency: the TypeScript SDK only drives VMs on the machine it runs in, and nodes are reached over SSH, so the CLI is used everywhere.
- **Builds on** the `config-approval-gate` change (`container-config-approval`), whose gate the microsandbox surface reuses.
- **Users:** no change for existing projects. The runtime defaults to `devcontainer`.
