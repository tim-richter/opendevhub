# Per-task environments

Date: 2026-10-03
Status: Draft for review
Depends on: nothing

## Problem

Today every project gets one devcontainer, and all of its sessions and worktrees share it.
Parallel agents therefore share:

- the process table, ports and dev servers
- databases and caches
- `$HOME`, global installs and anything outside the workspace

Two agents running `npm run dev` collide. An agent that kills a process, drops a database or
breaks the toolchain breaks every other task in the project. And a branch that changes
`.devcontainer/` can't run in the environment it describes.

The goal is an opt-in mode with one devcontainer per task (worktree). It must start in seconds
when the image is already built, and you must be able to rebuild a single task's container
without touching the others.

## Verdict

**Feasible.** It works with the stock devcontainer CLI, through `--override-config`, pinning
the image and taking a "prebuild" snapshot, with no fork. **Needed?** For projects that run
services (dev servers, databases, queues) or let agents run with broad permissions: yes,
because that's where shared state actually bites. For libraries and small repos, the shared
container is cheaper and fine. So the mode is per project, defaults to `shared`, and can be
overridden per task.

### Measurements

Measured with devcontainer CLI 0.89.0 and Docker 29.6 on Linux. The toy repo has a Dockerfile
build step that takes 8 s and an `onCreateCommand` that takes 3 s.

| Path | Time |
| --- | --- |
| Cold `up` of the main checkout (build + all lifecycle commands) | 12.9 s |
| `up` of a worktree, image from BuildKit's cache, all lifecycle commands again | 4.7 s |
| `docker commit` of the prebuilt container | 0.26 s |
| **`up` of a worktree from the warm snapshot (only `postCreate`/`postStart` run)** | **1.6 s** |
| Restart of a stopped task container | 0.84 s |

In real projects the image build is rarely the bottleneck: Docker's layer cache already makes
it nearly free (row 2). Lifecycle commands are what's slow, for example `npm ci` or toolchain
downloads in `onCreateCommand`. So the gain comes from **skipping the machine-level setup
(`onCreateCommand`) safely**, not from caching the image. Workspace-level setup still runs
for every task, through the project's own commands: opendevhub does not copy or clone
dependency folders such as `node_modules`. opencode's own startup (1–3 s, not measured here)
comes on top.

Row 4 skipped `updateContentCommand` too. In the final design `updateContentCommand` runs for
every task (see "Starting a task environment"), so add its runtime to that row.

### Verified CLI behaviour

These shaped the design. Each was reproduced against CLI 0.89.0.

1. **Image names follow the folder.** `devcontainer up --workspace-folder <worktree>` names
   the image after the folder (`vsc-<folder>-<hash>`). The layers come from the cache, but
   every worktree leaves another image tag behind.
2. **The image label carries the lifecycle commands.** The image built by the CLI has a
   `devcontainer.metadata` label holding all of them. An override config that *also* contains
   them makes every command **run twice**. Override configs must therefore drop the lifecycle
   keys.
3. **Markers hold the container's creation time.** The CLI records "already ran" markers in
   the container data folder (`~/.devcontainer/.onCreateCommandMarker`, …), and each holds the
   container's `Created` time. A committed snapshot carries the old markers, so a new container
   **re-runs `onCreate`**. If we write the new container's `Created` time into a marker before
   running user commands, that command is skipped and the rest still run. Verified with the
   `onCreate` and `updateContent` markers together; the design stamps only `onCreate`.
4. **`run-user-commands` needs the workspace pinned.** It has no
   `--mount-git-worktree-common-dir`, so it works out the wrong workspace folder unless the
   override config pins `workspaceFolder`.
5. **A failed command keeps its marker.** The CLI writes the marker *before* running the
   command, so after a failed `postCreate` a retry silently skips it. "Recreate" must use a new
   container rather than re-running the commands.
