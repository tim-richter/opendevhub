# opendevhub — Port Forwarding Design Spec

Date: 2026-09-30 Status: Draft for review Extends: `docs/superpowers/specs/2026-09-30-opendevhub-design.md`

## 1. Purpose

The `devcontainer` CLI ignores `forwardPorts` in `devcontainer.json`, so apps started inside a devcontainer (dev servers, databases, APIs) are unreachable from the host. opendevhub forwards those ports to the host while a project's container is running, the way VS Code does, so the user can open the app under development at `http://localhost:<port>`.

### Success criteria

- A project whose `devcontainer.json` lists `"forwardPorts": [3000]` has `localhost:3000` on the host connected to port 3000 in the container as soon as the container is running; no user action needed.
- If host port 3000 is taken, the next free port is used and the dashboard shows the real mapping (e.g. `3000 → localhost:3001`) as a clickable link.
- Forwards close when the project is stopped or its container dies, and are restored when opendevhub re-adopts a running container after a restart.
- Any TCP protocol works (HTTP, WebSockets/HMR, Postgres, gRPC).

## 2. Decisions (from brainstorming)

| Topic | Decision |
| --- | --- |
| Mechanism | TCP forwarder inside the opendevhub process (`node:net`), connecting to the container's bridge IP — same reachability assumption as the opencode proxy (Linux). Rejected: subdomain HTTP proxy (HTTP-only, breaks absolute `localhost:<port>` URLs); docker `-p`/`appPort` (fixed at container creation, host clashes fail the container). |
| When | Automatic for every configured port once the container is running. No per-port toggle. |
| Port clash | Try the same port number on the host first; on `EADDRINUSE` try the following ports (up to +100) and report the chosen one. |
| Lifetime | Forwards live in the opendevhub process only; they end when opendevhub exits and are re-created on adoption. Containers keep running regardless (unchanged). |
| Bind address | `127.0.0.1` only. |

## 3. Scope

### In scope

1. Read `forwardPorts` and `portsAttributes` via `devcontainer read-configuration --workspace-folder <path> --id-label opendevhub.project=<id> --include-merged-configuration` (handles JSONC, `extends` and feature-contributed ports). Use `mergedConfiguration` when present, else `configuration`.
2. Accepted entries: integers 1–65535, and strings `"<n>"`, `"localhost:<n>"`, `"127.0.0.1:<n>"`. Duplicates collapse to one. `portsAttributes["<n>"].label` becomes the port's label.
3. Other entries (e.g. `"db:5432"` for compose services, malformed values) are reported as skipped with a reason; they never block the project.
4. Forwarding lifecycle wired into the orchestrator: start, rebuild, adopt, stop, external stop (via `refreshContainers`), shutdown.
5. Dashboard: a "Ports" row on the project card listing each port.

### Out of scope

- Auto-detecting ports the app opens at runtime ("dynamic" forwarding).
- Compose service hosts (`"service:port"`).
- `portsAttributes` behaviours other than `label` (`onAutoForward`, `requireLocalPort`, `protocol`, `elevateIfNeeded`).
- Forwarding on macOS (depends on the macOS phase of the main spec).
- Persisting chosen host ports across opendevhub restarts.

## 4. Design

### 4.1 Units

| Unit | Responsibility |
| --- | --- |
| `Containers.readConfiguration(project)` (`src/server/containers.ts`) | Runs the command in §3.1 (timeout 60 s). Returns `{ forwardPorts: unknown[]; portsAttributes: Record<string, { label?: string }> }`. Non-zero exit or unparsable output → `CommandError`. |
| `src/server/ports.ts` (pure) | `parseForwardPorts(forwardPorts: unknown[], portsAttributes): { ports: PortSpec[]; skipped: SkippedPort[] }` per §3.2–3.3. |
| `src/server/port-forwarder.ts` | `PortForwarder` with `open(projectId, targetHost, ports: PortSpec[]): Promise<ForwardedPort[]>`, `close(projectId): Promise<void>`, `closeAll(): Promise<void>`. One `net.Server` per forwarded port. Each accepted socket opens `net.connect(targetPort, targetHost)` and pipes both ways; an error or close on either side destroys both. `open` on a project that already has forwards closes them first. |
| `src/server/orchestrator.ts` | Calls read → parse → `forwarder.open` after the container is running with an IP (inside `bringUp`, before launching opencode, so a failing opencode does not prevent forwarding), and in `adopt()` for running containers. Calls `forwarder.close` in `stop`, before `rebuild`'s bring-up, when `refreshContainers` sees the container stopped, and `closeAll` in `shutdown()`. Forwarding failures become log lines plus per-port `failed` status; they never change `containerState`/`opencode` or set `runtime.error`. |
| `src/shared/types.ts` | New types below; `ProjectRuntime.ports?: ForwardedPort[]` (part of `PublicRuntime`, not persisted). |
| `src/web/components/ProjectCard.tsx` (+ a small `PortsRow.tsx`) | Renders `runtime.ports`. |

