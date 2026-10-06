# Remote nodes

Date: 2026-10-06
Status: Draft for review
Depends on: per-task environments (`2026-10-03-per-task-environments-design.md`)

## Problem

Every environment runs on the machine that runs opendevhub. Agents themselves are cheap (they
mostly wait on API calls), but their containers are not: builds, tests, language servers and
dev servers. One machine runs out long before 20 parallel tasks.

The goal: run isolated task environments on other machines you own, controlled and observed
from the dashboard on this one, without changing how a task looks or behaves in the dashboard.
Cloud VMs created on demand are a later step; the design must not block them.

## Decisions

- **Nothing to install on the node.** A node is an ssh destination with Docker, the
  devcontainer CLI and git. All logic stays in the hub (the opendevhub process you run). No
  node daemon, no version skew, nothing listening on the node besides sshd.
- **The hub clones on demand.** You don't clone projects on nodes by hand. The hub pushes the
  base commit to a repo it keeps on the node and fetches task branches back. The node never
  needs forge credentials.
- **Only isolated worktree tasks are placed remotely** (v1). They already have their own
  container, image and branch. The main environment and shared tasks stay local.
- **DevPod and a `opendevhub node` daemon were considered and rejected.** DevPod models one
  clone per workspace, brings its own agent and credential handling, and its maintenance is
  unclear. A daemon per node means an install and an API between nodes and hub, for no gain
  while opendevhub is single-user.

## Nodes

A node is configured once, through Settings or `opendevhub nodes add <ssh-destination>
[--label <name>]`, and saved in `config.json`:

```json
{ "nodes": [{ "id": "box", "ssh": "tim@box", "label": "Workstation" }] }
```

`id` is derived from the label or the host (`LABEL` rules from `hosts.ts`) and must be unique.
The machine opendevhub runs on is the implicit node `local`; it is not stored.

`opendevhub nodes list` and `opendevhub nodes remove <id>` complete the CLI. Removing a node
with environments on it is refused until they are removed (the Cleanup page can do that).

### Preflight

Run when a node is added and on every (re)connect. Each failure is shown on the node:

- ssh connects without a prompt (`BatchMode=yes`). A host key or password prompt fails with
  "add the host key and an ssh key for <dest> first".
- `docker version` reaches a daemon.
- `devcontainer --version` is found.
- `git --version` is 2.48 or newer (relative worktree paths, as locally).
- `~/.opendevhub/` exists or can be created.
- TCP forwarding works: the hub dials the node's own sshd port through a channel. A refusal
  fails with "sshd on <dest> does not allow TCP forwarding (AllowTcpForwarding)".

### Node status

`NodeView` in the snapshot: `{ id, label, state: "online" | "connecting" | "unreachable" |
"error", reason?, stats? }`. `stats` is `{ cpus, memTotal, memAvailable, containers }` from
`/proc/meminfo`, `nproc` and `docker ps -q --filter label=opendevhub.env`, refreshed by the
resource sampler on its existing interval. The local node reports the same fields.

## `Host`

Everything that means "this machine" today goes behind one interface:

```ts
export type NodeId = string;

export interface Host {
  id: NodeId;
  run: Runner;
  dial(ip: string, port: number): Promise<net.Socket>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Absolute home directory on the node; opendevhub's files go under `<home>/.opendevhub`. */
  home: string;
}
```

- **`localHost`** wraps `spawnRunner`, `node:fs` and the current route's dial. Behaviour for
  local environments does not change.
- **`SshHost`** (one per node, owned by a `NodeConnection`):
  - `run` executes `ssh -S <ctl> -o BatchMode=yes <dest> -- <quoted cmd>` over a ControlMaster
    socket at `~/.config/opendevhub/ssh/<id>.sock`, opened with `ssh -M -N -f
    -o ControlPersist=yes -o ServerAliveInterval=15`. Arguments are shell-quoted on the hub
    side; stdout and stderr stream through as today, so `onLine` keeps working.
  - `dial` opens a `direct-tcpip` channel on a persistent `ssh2` connection. It authenticates
    with the hub's `SSH_AUTH_SOCK` and reads `~/.ssh/config` for the destination's `HostName`,
    `User`, `Port` and `IdentityFile`. (ssh2 doesn't read ssh config itself; `ssh -G <dest>`
    resolves it.) A destination using `ProxyJump` or `ProxyCommand` falls back to
    `ssh -S <ctl> -W ip:port <dest>` per connection: it still goes through the ControlMaster but
    costs one process per socket. The `ssh2` package is a new dependency.
  - `readFile`/`writeFile` go through `run` (`cat`, and `sh -c 'cat > "$1"'` with stdin).
    `RunOptions` gains `input?: string`.