6. **The worktree flag isn't needed.** `--mount-git-worktree-common-dir` exists, but setting
   `workspaceMount`, `workspaceFolder` and a `.git` bind mount ourselves works the same way.
   Because container paths are identical across environments, it also works with absolute
   worktree links (git < 2.48).

## Model

An **environment** is one devcontainer plus one `opencode serve` plus its port forwards.

```ts
type EnvId = string; // "<projectId>" for main; "<projectId>-<branch slug ≤20>-<hash4>" for tasks; DNS label ≤ 63

interface Environment {
  id: EnvId;
  projectId: ProjectId;
  kind: "main" | "task";
  worktree?: { path: string; hostPath: string; branch: string }; // task only
  image: { key: string; ref: string; source: "build" | "snapshot"; outdated?: boolean };
  runtime: ProjectRuntime; // today's fields: container, route, opencode, ports, relay…
}
```

- A project always has its `main` environment. That's today's container, and it is unchanged:
  same labels, re-adopted, so no migration is needed.
- In `isolated` mode, each task worktree gets its own environment.
- Containers are labelled `opendevhub.project=<id>` and `opendevhub.env=<envId>`.
  `listManaged` re-adopts both kinds after a restart.
- Everything the orchestrator keys by `ProjectId` today (busy and git locks, routes, monitors,
  forwards, the relay) becomes keyed by `EnvId`. The main environment's id equals the project
  id, so existing state and URLs keep working.

## Warm start

### Image key

`key = sha256(cliVersion, tree(.devcontainer), tree(.devcontainer.json), files in customizations.opendevhub.keyFiles, generation)`

- `tree(x)` is `git rev-parse <commit>:<x>`, read at the worktree's base commit. It's cheap and
  deterministic, and it ignores everything outside the listed paths.
- `keyFiles` (default `[]`) adds files whose change should invalidate the snapshot, typically
  lockfiles: `["package-lock.json"]`.
- `generation` is a per-project counter that **Rebuild** increments.
- Limitation: a Dockerfile whose build context reaches outside `.devcontainer` (`"context": ".."`)
  can change without the key changing. This is documented, and **Rebuild** covers it.

### Base image (per project and key, both modes)

`devcontainer build --workspace-folder <task worktree> --image-name opendevhub/<projectId>:<key12>-base`.
This builds only the image, Dockerfile and features included, with no container and no
lifecycle commands. BuildKit's cache makes it nearly free when the main environment already
built the same config. It is used directly in `image` mode and is the starting point of the
snapshot.

### Snapshot (per project and key, `snapshot` mode only)

Built in the background the first time an isolated task needs a key with no snapshot yet. The
UI shows "Preparing environment image…", and tasks queue behind it.

1. Create a detached **template worktree** at the base commit:
   `<project>.worktrees/.odh-template-<key8>`. This keeps the prebuild from writing into the
   main checkout while the main environment is using it. It's removed after step 3.
2. `devcontainer up --workspace-folder <template> --id-label opendevhub.prebuild=<project>:<key8>
   --container-data-folder /tmp/.odh-devcontainer --prebuild`. This builds or reuses the image
   (BuildKit cache) and runs `onCreateCommand` and `updateContentCommand` only. opencode never
   runs here, so no sessions or credentials end up in the snapshot.
3. `docker stop`, then `docker commit --change 'LABEL opendevhub.prebuild=' <c> opendevhub/<projectId>:<key12>`,
   then `docker rm`.
4. Record `{ key, ref, createdAt }` in `state.json`. Keep the last 3 keys per project and remove
   older images.

The snapshot holds everything outside the workspace: system packages, global tools,
toolchains, and package-manager caches in `$HOME` (`~/.npm`, `~/.cache/pip`, `~/.cargo`…).
That last part means a task's own `npm ci` reinstalls from a warm cache without copying
`node_modules`. Workspace files written by the prebuild stay in the template worktree and are
discarded.

### Warm-start modes