```ts
interface PortSpec {
  containerPort: number;
  label?: string;
}
interface SkippedPort {
  entry: string;
  reason: string;
}
type ForwardedPort =
  | {
      containerPort: number;
      label?: string;
      status: "forwarded";
      hostPort: number;
    }
  | { containerPort: number; label?: string; status: "failed"; reason: string }
  | { entry: string; status: "skipped"; reason: string };
```

### 4.2 Host port selection

For each spec, try `hostPort = containerPort, containerPort + 1, …` up to `containerPort + 100` (never above 65535), binding `127.0.0.1`. The first successful `listen` wins. Ports held by opendevhub's own other forwards count as busy (they are, via `EADDRINUSE`). If all candidates fail → `status: "failed", reason: "no free host port in <from>–<to>"`. Other listen errors (e.g. `EACCES` for ports < 1024 as non-root) → `failed` with the error message; no further candidates are tried for that error.

### 4.3 Connection handling

- Upstream refused/unreachable (app not started yet): the client socket is destroyed; the listener keeps running. No log spam: at most one log line per port per 30 s for upstream errors.
- Half-close is propagated (`allowHalfOpen: true` on both sides, `end` on end).
- `close(projectId)` stops listening and destroys all open connections of that project, then resolves.

### 4.4 Dashboard

Ports row under the action buttons, only when `runtime.ports` is non-empty:

- forwarded: `<label ?? "port"> · <containerPort> → localhost:<hostPort> ↗`, a link to `http://localhost:<hostPort>/` opening in a new tab; if `hostPort !== containerPort` the host port is emphasised.
- failed: muted `<containerPort> not forwarded`, reason in `title`.
- skipped: muted `<entry> skipped`, reason in `title`.

### 4.5 Security

Listeners bind `127.0.0.1` only. Forwarded apps are exposed to local processes and the local browser exactly as with VS Code; opendevhub adds no auth and no origin checks on forwarded ports (they are raw TCP).

## 5. Error handling

| Situation | Behaviour |
| --- | --- |
| `read-configuration` fails | Log line `ports: could not read devcontainer configuration: …`; `runtime.ports = []`; project start continues. |
| Unsupported entry | `skipped` with reason; logged once per start. |
| No free host port / listen error | `failed` with reason; other ports unaffected. |
| Container IP changes (rebuild, restart) | Forwards are closed and re-opened against the new IP by the lifecycle hooks. |

## 6. Testing

- **Unit:** `parseForwardPorts` (numbers, `"3000"`, `"localhost:3000"`, `"127.0.0.1:3000"`, `"db:5432"`, `0`, `70000`, `"abc"`, duplicates, labels). `readConfiguration` argument building and output parsing (merged vs plain, missing fields, non-zero exit) with the fake runner.
- **Integration (real sockets):** `PortForwarder` against local TCP echo servers — bytes flow both ways; clash moves to next port; `close` frees the port and ends open connections; dead upstream does not crash and the listener survives; re-`open` replaces previous forwards; EACCES-style failure reported as `failed`.
- **Orchestrator:** forwards opened on start/rebuild/adopt with the container IP; closed on stop, external stop, shutdown; read failure does not fail start; opencode failure still leaves ports forwarded.
- **E2E:** fixture gains `"forwardPorts": [8080]` and a `postStartCommand` starting a tiny Node HTTP server on 8080; the test asserts `runtime.ports` shows port 8080 as forwarded and that `http://127.0.0.1:<hostPort>/` answers. (If a backgrounded `postStartCommand` process does not survive, the test starts the server via `devcontainer exec` with `nohup` instead.)

## 7. Open items to settle during implementation

1. Whether `--include-merged-configuration` requires a running container or `--id-label` to resolve features; the call happens after `devcontainer up`, so both are available.
