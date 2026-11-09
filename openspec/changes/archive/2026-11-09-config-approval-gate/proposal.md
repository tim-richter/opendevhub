## Why

Agents edit the repositories opendevhub starts containers from, `devcontainer.json` included. Some of its keys act on the host rather than in the container: `initializeCommand` runs on the host, and mounts, `runArgs`, `privileged` or a build context outside the repository give a container the host's files. Today opendevhub starts every container from whatever config the checkout holds, so an agent can escape its container on the next start or rebuild. Asking the user before a changed host-affecting config is used closes that.

The approval is only meaningful if an agent can't give it. The dashboard API has no authentication: it relies on binding to `127.0.0.1` and on Host and Origin checks. A process in a container that can reach the host's loopback can call the API directly with any Host header, and approve its own change. Docker Desktop and OrbStack route `host.docker.internal` to the host's loopback (not verified yet). Such a caller can already start tasks, change settings or drive another project's opencode through the environment proxy. So the dashboard needs an access token as part of this change.

## What Changes

- **Dashboard access token.** opendevhub keeps a random token in its state folder.
  - The CLI prints and opens the dashboard URL with the token. `opendevhub open` does the same for a running service.
  - The server exchanges the token for an HttpOnly, SameSite=Strict cookie.
  - Every `/api` route, the event stream, the terminal socket and the environment proxy (`<env>.localhost`) require that cookie. The environment proxy gets its own cookie through a one-time code handed out by the dashboard.
  - Without the cookie, the page shows how to open the dashboard with its link. **BREAKING:** a bookmarked `http://localhost:7777/` needs the link from the terminal once per browser.
- **Host-affecting config.** For every container start, opendevhub reads the checkout's resolved devcontainer configuration and extracts the part that acts on the host:
  - `initializeCommand`;
  - `mounts`, `workspaceMount`, `runArgs`, `privileged`, `capAdd`, `securityOpt` and `appPort`, including what features contribute;
  - the build context's location and the build options;
  - the Docker Compose files' contents.

  A config without any of these needs no approval.

- **Approval gate.** Before a container is built or started, the main environment's and every task environment's (local or on another node), opendevhub compares that part with the ones approved for the project.
  - If none matches, the start stops and the dashboard shows what changed against the last approved config. **Approve** remembers it; **Keep stopped** refuses it.
  - Approvals are kept in the state database and apply to the whole project.
  - Projects already set up are asked once, on their first start after the upgrade, when their config has host-affecting keys.
- **Waiting variants.** A task variant whose container needs approval waits at a new step, **Needs approval**, and goes on when the user approves.
  - **Keep stopped** fails it.
  - A pick or dismissal ends the wait.
  - A restart fails it, as for any other setup step.
- Starting or rebuilding a project's or worktree's container without an approval fails with the pending approval, so its banner offers Approve. Approving retries the start.

## Capabilities

### New Capabilities

- `dashboard-access`: the access token, the cookie it is exchanged for, which routes require it, and how the dashboard and environment proxy are opened with it.
- `container-config-approval`: which devcontainer settings count as host-affecting, approving them per project, gating container builds and starts on that approval, and variants waiting for it.

### Modified Capabilities

<!-- None. The new Needs approval step is a setup step, so "Starting progress survives a restart" in task-persistence already covers a restart during it. -->

## Impact

- **Server:**
  - new modules for the token, the cookie middleware and config approvals.
  - `server.ts`: the cookie check on the dashboard, the terminal upgrade and the environment proxy.
  - `environments/containers.ts`: read the merged configuration.
  - `environments/environments.ts`: the gate in the main and task bring-up; the task image build moves after it.
  - `tasks/checkout-setup.ts`: the waiting step.
  - `cli.ts` and `service.ts`: the URL with the token, and `opendevhub open`.
  - a new database migration for approvals.
- **Shared:** a new `approval` start step and the pending approvals in the dashboard snapshot.
- **Web:**
  - the "open with your link" page.
  - an approval banner with the diff on the project and worktree, and the Needs approval step on variants.
  - environment links go through the one-time code.
- **Tests:** helpers that call the API send the cookie; the e2e harness opens the dashboard with the token.
- **Docs:** a page on access and approvals; Getting started mentions the link.
