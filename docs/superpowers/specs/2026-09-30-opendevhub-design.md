# opendevhub — Design Spec (MVP)

Date: 2026-09-30
Status: Draft for review

## 1. Purpose

`opendevhub` is a CLI that starts a local web dashboard for orchestrating
multiple opencode agents, each running isolated inside a project's
devcontainer. The dashboard is an **overview and control surface only**: it
starts/stops environments, shows live agent status, and alerts the user when an
agent needs attention. All actual interaction with an agent happens in
opencode's own web UI, opened in a separate browser tab.

### Success criteria

- A user runs `npx opendevhub --root ~/code` and sees every project under that
  root that has a devcontainer spec.
- One click starts a project's devcontainer with an opencode v2 server inside.
- The user sees, per project, which opencode sessions are idle, running, waiting
  for a permission, or waiting for an answer — updated live.
- The user gets a browser notification when a session finishes or needs input.
- One click opens that project's opencode web UI in a new tab, already
  authenticated.

## 2. Assumptions & constraints

- **Platform:** Linux for the MVP (container bridge IPs are reachable from the
  host). macOS is a later phase.
- **Host prerequisites:** Docker daemon running, `devcontainer` CLI
  (`@devcontainers/cli`) on `PATH`, Node ≥ 20.
- **Project prerequisite:** a devcontainer spec at `.devcontainer/devcontainer.json`
  or `.devcontainer.json`. Projects without one are not listed.
- **opencode v2:** the container image provides `opencode` v2 (npm package
  `@opencode/cli`, verified against 2.0.20) on `PATH`. opendevhub does not
  install it; it reports a clear error if missing or `< 2.0.0`.
- **Credentials:** LLM provider credentials inside the container are the
  devcontainer's responsibility (env, mounts, features). opendevhub does not
  manage them.
- **Single user, local only.** The server binds to `127.0.0.1`.

### Verified opencode v2 facts (2.0.20)

- `opencode serve --hostname <h> --port <p>` serves the v2 HTTP API under
  `/api/*` and the full web UI at `/` on the same port.
- Auth: HTTP Basic, username `opencode`, password taken from the
  `OPENCODE_PASSWORD` env var (a random one is generated otherwise). All `/api/*`
  routes return 401 without it.
- Relevant endpoints:
  - `GET /api/info` → `{ version, pid, urls, paths }` (health + version check)
  - `GET /api/session?directory=&limit=` → session list
  - `GET /api/session/active` → `{ data: { [sessionID]: { type: "running" } } }`
  - `GET /api/permission/request` → pending permission requests
  - `GET /api/form` → pending forms (questions to the user)
  - `GET /api/event` → SSE stream of v2 events
  - `POST /api/pair` → one-time browser pairing code (not needed with the proxy)
  - `GET/POST/DELETE /api/worktree` → native worktree management (phase 2)

## 3. Scope

### MVP (this spec)

1. **CLI:** `opendevhub [--root <dir>]... [--port <n>] [--no-open]`. Roots are
   merged into and persisted in `~/.config/opendevhub/config.json`. Default port
   `7777`. Opens the dashboard in the default browser unless `--no-open`.
2. **Discovery:** scan all roots to depth 2 for devcontainer specs. Skip
   `node_modules`, hidden dirs (except `.devcontainer`), and nested matches
   inside an already-found project. A "Rescan" action re-runs it.
3. **Lifecycle per project** (explicit, user-triggered):
   - **Start:** `devcontainer up`, then launch `opencode serve` inside.
   - **Stop:** stop the opencode server, then `docker stop` the container.
   - **Rebuild:** `devcontainer up --remove-existing-container`, then launch
     opencode.
   - Containers and opencode **keep running when opendevhub exits**. On
     startup, opendevhub re-adopts them (see §5.3).
4. **Preflight errors** surfaced per project / globally: Docker unreachable,
   `devcontainer` CLI missing, `opencode` missing in container, opencode
   version `< 2`, opencode failed to become healthy within 30 s.
