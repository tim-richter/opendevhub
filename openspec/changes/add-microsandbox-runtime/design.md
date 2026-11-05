## Context

Today every environment is created and driven by `Containers` (`environments/containers.ts`). It shells out to the `devcontainer` CLI (`up`, `build`, `exec`, `read-configuration`) and to `docker` (`inspect`, `ps`, `logs`, `stop`, `rm`, `cp`, `volume`, `image`) through the node's `Runner`. The runner runs locally or over SSH on a remote node. `Environments` (`environments.ts`, about 2,600 lines) builds on that. It assumes a Docker container id, the `opendevhub.project` / `opendevhub.env` labels, `docker inspect` state and IP, and that the devcontainer CLI applies features, dotfiles, lifecycle commands and `remoteEnv`.

The host reaches an environment's opencode server and its relay at the container's IP, or through a gateway tunnel for remote nodes. Forwarded ports and the ssh-agent socket go through the relay, with a direct fallback to the container IP (`network/port-forwarder.ts`). The host-affecting part of a config is extracted in `config-surface.ts` and gated by `approvals.ts` (the `config-approval-gate` change).

microsandbox runs OCI images as microVMs (KVM on Linux, Hypervisor.framework on Apple Silicon, WHP on Windows in preview). It is driven by the `msb` CLI or by SDKs (Rust, TypeScript, Python, Go) that run VMs on the calling machine. Its sparse `--conf` YAML (image, cpus, memory, workdir, mounts, network.allow / ports, secrets, scripts) is never auto-discovered. Ports are published on `127.0.0.1` only. It can import `docker save` and OCI layout archives (`msb load`), take disk snapshots and restore them with new mounts, and substitute secrets into outgoing HTTP requests for allowed hosts.

## Goals / Non-Goals

**Goals:**

- One runtime interface that `Environments`, the relay, terminals, checks and editors use instead of `Containers` directly.
- A `microsandbox` runtime that runs typical image- or Dockerfile-based devcontainer projects without the project keeping a second config.
- The same behaviour on local and SSH nodes.
- Stronger defaults where microsandbox allows them: API keys never in the guest, an optional egress allowlist.

**Non-Goals:**

