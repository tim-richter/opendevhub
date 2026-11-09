## Why

Every environment bind-mounts the project folder into its container (`devcontainer up --workspace-folder <host path>`). On macOS and Windows that mount crosses Docker Desktop's VM boundary, so git, installs and file watchers in a large monorepo are slow. A Docker named volume lives inside the VM's own disk and runs at native speed. VS Code offers the same trade as "Clone Repository in Container Volume". Offering it as an opt-in workspace mode fixes the slowness for projects that can work entirely in the container, and it costs nobody else anything.

## What Changes

- **Per-project workspace mode.** `workspace` in the project's `config.json` entry selects `bind` (default, today's behaviour) or `volume`. It is set in `config.json` alone, like `sshAgent`: where the code lives is a choice about your machine, so a repository's `devcontainer.json` can't force it.
- **Volume provisioning (main Environment).** For a `volume` project, `devcontainer up` runs with an override config whose `workspaceMount` is a named volume `odh-<envId>` mounted at `/workspaces/<name>`. The devcontainer config and build context are still read from the Hub's repository. After `up`, the repository is cloned inside the container from `origin` with `--filter=blob:none`, using the existing credential relay and ssh-agent forwarding.
- **Lifecycle after seeding.** `onCreateCommand`, `updateContentCommand` and `postCreateCommand` run once the clone has landed, not against an empty folder. The first start of a `volume` environment is therefore split into `up`, clone, lifecycle.
- **No host path.** A `volume` environment has no `hostPath`. The dashboard hides the host-folder entries of "Open in" and shows the terminal, in-browser editor and attach entries.
- **Guarded deletion.** Removing a `volume` environment, or the project, says that the volume holds the only copy of uncommitted and unpushed work and asks for confirmation. Cleanup removes the volume with the environment.
- **Approval gate.** The override's own `workspaceMount` is not a host-affecting setting and doesn't ask for approval. A `workspaceMount` in the project's `devcontainer.json` is replaced in `volume` mode and the user is told.
- **Persistence.** A new migration adds `workspace TEXT NOT NULL DEFAULT 'bind' CHECK (workspace IN ('bind','volume'))` to `environments`, recording what each environment was created with.
- **Platform.** Aimed at Docker Desktop. On a Linux node the setting is allowed but flagged as giving no speed-up.
- **Fix:** `Containers.up` falls back to `/workspaces/<basename of the host path>` when the CLI's output has no workspace folder. In `volume` mode that guess must come from the mount target instead.
- **Out of scope for this change** (later phases): task Environments and worktrees inside the volume, and Bring home (phase 2); VS Code attach, and seeding by push for repositories with no `origin` (phase 3). A `volume` project can't start task Environments until phase 2. The dashboard says so rather than falling back to bind mounts.

## Capabilities

### New Capabilities

- `volume-workspace`: the `workspace` setting, how a volume-backed main Environment is provisioned and seeded, what changes in the dashboard, removal safeguards and the approval-gate rules.

### Modified Capabilities

- `environment-persistence`: environment rows record their workspace mode.

## Impact

- **Code:** `environments/containers.ts` (`up`, override config, workspace fallback), `environments/environments.ts` (`bringUp`, `readAndCheck` and other `hostPath ?? project.path` readers, removal), `environments/config.ts` (`workspace` setting), `environments/config-surface.ts`, `git/cleanup-targets.ts`, `environments/editors.ts`, the dashboard's open-in menu and project settings, `db/migrations.ts` (new migration appended).
- **Dependencies:** none. It uses the `devcontainer` and `docker` CLIs as today.
- **Users:** no change for existing projects. `workspace` defaults to `bind`.