5. **Live status:** per project — container state and opencode health; per
   session — status badge.
6. **Browser notifications** (Notification API, permission requested on first
   user click) when a session transitions:
   - `running → idle` ("finished")
   - any → `needs-permission`
   - any → `needs-answer`
7. **Open in opencode:** button per project (and per session, if a session deep
   link is supported — see §9) opening `http://<projectId>.localhost:<port>/`
   in a new tab.
8. **Logs:** output of `devcontainer up` and the opencode server is captured and
   viewable in a collapsible per-project panel (last 500 lines, in memory).

### Deferred

- **Phase 2 — Worktree tasks:** create/delete worktrees via opencode's
  `/api/worktree`; show them as sub-rows under a project with their own
  sessions and "Open" links.
- **Phase 3:** macOS support via published ports; start a session with an
  initial prompt from the dashboard; VCS/diff summary per project; token/cost
  stats; multiple containers per project.

### Out of scope

Chat/interaction UI, credential management, remote Docker hosts, multi-user,
authentication of the dashboard itself beyond localhost binding + Host checks.

## 4. Architecture

Single Node.js process, TypeScript, ESM. Monorepo-free: one package with
`src/server/**` (backend) and `src/web/**` (React SPA built by Vite into
`dist/web`, served statically).

```
 browser tab: dashboard          browser tab(s): opencode UI
 http://localhost:7777           http://<id>.localhost:7777
          │  REST + SSE                     │  HTTP / SSE / WS
          ▼                                 ▼
 ┌─────────────────────────── http (Hono) ──────────────────────────┐
 │  Host = localhost  → dashboard API + static SPA                  │
 │  Host = <id>.localhost → reverse proxy (+ Basic auth injection)  │
 │  other Host → 421                                                │
 └───────┬───────────────────────────────────────────┬──────────────┘
         │                                           │
       state ◄──── monitor (per running project) ────┤
         ▲              │ opencode-client            │
         │              ▼                            ▼
   discovery      container IP:4096  ◄──── containers (devcontainer/docker CLI)
                  (opencode serve)          opencode-runtime
```

### 4.1 Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `cli` | Parse args, load/merge/save config, start server, open browser. | config, http |
| `config` | Read/write `~/.config/opendevhub/config.json` (`roots`, `port`) and `state.json`. Respects `XDG_CONFIG_HOME`. | fs |
| `discovery` | `scan(roots): Project[]`. Pure except for fs reads. | fs |
| `containers` | The only unit that shells out. `up(project, {rebuild})`, `stop(containerId)`, `inspect(containerId) → {state, ip}`, `findByLabel()`, `exec(containerId, cmd, env)`. Streams stdout/stderr to a log sink. | `devcontainer`, `docker` CLIs |
| `opencode-runtime` | `ensureRunning(project)`: check `opencode --version` in container, start `opencode serve` detached with `OPENCODE_PASSWORD`, wait for `/api/info` health. `stopServer(project)`. | containers, opencode-client |
| `opencode-client` | Typed fetch wrapper over the v2 endpoints listed in §2, plus an SSE subscription helper. Base URL + Basic auth injected. Prefer `@opencode/client` if it is usable standalone; otherwise hand-written types for the few endpoints used. | fetch |
| `monitor` | One per running project. Maintains `SessionStatus` for that project's sessions from SSE events, with a periodic reconcile poll. Emits `ProjectSnapshot` changes. | opencode-client, state |
| `state` | In-memory store (projects, runtime info, session snapshots) with change subscription; persists runtime info to `state.json`. | config |
| `http` | Hono app. Host-based routing, dashboard REST + SSE, static SPA, reverse proxy (HTTP, SSE streaming, WebSocket upgrade). | state, containers, opencode-runtime |
| `web` | React + Vite SPA: project list, badges, actions, log panel, notifications. | dashboard API |

### 4.2 Data model