| Mode | Task containers run | Correct when |
| --- | --- | --- |
| `image` (**default**) | Every lifecycle command, on the reused image | Always |
| `snapshot` (opt-in) | `updateContentCommand`, `postCreateCommand`, `postStartCommand`; `onCreateCommand` is baked into the snapshot | `onCreateCommand` only sets up the machine and doesn't write into the workspace |

This follows the devcontainer spec's own split: `onCreateCommand` is one-time setup of the
container, and `updateContentCommand` runs "when new content is available", which describes
every new worktree. A project that installs dependencies in `onCreateCommand` gets a worktree
without them in `snapshot` mode. The README says so plainly: move workspace installs to
`updateContentCommand` or `postCreateCommand` before turning `snapshot` on. opendevhub doesn't
try to detect this.

### Starting a task environment

1. **Worktree**: as today (`git worktree add` in the main container).
2. **Override config** written to `~/.local/state/opendevhub/envs/<envId>/devcontainer.json`.
   It is the task worktree's resolved config with these changes:
   - `image`: the snapshot (in `snapshot` mode) or the CLI-built image for this key (in
     `image` mode), with `build`, `dockerFile`, `dockerComposeFile` and `features` removed,
     since they're baked into the image and its label. Pinning the image in `image` mode too
     avoids leaving a `vsc-<folder>` tag behind for every worktree.
   - every lifecycle key except `initializeCommand` removed, since they come from the label
     (see "Verified CLI behaviour", item 2)
   - `workspaceMount`: the worktree's host path → `<ws>.worktrees/<dir>`
   - `workspaceFolder`: `<ws>.worktrees/<dir>`
   - `mounts`: the original mounts plus `<project>/.git` → `<ws>/.git`
   - `runArgs`: `--name …` removed, since names can't repeat (logged)

   If the task's own key differs from every built image or snapshot (the branch changed
   `.devcontainer/`), that image is built first. Only that task pays the build cost.
3. `devcontainer up --override-config … --id-label … --container-data-folder /tmp/.odh-devcontainer --skip-post-create`
4. `snapshot` mode only: write the new container's `Created` time into the `onCreate` marker.
5. `devcontainer run-user-commands` with the same override config. This runs the remaining
   lifecycle commands and dotfiles.
6. Start opencode and the relay, open the route, forward ports, start the monitor. These are
   the existing steps, run per environment.

## Rebuilding a single task

Each task environment's menu has these actions:

| Action | What it does | When to use it |
| --- | --- | --- |
| **Restart** | `docker stop` + `up` (existing container, `postStart` only) | opencode or the dev server got stuck |
| **Recreate** | Remove the container, then the start steps 3–7 from the current snapshot. The worktree and its files are untouched. | Container state is broken (`$HOME`, installs, a failed `postCreate`; see "Verified CLI behaviour", item 5) |
| **Rebuild image** | Build the base image (and the snapshot, in `snapshot` mode) from *this task's* config with `--no-cache`, under the task's own `generation` bump, then **Recreate**. Other environments keep their image. | The task changed `.devcontainer/`, or the base image is stale |

The project-level **Rebuild** (existing) also bumps the project's `generation`. Running task
environments keep their current image and get an **outdated** badge (their image key is no
longer the latest for their config) with a one-click **Recreate**. Nothing is recreated
automatically, so a running agent is never pulled out from under itself.

## opencode per environment

- Each environment runs its own `opencode serve`, with its own password and route.
- Proxy hosts become `http://<envId>.localhost:7777`. `classifyHost` resolves an env id
  instead of a project id; the main environment's URL is unchanged.
