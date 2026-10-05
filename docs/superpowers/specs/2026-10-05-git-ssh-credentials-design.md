# Git identity and ssh-agent forwarding

Date: 2026-10-05
Status: Draft for review
Extends: [container relay](2026-09-30-container-relay-design.md). The agent tunnel is new
relay protocol.

## Problem

The devcontainer CLI does not do what VS Code's Dev Containers extension does on its own: it
doesn't copy `~/.gitconfig` and doesn't forward the ssh-agent. So in a container started by
opendevhub:

- `git commit` fails because there is no `user.name` or `user.email`. The agent can't commit,
  and nothing reaches the forge.
- `git fetch`, `git pull` and `git push` over ssh fail, as does installing private git
  dependencies. There are no keys, and no `known_hosts` to answer the host key prompt.

Today the README says "opendevhub does not manage credentials". Every project has to wire up
git in its own devcontainer.json.

## Scope

In:

- Git identity in every environment (main and task containers).
- Forwarding your ssh-agent into every environment, on by default.
- `known_hosts` entries for the project's ssh remotes.

Out: LLM provider keys (env vars work well enough), https credential helpers, GPG and ssh
commit signing, other tools' credentials, and resolving `~/.ssh/config` aliases in the container.

### Success criteria

- In a fresh container, `git commit` works without changing the project.
- With an ssh-agent running on the host, `ssh-add -l` in the container lists its keys, and
  `git fetch` from an ssh remote whose host key is in the host's `known_hosts` works.
- This works the same on the direct route (Linux) and the gateway route (macOS, rootless,
  Docker Desktop), and for containers created before this feature, with no rebuild.
- Nothing here can fail bring-up. Every step logs one line.

## Decisions (from brainstorming)

| Topic | Decision |
| --- | --- |
| Forwarding mechanism | A reverse tunnel through the relay that already runs in each environment. Rejected: bind-mounting `$SSH_AUTH_SOCK` when the container is created. That needs a different path per Docker runtime on macOS, a rebuild for existing containers, and breaks when the host socket path changes after you log in again. |
| Default | Forwarding is on. A project turns it off with `sshAgent: false`. This matches VS Code. Anything in the container can *use* your keys while forwarding is on, but can't read them. The README says so. |
| Lifetime | The socket in the container only works while opendevhub runs, like forwarded ports. |
| Identity | Copied from the host, only where the container has no value. Never overwritten. |
| known_hosts | Only entries the host already has are copied, for the project's ssh remotes. No `accept-new`, no built-in key list. |

## 1. Relay protocol additions

The first-line headers (see the relay spec §3) gain two verbs. Both work on the per-environment
relay. The gateway relay (`ODH_RELAY_REMOTE=1`) rejects them.

- `<token> agent-listen`: the **control connection**.
  - The relay replies `OK\n`. If it isn't listening yet, it creates
    `/tmp/opendevhub-ssh-agent.sock` (after removing a stale file at that path) with mode
    `0600`. The relay runs as the remote user, so the socket belongs to that user.
  - For each client that connects to the socket, the relay assigns an id (an increasing
    integer), pauses the client, and writes `CONN <id>\n` on the control connection.
  - There is only one control connection at a time. A new `agent-listen` closes the previous
    one but keeps the listener and any pending clients.
  - When the control connection closes and no new one has arrived within 2 s, the relay closes
    the listener, unlinks the socket file and destroys pending clients. ssh then fails at once
    ("could not open a connection to your authentication agent") rather than hanging.
- `<token> agent-accept <id>`: answers a `CONN`.
  - With a pending client for that id: the relay replies `OK\n` and pipes the connection to
    that client in both directions. Bytes after the header line in the same chunk are forwarded.
  - Otherwise it replies `ERR ENOENT\n` and closes.
  - A client that isn't accepted within 5 s is destroyed.

The script stays CommonJS with only `node:net`, `node:crypto` and `node:fs` (for `unlinkSync`
and `chmodSync`), and keeps its no-single-quote constraint.

## 2. Host side: `AgentTunnel`

New file `src/server/relay/agent.ts`, one `AgentTunnel` per environment.

- `start({ address, token, onLog })` opens the control connection and keeps it open.
  - Each `CONN <id>`:
    1. Connect to the host's agent at `process.env.SSH_AUTH_SOCK`, read each time.
    2. Then open `agent-accept <id>` to the relay.
    3. Pipe the two, with half-open handling as in the port forwarder.
  - If the host agent can't be reached, the tunnel doesn't accept; the relay's 5 s timeout
    closes the client. This failure is logged at most once per minute.
  - When the control connection closes unexpectedly, it reconnects with backoff (1 s doubling
    to 30 s). If the relay itself is gone, the orchestrator's existing relay recovery relaunches
    it and calls `start` again.