- Docker Compose with microsandbox, and Docker inside a sandbox as a supported feature.
- Attaching VS Code or JetBrains to a sandbox (via SSH into the guest or otherwise). Possible follow-up.
- microsandbox cloud. Local runtimes only.
- Replacing devcontainers or changing their default.
- Windows nodes (microsandbox's Windows support is in preview).

## Decisions

### 1. A runtime interface per node, with Docker specifics kept inside it

`EnvironmentRuntime` gets `up`, `exec` (with stdin, env, streaming, signal), `ptyCommand` (what a terminal spawns), `inspect` (state, started-at, a `reach(port)` address), `listManaged`, `logs`, `stop`, `remove`, `copyIn`, `readConfig` and `hostSurface`. A runtime is built per node from that node's `Runner`, like `Containers` is today. `Containers` stays as the internal driver of `DevcontainerRuntime`, so its tests and behaviour don't move.

`Environments` keeps the runtime in the in-memory environment next to its container id, and passes `ExecTarget`s that the runtime understands. Image builds (`images.ts`) stay Docker-specific helpers that both runtimes call.

_Alternative:_ a full abstraction, including images and volumes, from the start. Rejected because only the parts the second runtime needs differently are worth abstracting now.

### 2. Drive microsandbox with the `msb` CLI, not the SDK

The TypeScript SDK runs microVMs in the process that calls it. Remote nodes are reached only through the SSH `Runner`, so the SDK could drive only the local node. Using `msb` for every node keeps one code path and matches how `devcontainer` and `docker` are used. Commands use `--json` output where `msb` has it. Interactive terminals use `msb exec --tty` (PTY, resize) through the existing terminal plumbing.

_Alternative:_ the SDK locally and the CLI remotely. Rejected: two implementations of one runtime.

### 3. Translate devcontainer.json instead of adding a sandbox config file

The project's existing `devcontainer.json` (resolved with `devcontainer read-configuration` when the CLI is present, otherwise parsed as JSONC) is turned into a sparse microsandbox config. opendevhub writes it to `~/.opendevhub/sandboxes/<envId>.yaml` on the node and passes it with `--conf`. Translated, refused and ignored keys are listed in the `microsandbox-runtime` spec. Refusing a key such as `runArgs`, rather than dropping it, keeps a config from silently losing a mount or capability it relies on.

Lifecycle commands are run by opendevhub with `exec`, in devcontainer order. Each one runs once per sandbox (`onCreate`, `updateContent`, `postCreate`) or on every start (`postStart`, `postAttach`), and progress is tracked in a marker file in the guest, as the devcontainer CLI does.

_Alternative:_ our own `.opendevhub/sandbox.yaml`. Rejected as the default because every project would have to keep two configs in sync. It stays possible later as an escape hatch.

### 4. Features and Dockerfiles: `devcontainer build`, then `msb load`

`devcontainer build` already produces an image with features applied, the image key and labels opendevhub manages. Piping `docker save <ref>` into `msb load --tag odh/<project>:<imageKey>` reuses all of that. Features contribute metadata (`containerEnv`, `remoteUser`, lifecycle commands, mounts) through the image's `devcontainer.metadata` label. The runtime reads that label and merges it like the CLI does, so feature-provided lifecycle commands still run. Pure `image` configs skip Docker entirely and let `msb` pull.

_Alternatives:_ BuildKit straight to an OCI layout (needs buildkitd and loses features), or a local registry (more moving parts). Neither offers more.

### 5. Reaching guest ports: publish the relay and opencode, everything else through the relay

microsandbox ports are fixed at creation and bound to the node's loopback. When the sandbox is created, the runtime publishes two guest ports: the relay (4097) and the opencode server. Their host ports come from the node's existing port allocator. `reach(port)` returns `127.0.0.1:<host port>` on the node. Local nodes dial it directly, and remote nodes use the existing gateway tunnel. All other forwarded ports and the ssh-agent socket already go through the relay. Their direct fallback is disabled for sandboxes because they have no container IP.

_Alternative:_ the guest's private IP. Not documented as reachable from the host. Rejected.

### 6. Discovery by sandbox name

Sandboxes are named `odh-<envId>` (envIds are at most 63 characters). `listManaged` lists sandboxes with the `odh-` prefix and maps them back to environment rows. If `msb` supports labels when this is implemented, project and environment labels are set as well, matching Docker's.

### 7. Snapshots per project and image key

The first task environment of a project creates the base: a sandbox with no checkout mounted, after `onCreateCommand` and `updateContentCommand`. It is stopped and snapshotted as `odh-<project>-<imageKey>`. Later task environments restore that snapshot with their worktree bind-mounted (`msb snap restore … -v`). Snapshots live next to the images they depend on, and are cleaned up with them in `cleanup-targets.ts`. The main environment is created from the image, not the snapshot, so its `onCreateCommand` sees the checkout as the devcontainer CLI would.

### 8. Secrets and egress

The agent credentials that `credentials.ts` puts into the environment today become `secrets:` entries for microsandbox environments. Each entry is allowed for its provider's hosts, with `value: ${VAR}`, and the value is passed only in the `msb` process's environment, never in the config file or on argv. When `network.allow` is set, the hosts opendevhub needs are added to it: model providers in use, the project's Git remote host, and the relay's own traffic, which is inbound and unaffected.

### 9. Approval surface per runtime

`hostSurface` becomes a runtime method. For `microsandbox` it extracts the bind mounts other than the checkout, published `forwardPorts`, `network.allow` (or `unrestricted`), secret names with their allowed hosts, and the build context and options when a build runs. `runtime` itself is always part of the surface, so switching runtimes needs approval. The gate, the stored approvals and the banner are unchanged.

### 10. Persistence

A new migration appended to `MIGRATIONS` adds `runtime TEXT NOT NULL DEFAULT 'devcontainer' CHECK (runtime IN ('devcontainer','microsandbox'))` to `environments`. Migration 1 is not edited.

## Risks / Trade-offs

- [Bind-mount ownership through virtiofs differs from Docker's UID behaviour] → Set the mount's `uid`/`gid` to the remote user's and use host-permission passthrough. Add an e2e check that a file written in the guest is owned by the checkout's owner on the host.
- [Many cloud VMs used as nodes have no nested virtualization] → Runtime support is per node and shown in the dashboard. Placement never puts a microsandbox project on such a node.
- [Feature metadata merging is reimplemented outside the devcontainer CLI] → Limited to the keys the translation supports. Covered by fixture tests against images built by the real CLI.
- [Memory overhead: one VM per task environment] → Use `hostRequirements.memory` or a modest default. Snapshots keep startup cost low. Document the trade-off.
- [microsandbox's CLI and config format are young and still changing] → Pin a minimum `msb` version in the preflight. Keep all `msb` argument building in one module with tests.
- [Secrets substitution covers HTTP(S) only] → Credentials used over other protocols (such as SSH to Git) keep going through the relay's ssh-agent forwarding, as today.
- [Interactive editors lose container attach] → The in-browser editor and terminals remain, and opening the host folder is still offered. Guest SSH can come in a follow-up change.

## Migration Plan

- The migration defaults all existing rows to `devcontainer`. No project changes behaviour until its config sets `runtime`.
- Rollback: an older opendevhub refuses a database with a newer schema (`NewerDatabaseError`). Users downgrading must remove microsandbox environments first. Devcontainer environments are unaffected.

## Open Questions

- Does `msb` support labels or metadata on sandboxes, or only names? This decides how discovery works (decision 6).
- Which `msb` command reports microVM support without starting a VM, for the preflight? Otherwise the preflight runs a tiny VM once and caches the result per node.
- Can a published port be added to a running sandbox? If so, the opencode port doesn't need to be fixed at creation.
- Does `msb exec` support a working directory and user per call, or do we wrap commands in `su`/`cd`?