- `Containers`, `Images`, `RelayRuntime`, `OpencodeRuntime` and `EnvFiles` take a `Host`
  (today they take a `Runner` or use `node:fs`). The orchestrator holds a `Hosts` registry
  (`get(nodeId)`, `all()`) and resolves the host of each environment through its record.

### NodeConnection

One per configured node. It owns the ControlMaster and the ssh2 connection, runs preflight,
and drives `NodeView.state`:

- Connects lazily: when the dashboard starts (to adopt), and when a task is placed.
- On a dropped ssh2 connection or a failed `ssh -O check`, sets `unreachable` and reconnects
  with backoff (1 s doubling to 60 s). On success it reruns preflight, then the orchestrator
  adopts that node's containers again (see Runtime).
- `close()` on shutdown runs `ssh -O exit` and ends the ssh2 connection. Remote containers keep
  running, as local ones do.

## Placement

- `TaskRequest` gains `node?: NodeId`. Absent means the project's default node, which is
  `local` unless set.
- Project settings gain `defaultNode?: NodeId`, set from the project's settings panel.
- The task form shows a **Node** select with every node and its free memory. Choosing a node
  other than `local` forces `where: "worktree"` and `environment: "isolated"`, and the form says so.
- The server rejects a remote `node` with `where: "workspace"` or `environment: "shared"`
  (400), an unknown node (400), and a node that isn't `online` (503 "node box is unreachable").
- `isolationFor` still applies: a project whose config can't be isolated can't run remotely,
  with the same reason.
- `EnvRecord` and `EnvironmentView` gain `node: NodeId` (`local` for existing records when
  state is loaded).

## Code to the node and back

### Repo on the node

`<home>/.opendevhub/repos/<projectId>/` is a non-bare repo that is never checked out. The hub
creates it with `git init -q` and `git config receive.denyCurrentBranch ignore` on first use.
Worktrees go to `<home>/.opendevhub/repos/<projectId>.worktrees/<dir>`, using
`worktreeDirName` and the same layout as locally, so the worktree root and the override
config's `gitDir` mount work unchanged with node paths.

### Creating a remote variant

Inside `createTask`, for each variant placed on node N:

1. **Push the base.** On the hub, run git in the local checkout (the host runner, not the
   container; the hub's own ssh setup applies):
   `git push --no-verify ssh://<dest>/<repo> <baseRef>:refs/odh/base/<task>`. `baseRef` is the
   request's `base`, or the main checkout's current branch. A dirty main checkout adds a
   notice to the result: "uncommitted changes in the main checkout are not on node box".
2. **Create the worktree** on the node:
   `git -C <repo> worktree add --relative-paths -b <branch> <path> refs/odh/base/<task>`.
   Branch names come from `taskBranches` as today. Taken names include the node repo's
   branches as well as the local ones.
3. **Start the environment** with `ensureTaskEnv` against N's host: `Images.ensureBase` and the
   snapshot run on N's Docker, `EnvFiles` writes on N, then `devcontainer up` on N. The first
   task on a node does a cold build. Later ones reuse N's caches.
4. **Start the session** as today.

`refs/odh/base/<task>` is deleted on the node when the task's last remote variant is removed.

### Review and git actions

`review`, `commitMessage`, `commit`, `updateFromBase`, `publishInfo`, `publishSuggestion` and
`publish` take `(project, directory)`. For a directory that belongs to a remote environment, git
runs in **that environment's container** through its host, instead of in the project's main
container. One resolver, `gitTargetFor(project, directory)`, returns the `ExecTarget` and host,
and the git-action paths call it instead of using the project directly. For a remote worktree,
`updateFromBase` first pushes the local base again (step 1, overwriting
`refs/odh/base/<task>`), then rebases or merges onto that ref. The base is always what the hub's
checkout has, never a branch of the node repo.

Publishing from a remote environment works unchanged: the relay forwards the hub's ssh-agent
into the container.

### Bringing a branch home

- **Bring home** (new action on a remote variant):
  `git fetch ssh://<dest>/<repo> +refs/heads/<branch>:refs/heads/<branch>` in the local main
  checkout. It refuses when a local branch of that name exists and isn't an ancestor of the
  remote one ("local branch <branch> has diverged").
- **Merge into base** on a remote variant runs Bring home first, then merges locally as today.

## Runtime

### Route

A third `Route` kind, `ssh`, built like the gateway route: local loopback listeners for opencode
and the relay, each accepted connection piped through `host.dial(containerIp, port)`. `dial` is
set to the same function, so port forwarding uses it too. The proxy, `OpencodeClient`, monitors,
notifications, forwarded ports and ssh-agent forwarding see a `Route` and don't change.
Forwarded ports bind on the hub's loopback, as for local environments.

`Network.route` takes the host: `local` keeps today's `auto`/`direct`/`gateway` choice, and any
other node gets `ssh`. Docker Desktop on a node is out of scope; the node's container IPs must
be reachable from the node itself (Linux Docker engine).

### Adopting and refreshing

`adopt()` and `refreshContainers()` run per online host. On a node they list containers
labelled `opendevhub.env` and match them to `EnvRecord`s with that `node`. A container whose
record is missing is left alone and shows up on the Cleanup page. A node that comes back
online is adopted on its own, without touching other nodes.

### A node going offline

- `NodeView.state` becomes `unreachable`, and environments on it show an "offline" badge with
  their last known state and sessions.
- Monitors and port forwards for those environments stop. Their routes close.
- Actions on them fail with `UnavailableError("node box is unreachable")` (503).
- Containers and agents on the node keep running. After reconnecting, they are adopted again,
  monitors restart and pending permissions and forms show up again.

### Cleanup

Items carry `node`. The Cleanup page groups them by node. Removing a remote variant (pick,
discard, cleanup) removes its container, generated config and UID image on the node, the
worktree and branch in the node repo, and the base ref when it's the last one. A project's node
repo is listed as its own cleanup item once it has no worktrees.

### Editors

"Open in editor" is hidden for remote environments in v1. The opencode web UI works as for
local environments.

## Out of scope (v1)

- Creating cloud VMs. A later provider creates a VM and registers it as a node; nothing here
  assumes a node is long-lived.
- Automatic placement (by free memory or load).
- Remote main environments and shared tasks.
- Docker Desktop, Colima or rootless Docker on a node.
- Moving a running task between nodes.
- Opening a remote environment in an editor.

## Testing

- **Unit:** a `FakeHost` with a scripted `Runner`, an in-memory `dial` (`net.Socket` pairs)
  and an in-memory file map. Covers ssh command quoting, preflight parsing, placement
  validation, the push, worktree and fetch commands, the git-target resolution, Bring home's
  divergence check, and `NodeConnection`'s state changes and backoff (with a fake clock).
- **Integration:** `ssh localhost` registered as a node. This exercises ControlMaster, ssh2
  channels, `~/.opendevhub/repos` and the `ssh` route on one machine, and is the dev workflow
  for this feature. It runs when `ODH_TEST_SSH_LOCALHOST=1` is set, because CI may lack sshd.
- **e2e:** opt-in with `ODH_E2E_NODE=<ssh-destination>`: add the node, start an isolated task
  on it, wait for the session to go idle, open its review, Bring home, then remove the variant
  and check that the node has no container, worktree or branch left.

## Phases

1. `Host` interface and `localHost`. Containers, Images, runtimes and EnvFiles take a host.
   No behaviour change.
2. Node config, CLI, `NodeConnection`, `SshHost`, preflight, `NodeView` and stats in the
   dashboard.
3. `ssh` route and per-host adopt and refresh.
4. Placement: node repo, push, remote worktree, remote `ensureTaskEnv`, the task form's Node
   select.
5. Git actions in remote environments, Bring home, merge.
6. Offline handling, cleanup per node, docs.