- `stop()` closes the control connection and any open pipes, and stops reconnecting.
- Status: `"forwarded"` while the control connection is up; `"unavailable"` with a reason
  otherwise.
- `SSH_AUTH_SOCK` unset, or not a socket, when `start` is called: the tunnel doesn't connect and
  logs `ssh-agent: SSH_AUTH_SOCK is not set on this machine; not forwarded` (or `… is not a
  socket`).

Connections go to the relay's `address` from the route, so the gateway route works without
changes to the gateway.

## 3. Orchestrator wiring

For every environment, main or task, in bring-up and in `adopt()` for running containers, after
the relay step and before launching opencode:

1. **Settings.** `resolveEnvSettings` returns `sshAgent: boolean`, default `true`, with the same
   precedence as `isolation`: the project's entry in `config.json` (`projects[path].sshAgent`)
   over `customizations.opendevhub.sshAgent`. Non-boolean values are ignored.
2. **Git identity** (§4).
3. **known_hosts** (§5).
4. **Agent tunnel.** If `sshAgent` is on and the relay is `active`: `tunnel.start(...)`, then set
   `core.sshCommand` (below). If the relay is unavailable: `sshAgent: "unavailable"` with the
   reason `relay not running`. If `sshAgent` is off: `"off"`, and remove `core.sshCommand` if it
   still has opendevhub's value.
5. **opencode.** `opencode serve` is launched with
   `SSH_AUTH_SOCK=/tmp/opendevhub-ssh-agent.sock` when `sshAgent` is on, so every tool the agent
   runs inherits it. The variable is set even before the tunnel connects: ssh then fails quickly
   rather than finding no agent.

`core.sshCommand`: run as the remote user, reaching terminals and VS Code attached to the
container, which don't inherit opencode's environment:

```sh
sh -c 'if [ -S /tmp/opendevhub-ssh-agent.sock ]; then SSH_AUTH_SOCK=/tmp/opendevhub-ssh-agent.sock ssh-add -l >/dev/null 2>&1; [ $? -eq 2 ] || export SSH_AUTH_SOCK=/tmp/opendevhub-ssh-agent.sock; fi; exec ssh "$@"' ssh
```

It uses the forwarded agent while it answers, and the shell's own `SSH_AUTH_SOCK` otherwise, so
git in VS Code keeps working with VS Code's agent when opendevhub isn't running. It is set when
`core.sshCommand` is unset or names `/tmp/opendevhub-ssh-agent.sock` (an earlier opendevhub
value). To remove it, opendevhub runs `git config --global --unset core.sshCommand`, but only when
the current value names that socket.

The other git commands opendevhub runs in a container (worktree add and remove, review, the
Publish container fallback) go through `devcontainer exec` as the remote user, so they pick up
`core.sshCommand` too and need no extra environment. A project that sets its own
`core.sshCommand` has chosen its own ssh setup and keeps it.

Stopping an environment, removing its container, and opendevhub shutting down all call
`tunnel.stop()`. When the relay restarts, the tunnel's control connection drops and it
reconnects on its own. The tunnel's failure to connect also triggers the existing relay
recovery, which is rate-limited.

Changing `sshAgent` takes effect the next time the environment is started or adopted
(restarting opendevhub is enough). No rebuild is needed.

## 4. Git identity

New file `src/server/credentials.ts`:

- `hostIdentity(projectPath)` runs `git -C <projectPath> config user.name` and `user.email` on
  the host. Reading in the project folder means `includeIf "gitdir:~/work/"` identities apply.
  The result is `{ name?, email? }`.
- `ensureIdentity(target, identity)` runs one `sh -c` in the container, as the remote user. For
  each key with a host value, it sets `git config --global <key> <value>` only when
  `git config --global --get <key>` is empty. Values are passed through `--remote-env`
  (`ODH_GIT_NAME`, `ODH_GIT_EMAIL`), not interpolated into the script.
- Log lines:
  - `git: identity set (<name> <email>)` when something was written.
  - `git: identity already set in the container` when nothing was.
  - `git: no user.name/user.email on this machine; commits in the container will fail` when the
    host has none.
  - `git: not found in the container` when the container has no git. The rest is skipped.

`IDENTITY_HINT` in `git.ts` is reworded: opendevhub copies the identity from this machine;
set `user.name`/`user.email` on the host, or in the devcontainer.

## 5. known_hosts

Also in `credentials.ts`:

- `sshHosts(remoteUrls)`: from `git remote -v` output in the project. For scp-style
  (`git@host:path`) and `ssh://` / `git+ssh://` URLs it returns `host` or `[host]:port` (port
  other than 22); https and local remotes are skipped. Duplicates are removed. This sits next to
  `parseRemote` in `forge.ts`, which drops the port, so it can't be reused as is.
- For each host: `ssh-keygen -F <host> -f ~/.ssh/known_hosts` on the host machine. This finds
  hashed entries too. The output's non-comment lines are the entries. No entries: log
  `ssh: <host> is not in known_hosts on this machine; run "ssh <host>" once to verify it`.
- In the container, as the remote user:
  1. Create `~/.ssh` with mode `0700`.
  2. For each host where `ssh-keygen -F <host>` finds nothing in the container's `known_hosts`,
     append the host's lines.
  3. Without `ssh-keygen` in the container, append only lines not already present, by exact
     match.

  The lines go through `--remote-env` (`ODH_KNOWN_HOSTS`) or stdin, not the command line.
- Log: `ssh: added known_hosts for <hosts>` when something was added.

Host aliases from `~/.ssh/config` (`work:team/app.git`) usually aren't in `known_hosts` under the
alias, and the container can't resolve them anyway. They are logged and skipped. This is a known
limitation.

## 6. Dashboard

- `PublicRuntime` (main and task environments) gains `sshAgent?: "forwarded" | "off" |
  "unavailable"` and `sshAgentReason?: string`. Neither is persisted.
- Where the Ports area shows `via relay`, the environment shows a muted badge:
  `ssh-agent forwarded`, or `ssh-agent unavailable` with the reason as a tooltip. Nothing is
  shown for `"off"`.
- No new controls.

## 7. README

- Requirements: replace "opendevhub does not manage credentials" with a note that LLM provider
  credentials still come from the devcontainer (`containerEnv`, `remoteEnv`, mounts), and a link
  to the new section.
- New section **Git and ssh in containers**:
  - Identity is copied when it's missing.
  - The agent is forwarded while opendevhub runs, through the relay. What that means: anything
    running in the container can use your keys, but can't read them.
  - known_hosts entries are copied for the project's ssh remotes.
  - Turn forwarding off with `"customizations": { "opendevhub": { "sshAgent": false } }` or in
    `config.json`.
- Known limitations:
  - ssh config aliases aren't resolved in the container.
  - The agent needs the relay; without it there is no forwarding.
  - https credentials and commit signing aren't handled.

## 8. Testing

Unit and integration (`npm test`):

- **Relay script (run under Node in a temp dir, with the socket path set by an env var for the
  test):**
  - `agent-listen` creates the socket with mode `0600`.
  - A client gets `CONN <id>`; `agent-accept <id>` pipes bytes both ways.
  - An unknown id gets `ERR ENOENT`.
  - A client that isn't accepted is closed after 5 s.
  - A second control connection replaces the first.
  - The socket is removed after the control connection drops.
  - The gateway relay rejects both verbs.
  - A wrong token is still closed without a reply.
- **`AgentTunnel` against the real relay script and a fake agent (a unix server that echoes):**
  - Round trip through the tunnel.
  - The host agent unreachable.
  - `SSH_AUTH_SOCK` unset.
  - Reconnect after the control connection drops.
  - `stop()`.
- **`credentials.ts` with a fake runner:**
  - Host identity read in the project folder.
  - The identity script only sets empty keys.
  - Values go through env, not argv.
  - `sshHosts` for scp, `ssh://` with and without a port, https, local paths and duplicates.
  - known_hosts lines only for hosts the container doesn't know.
- **`resolveEnvSettings`:** `sshAgent` default and precedence.
- **Orchestrator with fakes:**
  - Order: relay → identity → known_hosts → tunnel → opencode.
  - `SSH_AUTH_SOCK` in opencode's env when on and absent when off.
  - `core.sshCommand` set and removed.
  - Tunnel stopped on stop and remove.
  - `sshAgent` status in the public runtime.

E2E (`npm run test:e2e`, real devcontainer):

- The test starts its own `ssh-agent` with a generated key and points opendevhub's
  `SSH_AUTH_SOCK` at it.
- `ssh-add -l` in the container, run from an opencode session's shell (which inherits
  `SSH_AUTH_SOCK`), lists the key's fingerprint. The e2e devcontainer needs `openssh-client`.
- A plain `devcontainer exec` sees opendevhub's `core.sshCommand` in
  `git config --global --get core.sshCommand`. `ssh-add` ignores git config, so it isn't the
  check here.
- `git commit` works in a fresh container with the host identity.
- The same with `OPENDEVHUB_ROUTE=gateway`.
