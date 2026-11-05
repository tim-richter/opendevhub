## Context

The opendevhub server owns every environment's lifecycle. `devcontainer up` gets personalization flags in `Containers.up`, `forwardPorts`/`refreshPorts` binds forwarded ports on the host, and the relay serves host ports. These run in the server process for as long as an environment runs. The dashboard terminal already gets into a container: `Environments.terminalTarget(projectId, directory)` resolves a checkout folder to its environment and returns container id, `remoteUser` and the probed `remoteEnv`. `cli.ts` adds the node's ssh target, and `terminalCommand` builds `docker exec -it …` (wrapped in `ssh -tt` for remote nodes).

`opendevhub` already has subcommands (`open`, `token`, `nodes`) that read the state folder. The dashboard API is gated by the `odh` cookie, an HMAC of the access token in the state folder.

Paths: the project's host folder maps to the container's `workspaceFolder`. Task worktrees live under `<project path><WORKTREES_SUFFIX>` on the host, mounted at `<workspaceFolder><WORKTREES_SUFFIX>` (`git/worktrees.ts`). Environment records and `terminalTarget` address checkouts by their **container** path.

## Goals / Non-Goals

**Goals:**

- Get into opendevhub's containers from the user's own terminal with a real TTY.
- Reuse the server for everything stateful: starting, approvals, ports, personalization.
- Keep the CLI thin: resolve, start if needed, then hand the terminal to `docker exec`.

**Non-Goals:**

- Working without the server, or starting it.
- Editing settings or approving host-affecting settings from the CLI.
- Starting agents or tasks. `up` starts an environment, never a task draft (`tasks/:task/start`).
- Persistent or shared terminal sessions. Users who want those run tmux.
- Containers opendevhub doesn't own.

## Decisions

### 1. The CLI is a client of the running server

The subcommands call the local server over HTTP rather than reading `config.json` and the database and driving Docker themselves. The server is the only place that knows runtime state (container id, remote user, node connections) and holds the forwards, so a standalone CLI would have to duplicate it and would collide with the server's port binds. _Alternative:_ a standalone CLI that runs forwards itself. It was rejected in grilling: users are fine with opendevhub running, and two forwarders for one container conflict.

### 2. Authenticate with the derived dashboard cookie

The CLI reads the token via `Access(stateDir())` and sends `Cookie: odh=<dashboardCookie>`, the same value a browser receives. It needs no new auth path and no bearer-token route. Anyone who can read the token file can already open the dashboard. _Alternative:_ a separate CLI token. It adds a second secret to rotate and gains nothing on one machine.

### 3. The server resolves host paths, not the CLI

A new endpoint, e.g. `GET /api/cli/target?dir=<abs host path>[&name=<target>]`, finds the project whose host folder (or worktrees folder) contains `dir`. It then picks the environment and returns:

```ts
interface CliTarget {
  projectId: ProjectId;
  envId: EnvId | null; // null: main environment
  branch?: string;
  node?: NodeId;
  state: "running" | "stopped" | "starting" | …;
  /** Present when running. */
  exec?: TerminalTarget & { directory: string }; // container folder for the shell
}
```

The host-to-container translation lives next to `envForDirectory`/`checkDirectory`, using `project.path ↔ workspaceFolder` and the worktree root mapping. The CLI walks nothing itself, so the rules stay in one place and stay testable with the existing fakes. A `name` argument matches env ids and branch names. Ambiguous or missing matches return a 4xx error that lists the candidates. `GET /api/cli/envs?dir=` backs `ls`. _Alternative:_ the CLI reads `config.json` roots and the DB. That duplicates resolution and couples the CLI to the schema.

### 4. The CLI spawns `docker exec` itself

When the target is running, the CLI builds the command with the shared `terminalCommand` and spawns it with `stdio: "inherit"`. `terminalCommand` is extended to take a command (instead of a shell) and a `tty` flag (`-it` vs `-i`). The CLI forwards its exit code. Signals and resize are handled by the user's terminal and `docker exec` directly, because the CLI process only waits. _Alternative:_ attaching to the server's terminal websocket. That puts a terminal inside a terminal (extra hop, resize/replay quirks), which is what users are trying to avoid.

### 5. Default shell via a fallback wrapper

When `--shell` is absent, the exec runs `sh -c 'for s in "$1" bash sh; do command -v "$s" >/dev/null && exec "$s" -i; done' sh <$SHELL name>`. The `$SHELL` name is checked against the bash/zsh/sh/fish allow-list first, and falls back to bash otherwise. This takes one exec and no extra round trip.

### 6. Starting reuses the start routes and polls for progress

`up`/`attach` call the existing `POST /api/projects/:id/start` or `/envs/:env/start`, which run `checkConfig` (the approvals gate) before starting. While the request is open, the CLI polls the environment's logs endpoint and prints new lines. An `ApprovalRequiredError` response is printed as the list of pending settings plus `accessUrl(port, token)`. After a successful start the CLI asks for the target again to get the exec target. _Alternative:_ a new streaming start endpoint. Polling the existing logs endpoint is enough for v1 and adds no API surface.

## Risks / Trade-offs

- [Server restarts while a shell is open] → The shell keeps running, because `docker exec` doesn't depend on the server. Only forwards drop until the server comes back, which is the same as for dashboard users.
- [Cookie derivation couples the CLI to `Access` internals] → The CLI uses the `Access` class itself, never a re-implementation of the HMAC.
- [Host and container paths differ, e.g. Docker Desktop or symlinked roots] → Resolve with `realpath` on the CLI side before sending. If the folder is not found inside the checkout, the server falls back to the checkout root instead of failing.
- [Remote node offline] → Return an error that names the node; the CLI prints it and exits non-zero.
- [`exec` on a shared container from a task worktree] → It resolves to the main environment's container with the worktree's container folder, the same way `envForDirectory` handles it for the dashboard.

## Open Questions

- The exact log source to poll during start (environment logs vs project log). Decide during implementation, based on which carries the `devcontainer up` lines.
