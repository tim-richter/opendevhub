## Why

Port forwarding, host ports and personalization make opendevhub's containers pleasant to work in, but the only way into them today is the dashboard's terminal. Users who live in their own terminal (their keybindings, tmux, scrollback) have to give up either that terminal or opendevhub's containers. Because the opendevhub server already starts the containers and runs every forward, a small set of CLI subcommands that find the right container and `docker exec` into it gets all of that without re-implementing any of it.

## What Changes

- New `opendevhub` subcommands that talk to the **running** opendevhub server on this machine:
  - `opendevhub attach [target] [--shell <name>]`: start the environment if it is stopped, streaming the start log, then open an interactive shell in it.
  - `opendevhub up [target]`: start the environment without attaching.
  - `opendevhub exec [target] -- <command…>`: run one command in the environment. It returns the command's exit code, allocates a TTY only when stdin and stdout are terminals, and works in pipes.
  - `opendevhub ls`: list the current project's environments (branch, env id, node, state).
- Without a target, the environment comes from the current directory. A task's worktree selects that task's environment, and the project folder selects the main environment. A target can also name a branch or an env id, and an ambiguous name lists the matches.
- The shell starts in the container folder that matches the current host folder, and falls back to the workspace root.
- The CLI runs `docker exec` itself (or `ssh -tt … docker exec` for an environment on a remote node), so the shell is a real TTY in the user's terminal.
- A new dashboard API endpoint resolves a host folder or target to the environment and its exec target (container id, user, `remoteEnv`, container folder, ssh target).
- The CLI never applies ports, host ports or personalization itself, never approves host-affecting settings, and never starts the server. Each of those ends in a clear error that points to the dashboard or to `opendevhub`.

## Capabilities

### New Capabilities

- `terminal-attach`: the CLI subcommands for listing, starting, attaching to and running commands in opendevhub-owned environments from the user's own terminal. This covers how a target is resolved from the current folder or a name, how the CLI authenticates to the local server, and its behavior when the server is down, the project is unknown or approvals are missing.

### Modified Capabilities

<!-- None: the dashboard terminal, port forwarding and approvals keep their requirements; the CLI only reuses them. -->

## Impact

- `apps/opendevhub/src/server/cli.ts`: subcommand dispatch, usage text, and the CLI client for `attach`/`up`/`exec`/`ls`.
- `apps/opendevhub/src/server/environments/environments.ts`: resolving a host folder or target to an environment, and its exec target with the matching container folder, next to `terminalTarget`.
- `apps/opendevhub/src/server/environments/terminals.ts`: `terminalCommand` grows options for a non-TTY `exec` and an arbitrary command, shared by the dashboard and the CLI.
- `apps/opendevhub/src/server/api/`: the exec-target and environment-list endpoints, cookie-gated like the rest of the dashboard API.
- `apps/opendevhub/src/server/access.ts`: the CLI derives the dashboard cookie from the local access token.
- `apps/docs`: a "Working from your own terminal" page.
- No new dependencies.
