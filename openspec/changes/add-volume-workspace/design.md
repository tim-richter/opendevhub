## Context

`Containers.up` runs `devcontainer up --workspace-folder <path> --id-label … [--override-config …]` and reads the workspace folder from the CLI's output, falling back to `/workspaces/<basename>`. The path is a host path: the CLI reads `devcontainer.json` from it and bind-mounts it. `Environments.bringUp` (main) and `bringUpTask` both build on this, and `readAndCheck` reads the config from `env.worktree?.hostPath ?? env.project.path` for the approval gate. Remote Nodes already keep their repository where the Hub can't see it (`NodeRepo`, "Bring home"), and `worktrees.ts` only sets `hostPath` when the root is mounted, so a missing host path is already a valid state in the types.

## Goals / Non-Goals

**Goals:**

- A main Environment whose code lives in a Docker volume, started from the same `devcontainer.json`.
- No change for `bind` projects.
- No silent data loss: removing the volume is explicit.

**Non-Goals (this change):**

- Task Environments, worktrees and Bring home for `volume` projects (phase 2).
- VS Code attach, and seeding by push for repositories without `origin` (phase 3).
- Replacing bind mounts, or speeding them up.
- Remote Nodes: they work on a node-local copy already and gain little.

## Decisions

### 1. A setting in `config.json`, recorded per environment

`workspace: "bind" | "volume"` is read from the project's `config.json` entry only (`resolveEnvSettings`, like `sshAgent`). A repository shouldn't decide where your code lives on your machine. The environment row records the mode it was created with (migration, default `bind`). Changing the setting doesn't convert a running environment: the dashboard shows that the environment must be removed and recreated, because the two modes hold different copies of the code.

_Alternative:_ `customizations.opendevhub.workspace` in `devcontainer.json`. Rejected: it's a machine-dependent choice (fast on macOS, no gain on Linux), and a checked-in value would force it on teammates.

### 2. Override config with a volume `workspaceMount`

`up` is given `--override-config` with `workspaceMount: "source=odh-<envId>,target=/workspaces/<name>,type=volume"` and `workspaceFolder: /workspaces/<name>`. `--workspace-folder` still points at the Hub's repository so the CLI finds the config and build context and computes its id labels as today. The override file is written like the existing task override. The volume name equals the environment id, so it is discoverable and removable from the row alone. A volume is not removed by `--remove-existing-container`, so rebuilds keep the code.

_Alternative:_ a temporary container that clones first, as VS Code does, then `up` against the volume. Rejected: a second container and a second code path, with nothing gained since we control the first start.

### 3. Seed with `git clone` inside the container, from `origin`

After `up` and before lifecycle commands, run in the container as the remote user:

`git clone --filter=blob:none <origin> <workspace>` then check out the project's current branch.

`origin` is read from the Hub's repository (`git remote get-url origin`). If it has none, start fails with a message that names the cause, since seeding by push is phase 3. The clone uses the relay's credential and ssh-agent forwarding that `prepareCredentials` already sets up, so connect (route, relay, credentials) must run before the clone, not after. A partial clone keeps the first start tolerable for large repositories. The seed runs once: if `<workspace>/.git` exists, `up` skips it, so restarts and rebuilds never re-clone.

HTTPS remotes use the credentials the relay provides today. An SSH remote needs ssh-agent forwarding enabled for the project (`sshAgent`, on by default). The start error says which is missing.

### 4. Lifecycle commands wait for the seed

The devcontainer CLI runs `onCreateCommand` and friends inside `up`, against an empty folder in volume mode. For `volume` environments `up` runs with `--skip-post-create`, then opendevhub seeds, then runs `devcontainer run-user-commands` once connect has finished. The CLI's own once-only markers still apply, so a restart doesn't repeat `onCreate`.

### 5. Only the main Environment, and `hostPath` stays absent

A `volume` environment's checkout has no `hostPath`. `readAndCheck` already reads from `env.worktree?.hostPath ?? env.project.path`. That is correct for the approval gate in this phase, because the config and build context come from the Hub's repository, but it reads the Hub's copy, not the container's. It is acceptable now and a known limitation: a branch changed inside the container isn't re-read until phase 2. `worktreeMounts` and the task-environment paths are never reached, since task Environments are refused for `volume` projects with a clear message (`UnavailableError`).

### 6. Approval gate

`config-surface.ts` includes `cfg.workspaceMount`. The override's own mount is added after the config is read, so it never enters the surface. If the project's `devcontainer.json` sets `workspaceMount`, `volume` mode replaces it, logs that, and the surface keeps showing the user's value, so editing it still asks for approval.

### 7. Removal and cleanup

Removing a `volume` environment, or the project, requires confirmation that names the volume and says it holds the only copy of uncommitted and unpushed work. The server refuses without `confirmVolumeLoss`. `cleanup-targets.ts` lists the volume and `docker volume rm` runs when the environment is removed. Stopping or rebuilding never removes it. A volume without an environment row is reported by cleanup, not deleted automatically.

### 8. UI

`workspaceFolderOf`/`hostPath` already tolerate its absence. The open-in menu hides every entry that needs a host path when `hostPath` is missing. Project settings gain the `workspace` control, with a note on Linux that it gives no speed-up.

### 9. A cheaper tip, documented

Much of the slowness in monorepos comes from `node_modules`, build output and caches. A project can keep bind mounts and add named volumes for those directories through `mounts` in `devcontainer.json`. The docs mention this as the lighter option before reaching for `volume`.

## Risks / Trade-offs

- [The volume holds the only copy of uncommitted work] → Confirmation on removal, and no automatic cleanup. Showing unpushed commits and uncommitted changes in the dashboard is phase 3.
- [Host tools no longer see the code] → Host editors and host-side git are unavailable. The in-browser editor, terminals and exec stay. Phase 3 adds attach.
- [First start needs network and a reachable `origin`] → Fail early with the cause. Partial clone limits the cost.
- [The approval gate reads the Hub's config, not the container's] → Accepted for phase 1 (decision 5).
- [`--skip-post-create` plus `run-user-commands` changes ordering] → Covered by an e2e test that checks `onCreateCommand` sees the cloned files.
- [Linux: no benefit, and volumes are harder to inspect than a folder] → Allowed but flagged.

## Migration Plan

- The migration defaults all rows to `bind`; nothing changes until a project sets `workspace`.
- Rollback: an older opendevhub refuses the newer schema (`NewerDatabaseError`). Remove `volume` environments first. Their volumes stay in Docker.

## Open Questions

- Should the branch cloned be the Hub's current branch, or the project's default branch? Phase 1 assumes the branch the Hub has checked out.
- Is `devcontainer run-user-commands` reliable enough across CLI versions, or should opendevhub run the lifecycle commands itself?
- Does `devcontainer up` need `--workspace-folder` to exist on a remote Node? Remote `volume` projects are unsupported for now.