- **Sessions live in the container** (opencode's data directory under `$HOME`), so they
  survive restart and recreate only if that directory is on a volume. Each task environment
  gets a named volume `opendevhub-oc-<envId>` mounted at opencode's data directory, so
  **Recreate** and **Rebuild image** keep sessions.
- **Removing** a task environment first exports its sessions
  (`GET /api/experimental/session/:id/export`) to
  `~/.local/state/opendevhub/archive/<project>/<branch>/`. It then offers to import them into
  the main environment (`POST /api/experimental/session/import`), so the history stays
  browsable. Both endpoints are marked experimental in opencode 2.0.22, so they're used on a
  best-effort basis.
- Rejected: one opencode data volume shared by all environments. That would mean several
  `opencode serve` processes on one database across containers. opencode v2's "background
  service" model suggests it expects one server per data directory (unverified), and SQLite
  locking over Docker Desktop file sharing is unreliable.
- The exact data directory still needs confirming. `/api/info` only reports `paths.tmp`, so
  resolve it from opencode's XDG defaults for the remote user during phase 2.

## Routing, ports, monitor

- Each environment opens its own route (direct or gateway; the gateway already joins any
  container network) and runs its own relay.
- Ports: each environment forwards its `forwardPorts`. Clashes on the host are already
  resolved by "next free port", so the second environment's `3000` lands on `3001`, and the
  Ports tab groups mappings by environment. With the per-environment hostnames above, a later
  step can expose previews at `http://<envId>.localhost:7777` directly.
- Monitor: one per environment. Sessions carry `envId`. The dashboard's session lists, the
  "Needs you" view and notifications aggregate them by project as today, tagged with the
  branch.

## Lifecycle and resources

- **Idle stop**: an environment whose sessions have all been idle for `idleStopMinutes`
  (default 30, `0` disables it), and which has no open forwarded connections, is stopped.
  Starting it again takes about 1 s plus opencode. Main environments are exempt by default.
- **Limits**: a global `maxRunningEnvs` (default 6). Starting another environment beyond it
  asks which idle one to stop.
- **Remove task**: export sessions, stop and remove the container, remove the opencode volume,
  remove the worktree (the existing confirmation flow), and optionally delete the branch.
- **Garbage collection**: when opendevhub starts and after a rebuild, remove snapshot images
  beyond the 3 most recent keys per project, and any leftover template worktrees. Also remove dangling
  `vsc-*` tags of opendevhub-owned folders.

## Configuration

`devcontainer.json`, travelling with the repo:

```jsonc
"customizations": {
  "opendevhub": {
    "isolation": "isolated",          // "shared" (default) | "isolated"
    "warmStart": "image",             // "image" (default) | "snapshot"
    "keyFiles": ["package-lock.json"], // extra image/snapshot invalidation inputs
    "idleStopMinutes": 30
  }
}
```

Per-project overrides in `config.json` (`projects: { "<path>": { … } }`) cover repos you don't
own. The new-task dialog adds **Environment: Shared / Own container**, defaulting to the
project's setting.

## Not supported in v1 (falls back to shared, with a message)

- **Docker Compose configs.** Compose creates a project per folder, so each task would get the
  whole stack. That is real isolation, but host `ports:` collide, and pinning the image through
  `--override-config` doesn't apply to compose services. Planned as phase 2: a generated
  compose override that drops host ports, plus `COMPOSE_PROJECT_NAME=<envId>`.
- **`runArgs` with `-p`/`--publish`, or `appPort`**: host port clashes. These are detected and
  the project is refused for isolated mode, naming the cause.
- **`--network=host`**: not supported, as today.

## Code changes

| Unit | Change |
| --- | --- |
| `shared/types` | `Environment`; `ProjectView.environments`; `SessionSummary.envId` |
| `containers` | `up` takes an `EnvTarget` (id labels, workspace folder, override config, extra flags); add `runUserCommands`, `commit`, `removeImage`, `volumeRemove`, `writeMarkers` |
| new `images` | Image key, snapshot build (template worktree, prebuild, commit), garbage collection, a single build queue per project |
| new `env-config` | Builds the override config (pure function, unit-tested against real configs) |
| `orchestrator` | Keyed by `EnvId`; `startEnv`/`stopEnv`/`recreateEnv`/`rebuildEnvImage`/`removeEnv`; tasks choose shared or isolated |
| `state`/`config` | Persist environments and snapshot records; per-project overrides |
| `hosts`/`proxy` | `<envId>.localhost` |
| `web` | Environment badges and menus on worktree and task rows; "Preparing environment image…" progress; Ports grouped by environment; the outdated badge |

## Interaction with other specs

None of these depend on per-task environments, and per-task environments don't depend on them.
- [Tasks](2026-10-03-tasks-design.md): a task's `where: "worktree"` gains
  `environment: "shared" | "isolated"`. In a multi-model task, isolated variants each get their
  own container, which is exactly what comparing models needs: each variant can run the app and
  its tests independently.
- [Review](2026-10-03-review-design.md): the diff, comments, Commit and Update run against the
  task environment's opencode and container. **Merge into base** runs in the main environment,
  because it needs the main checkout.
- [Publish](2026-10-03-publish-design.md): unchanged (it runs on the host).
- [Respond inline](2026-10-03-respond-inline-design.md): unchanged; pending items carry `envId`
  and are routed to that environment's opencode.

## Delivery plan

| Phase | Scope |
| --- | --- |
| 1 | `Environment` refactor with `main` only: no behaviour change, all tests green |
| 2 | Isolated task environments with `warmStart: "image"`: override config, `.git` mount, routes, monitor, ports |
| 3 | `snapshot` mode: template worktree, prebuild, commit, marker stamping, CLI version gate |
| 4 | Restart, Recreate and Rebuild image per task; the outdated badge; idle stop; garbage collection |
| 5 | Session export and import on removal; `maxRunningEnvs` |
| 6 (later) | Docker Compose |

## Testing

- **Unit**: image key inputs; override config generation (lifecycle keys stripped, mounts and
  workspace, `--name` removed, compose and port refusal); marker timestamp format; env id
  generation and its length limit.
- **Integration** (fake runner, as in today's orchestrator tests): start, recreate and rebuild
  sequences; snapshot queueing when two tasks need the same new key; outdated detection; idle
  stop.
- **e2e** (real Docker): a fixture repo whose lifecycle commands append to a log, so tests can
  assert which commands ran in which environment:
  - two isolated tasks run concurrently and each serves `forwardPorts: [3000]` on different
    host ports
  - in `snapshot` mode, a task skips `onCreate` but runs `updateContent`, `postCreate` and `postStart`; in `image` mode it runs all of them
  - **Recreate** keeps the sessions
  - **Rebuild image** on one task leaves the other's image ID unchanged
  - a branch that changes `.devcontainer/` gets its own image
  - the main environment is untouched throughout

  Also add a smoke test for start time: a warm task environment is ready in under 10 s on CI.

## Dependency on CLI internals

Marker stamping relies on how the CLI stores markers: the container's creation time in
`<container data folder>/.<command>Marker`. Both of these happen:

- **Version gate.** `snapshot` mode is enabled only for CLI versions the e2e suite has
  verified, starting with 0.89.x. Preflight reads `devcontainer --version`. Outside the verified
  range, `snapshot` falls back to `image`, with one line in the project log saying why. Bumping
  the range is a one-line change after the e2e suite passes on the new version.
- **Upstream.** Propose a `--skip-on-create` flag for `devcontainer up` and `run-user-commands`
  in `devcontainers/cli`, mirroring the existing `--skip-post-create`, to use on containers
  started from a `--prebuild` snapshot. Once it ships, the gate becomes "flag available → use
  the flag, else stamp markers within the verified range, else `image`".

## Decisions

- No copying or cloning of dependency folders (`node_modules`, `.venv`, `target`). Workspace
  setup is the project's own lifecycle commands, run per task, helped by the warm
  package-manager caches in the snapshot.
- Task environments use the default Docker network that `devcontainer up` gives them. There is
  no shared per-project network; tasks don't reach each other's services.
