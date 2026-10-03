# Per-task environments

Date: 2026-10-03
Status: Draft for review

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
downloads in `onCreateCommand`. So the work has to happen in **skipping lifecycle commands
safely** and **carrying workspace-local outputs** (`node_modules`), not in image caching alone.
opencode's own startup (1–3 s, not measured here) comes on top.

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
   **re-runs `onCreate`**. If we write the new container's `Created` time into the `onCreate`
   and `updateContent` markers before running user commands, those two are skipped and
   `postCreate`/`postStart` still run. This mirrors Codespaces prebuild semantics.
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

### Snapshot (per project and key)

Built in the background the first time an isolated task needs a key with no snapshot yet. The
UI shows "Preparing environment image…", and tasks queue behind it.

1. Create a detached **template worktree** at the base commit:
   `<project>.worktrees/.odh-template-<key8>`. This keeps the prebuild from writing into the
   main checkout while the main environment is using it.
2. `devcontainer up --workspace-folder <template> --id-label opendevhub.prebuild=<project>:<key8>
   --container-data-folder /tmp/.odh-devcontainer --prebuild`. This builds or reuses the image
   (BuildKit cache) and runs `onCreateCommand` and `updateContentCommand` only. opencode never
   runs here, so no sessions or credentials end up in the snapshot.
3. `docker stop`, then `docker commit --change 'LABEL opendevhub.prebuild=' <c> opendevhub/<projectId>:<key12>`,
   then `docker rm`.
4. Record `{ key, ref, createdAt }` in `state.json`. Keep the last 3 keys per project and remove
   older images and template worktrees.

`warmStart: "image"` skips steps 1–3. Task environments then use the CLI-built image of the
main environment (or of the task's own config), and every lifecycle command runs. This is the
safe default when `onCreateCommand` writes into the workspace and nothing in `copy` covers it.

### Starting a task environment

1. **Worktree**: as today (`git worktree add` in the main container).
2. **Copy workspace-local outputs**: for each path in `customizations.opendevhub.copy`
   (default `[]`, e.g. `["node_modules"]`), copy it on the host from the template worktree to
   the new one, using a copy-on-write clone where possible:
   - `cp -a --reflink=auto` on Linux (instant on btrfs and xfs)
   - `cp -cR` on macOS (APFS clonefile)
   - a plain copy otherwise, with the size logged

   This is skipped for `warmStart: "image"`. Caveat in the README: directories that embed their
   own absolute path (Python venvs) break when moved. List `node_modules`, not `.venv`.
3. **Override config** written to `~/.local/state/opendevhub/envs/<envId>/devcontainer.json`.
   It is the task worktree's resolved config with these changes:
   - `image: <snapshot ref>`, with `build`, `dockerFile`, `dockerComposeFile` and `features`
     removed, since they're baked into the image and its label
   - every lifecycle key except `initializeCommand` removed, since they come from the label
     (see "Verified CLI behaviour", item 2)
   - `workspaceMount`: the worktree's host path → `<ws>.worktrees/<dir>`
   - `workspaceFolder`: `<ws>.worktrees/<dir>`
   - `mounts`: the original mounts plus `<project>/.git` → `<ws>/.git`
   - `runArgs`: `--name …` removed, since names can't repeat (logged)

   If the task's own key differs from every snapshot (the branch changed `.devcontainer/`), the
   snapshot is built for that key first. Only that task pays the build cost.
4. `devcontainer up --override-config … --id-label … --container-data-folder /tmp/.odh-devcontainer --skip-post-create`
5. Write the new container's `Created` time into the `onCreate` and `updateContent` markers
   (snapshot mode only).
6. `devcontainer run-user-commands` with the same override config. This runs `postCreate`,
   `postStart` and dotfiles.
7. Start opencode and the relay, open the route, forward ports, start the monitor. These are
   the existing steps, run per environment.

## Rebuilding a single task

Each task environment's menu has these actions:

| Action | What it does | When to use it |
| --- | --- | --- |
| **Restart** | `docker stop` + `up` (existing container, `postStart` only) | opencode or the dev server got stuck |
| **Recreate** | Remove the container, then the start steps 3–7 from the current snapshot. The worktree and its files are untouched. | Container state is broken (`$HOME`, installs, a failed `postCreate`; see "Verified CLI behaviour", item 5) |
| **Rebuild image** | Build a snapshot from *this task's* config with `--build-no-cache` and the task's own `generation` bump, then **Recreate**. Other environments keep their image. | The task changed `.devcontainer/`, or the base image is stale |

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
  and template worktrees beyond the 3 most recent keys per project. Also remove dangling
  `vsc-*` tags of opendevhub-owned folders.

## Configuration

`devcontainer.json`, travelling with the repo:

```jsonc
"customizations": {
  "opendevhub": {
    "isolation": "isolated",          // "shared" (default) | "isolated"
    "warmStart": "snapshot",          // "snapshot" (default when isolated) | "image"
    "copy": ["node_modules"],          // workspace-local outputs to clone into new worktrees
    "keyFiles": ["package-lock.json"], // extra snapshot invalidation inputs
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

## Interaction with the respond / tasks / review spec

- A task's `where: "worktree"` gains `environment: "shared" | "isolated"`. Isolated variants in
  a best-of-N task each get their own container, which is exactly what comparing models needs:
  each variant can run the app and its tests independently.
- Review, comments and Commit/Update run against the task environment's opencode and container.
  **Merge into base** runs in the main environment, because it needs the main checkout. Publish
  is unchanged (it runs on the host).

## Delivery plan

| Phase | Scope |
| --- | --- |
| 1 | `Environment` refactor with `main` only: no behaviour change, all tests green |
| 2 | Isolated task environments with `warmStart: "image"`: override config, `.git` mount, routes, monitor, ports |
| 3 | Snapshots: template worktree, prebuild, commit, marker stamping, `copy` |
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
  - the warm start skips `onCreate` and `updateContent` but runs `postCreate`
  - **Recreate** keeps the sessions
  - **Rebuild image** on one task leaves the other's image ID unchanged
  - a branch that changes `.devcontainer/` gets its own image
  - the main environment is untouched throughout

  Also add a smoke test for start time: a warm task environment is ready in under 10 s on CI.

## Open questions

1. Marker stamping relies on how the CLI stores markers internally (creation time in
   `~/.devcontainer/.*Marker`). Pin a tested CLI version range and fall back to
   `warmStart: "image"` outside it, or upstream a `--skip-prebuild-commands` flag to
   `devcontainers/cli`?
2. Should the default `copy` source be the template worktree (consistent with the snapshot) or
   the main checkout (likely newer)? This draft picks the template worktree.
3. Should isolated environments share a Docker network per project (so tasks can reach each
   other's services), or each use the default network? This draft uses the default.