```ts
type ProjectId = string; // DNS-label-safe: slug(name) + "-" + hash(path).slice(0,6), ≤ 63 chars

interface Project {
  id: ProjectId;
  name: string;            // directory basename
  path: string;            // absolute host path
  devcontainerPath: string;
}

type ContainerState = "stopped" | "starting" | "running" | "stopping" | "error";

interface ProjectRuntime {
  projectId: ProjectId;
  containerId?: string;
  containerIp?: string;
  containerState: ContainerState;
  opencode: "absent" | "starting" | "healthy" | "unhealthy";
  opencodeVersion?: string;
  password?: string;        // persisted in state.json (mode 0600), never sent to the dashboard
  workspaceFolder?: string; // remoteWorkspaceFolder from `devcontainer up`
  error?: string;
}

type SessionStatus = "idle" | "running" | "needs-permission" | "needs-answer";

interface SessionSummary {
  id: string;
  projectId: ProjectId;
  title: string;
  directory: string;
  updatedAt: number;
  status: SessionStatus;
}
```

Status precedence per session: `needs-permission` > `needs-answer` >
`running` > `idle`. Derived from: pending permission requests (by sessionID),
pending forms (by sessionID), `/api/session/active`.

Phase-2 readiness: `SessionSummary.directory` already distinguishes the main
checkout from future worktrees; a `Worktree` entity will group sessions by
directory without changing the monitor.

## 5. Behaviour

### 5.1 Start

1. `containers.up(project)` runs
   `devcontainer up --workspace-folder <path> --id-label opendevhub.project=<id>`
   (plus `--remove-existing-container` for rebuild). Parse the final JSON line
   for `containerId` and `remoteWorkspaceFolder`. State → `starting`.
2. `docker inspect` → container IP on its (first) network. Containers without
   a bridge IP (e.g. `--network=host`) are unsupported in the MVP → state
   `error` with an explanatory message.
3. `opencode-runtime.ensureRunning`:
   - `devcontainer exec ... opencode --version`; require major ≥ 2.
   - Generate a password (32 random bytes, base64url) if none persisted.
   - Launch detached:
     `devcontainer exec --workspace-folder <path> --remote-env OPENCODE_PASSWORD=<pw> sh -c 'nohup opencode serve --hostname 0.0.0.0 --port 4096 > /tmp/opendevhub-opencode.log 2>&1 &'`
     with the working directory set to `remoteWorkspaceFolder`.
   - Poll `GET /api/info` (Basic auth) every 500 ms up to 30 s.
4. State → `running`/`healthy`; start the project's `monitor`.

If the opencode port is already serving and `/api/info` answers with the
persisted password, step 3 is skipped (idempotent start).

### 5.2 Stop

Stop the monitor, `devcontainer exec ... pkill -f "opencode serve"` (best
effort), then `docker stop <containerId>`. State → `stopped`.

### 5.3 Re-adoption on startup

`docker ps -a --filter label=opendevhub.project` → map labels to discovered
projects. For running containers: load the persisted password, probe
`/api/info`. Healthy → start monitor. Unhealthy/unauthorized → mark
`opencode: "unhealthy"`, offer "Restart opencode" (runs step 3 with a new
password).

### 5.4 Monitor

- On start: full reconcile (`/api/session`, `/api/session/active`,
  `/api/permission/request`, `/api/form`), compute `SessionSummary[]`.
- Subscribe to `/api/event`. On any session/permission/form-related event,
  schedule a debounced (250 ms) reconcile. (Parsing individual event payloads
  into incremental updates is an optimisation, not MVP.)
- Safety net: reconcile every 5 s regardless; if SSE disconnects, reconnect
  with backoff (1 s → 30 s) and keep polling meanwhile.
- If `/api/info` fails 3 times in a row → `opencode: "unhealthy"`.

Open question resolved at implementation time (§9): whether `/api/session`
without `directory` returns sessions across all directories; if not, query per
known directory (the workspace folder in MVP).

### 5.5 Reverse proxy

- `Host` must be exactly `localhost:<port>`, `127.0.0.1:<port>`, or
  `<projectId>.localhost:<port>`; anything else → `421 Misdirected Request`
  (DNS-rebinding protection).
- `<projectId>.localhost` → target `http://<containerIp>:4096`. Strip any
  incoming `Authorization` header; inject `Basic base64("opencode:" + pw)`.
  Rewrite `Host`/`Origin` to the target. Stream request and response bodies
  (SSE must not be buffered). Forward WebSocket upgrades (PTY).
- Project not running → an opendevhub HTML page "Project not running — start it
  from the dashboard" with a link back.

### 5.6 Dashboard API (Host = localhost)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | projects + runtime (no passwords) + sessions |
| POST | `/api/projects/rescan` | re-run discovery |
| POST | `/api/projects/:id/start` | start (async; progress via SSE) |
| POST | `/api/projects/:id/stop` | stop |
| POST | `/api/projects/:id/rebuild` | rebuild |
| POST | `/api/projects/:id/restart-opencode` | relaunch opencode only |
| GET | `/api/projects/:id/logs` | last 500 log lines |
| GET | `/api/events` | SSE: `project.updated`, `sessions.updated`, `log` |

Lifecycle actions on the same project are serialised (a per-project mutex);
a second request while one is in flight returns `409`.

### 5.7 Dashboard UI

- Header: roots, Rescan button, global preflight warnings (Docker / devcontainer
  CLI missing).
- Project list (one card/row per project): name, path, container state pill,
  opencode state, action buttons (Start / Stop / Rebuild / Open), error text,
  expandable logs.
- Under each running project: sessions sorted by `needs-*` first, then
  `updatedAt` desc, each with title, relative time, status badge, and "Open".
- A top summary counter: "N need attention · M running".
- Notifications: fired client-side by diffing consecutive session snapshots;
  clicking a notification focuses the dashboard and highlights the session.
- Styling: plain CSS modules, light/dark via `prefers-color-scheme`. No UI kit.

## 6. Error handling

- Every CLI invocation has a timeout (`devcontainer up`: 15 min; exec: 30 s;
  docker: 15 s). Timeouts and non-zero exits become `runtime.error` with the
  last 20 log lines, state → `error`.
- Global preflight at startup: `docker info` and `devcontainer --version`.
  Failures show a banner; project actions are disabled.
- Proxy upstream errors → `502` with an opendevhub error page.
- Config/state JSON corrupt → back up to `*.bak`, start fresh, log a warning.

## 7. Testing

- **Unit (vitest):** discovery (fixture dirs), project-id slugging, status
  derivation (precedence rules), notification diffing, Host routing /
  rebinding rejection, `devcontainer up` output parsing.
- **Integration:** opencode-client + monitor against a fake v2 server (Hono)
  that mimics the endpoints in §2 and an SSE stream; proxy tests against a fake
  upstream including SSE streaming and WebSocket upgrade.
- **E2E (opt-in, `OPENDEVHUB_E2E=1`):** fixture project whose devcontainer
  installs `@opencode/cli@2`; start → healthy → session list → proxy `/api/info`
  through `<id>.localhost` → stop.

## 8. Tech stack

- Node ≥ 20, TypeScript, ESM, `tsx` for dev, `tsup` for building the CLI.
- Server: Hono + `@hono/node-server`; `http-proxy`-style streaming via Node
  `http` for the proxy and WebSocket upgrades.
- Web: React 19 + Vite.
- Process execution: `execa`.
- Tests: vitest.
- Distribution: npm package `opendevhub` with a `bin` entry.

## 9. Open items to settle during implementation

1. Web UI deep link format for a single session (inspect opencode's SPA
   routes). If unavailable, per-session "Open" falls back to the project root.
2. Whether `/api/event` and `/api/session` are server-wide or scoped per
   directory/location (`location` query params exist on some routes).
3. Whether `@opencode/client` is usable as a standalone dependency or whether
   a hand-written client for ~6 endpoints is simpler.
4. Behaviour of `devcontainer exec` detached processes across container
   restarts (expect: opencode must be relaunched after container restart —
   handled by re-adoption as "unhealthy → Restart opencode").
