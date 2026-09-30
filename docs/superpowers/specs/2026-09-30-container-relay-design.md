# opendevhub — Container Relay Design Spec

Date: 2026-09-30
Status: Draft for review
Extends: `docs/superpowers/specs/2026-09-30-port-forwarding-design.md`

## 1. Purpose

Port forwarding (previous spec) connects to `<containerIP>:<port>`, so only
apps listening on `0.0.0.0` inside the container are reachable. Most dev
servers default to the container's loopback (Vite, Django `runserver`,
Flask, Rails, Jupyter) and refuse those connections, even though the card
shows the port as forwarded. VS Code avoids this by relaying from inside
the container. opendevhub does the same with a small relay process per
project.

### Success criteria

- A container app listening on `127.0.0.1:<port>` or `::1:<port>` only is
  reachable at `http://localhost:<hostPort>` on the host, with no change to
  the project.
- Apps on `0.0.0.0` keep working.
- No new requirement on the devcontainer: the relay runs on the opencode v2
  binary that is already required.
- If the relay cannot run, forwarding keeps working exactly as before (direct
  to the bridge IP) and the log says why.

## 2. Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Mechanism | One long-running relay per project inside the container, listening on `0.0.0.0:4097`; the host forwarder opens one relay connection per client connection. Rejected: one `docker exec` per connection (100–300 ms extra per TCP connection, a host process each). |
| When used | Always, for every forwarded connection, when the relay is up; direct bridge-IP connection is the fallback. |
| Runtime | `BUN_BE_BUN=1 <opencode binary>` (verified: opencode 2.0.20's compiled Bun binary runs `-e <script>` as Bun 1.4.2). Fallback: `node` if on the container's PATH. Neither → no relay. |
| Auth | Per-project random token, sent in the first line of every relay connection; required because the relay port is reachable from other containers on the same Docker network. |
| Targets | The relay only ever connects to `127.0.0.1` and then `::1` inside the container (Node ≥ 17 resolves `localhost` to `::1` first, so Vite often listens on `::1` only). |

## 3. Relay protocol

Client (opendevhub) → relay, first line, `\n`-terminated, max 256 bytes,
within 5 s of connecting:

- `<token> <port>` — `port` is an integer 1–65535.
- `<token> ping`

Relay → client, one line:

- `OK` — connected to `127.0.0.1:<port>` or `::1:<port>`; from now on the
  connection is a raw byte pipe in both directions (bytes after the header
  line in the same chunk are forwarded).
- `ERR <code>` — `code` is `ECONNREFUSED` (nothing listening on either
  loopback) or the Node error code of the second attempt; connection closed.
- `PONG` — answer to `ping`; connection closed.

Invalid header, wrong token (compared in constant time), oversized line or
timeout → the relay closes the connection without replying.

## 4. Design

### 4.1 Units

| Unit | Responsibility |
|---|---|
| `src/server/relay/script.ts` | `RELAY_SCRIPT`: plain JavaScript (CommonJS, `require("node:net")`, no other modules) implementing §3. Reads `ODH_RELAY_PORT` and `ODH_RELAY_TOKEN` from the environment; exits with an error message if the token is missing or listening fails. Begins with the marker comment `/*odh-relay*/` so it can be found with `pkill -f 'odh-[r]elay'`. Runs unchanged under Bun and Node. |
| `src/server/relay/client.ts` | Host side of the protocol: `pingRelay({host, port, token}, timeoutMs)` → `boolean`, and `openRelayConnection({host, port, token}, targetPort)` → resolves `{ socket }` after `OK`, rejects with an error carrying `code` (`ECONNREFUSED`, …) after `ERR`, or with the socket error if the relay itself is unreachable. |
| `src/server/relay/runtime.ts` `RelayRuntime` | `ensureRunning(project, { ip, token, binary, onLine })` → `{ status: "active", via: "bun" \| "node" } \| { status: "unavailable", reason }`. If a ping succeeds, returns active without exec. Otherwise kills any stale relay, then tries the candidates in order — `env BUN_BE_BUN=1 <binary> -e <script>` and `node -e <script>` (only if `command -v node` succeeds) — each launched detached with `nohup` via `devcontainer exec`, token and port passed with `--remote-env`, output to `/tmp/opendevhub-relay.log`; after each launch it pings every 200 ms for up to 5 s. `stop(project)` runs `pkill -f 'odh-[r]elay' || true`. Never throws. |
| `OpencodeRuntime` | Exposes `resolveBinary(project): Promise<string \| undefined>` (the existing lookup, extracted); `ensureRunning` uses it unchanged in behaviour. |
| `PortForwarder` | `open(projectId, target, ports, onLog)` with `target: { host: string; relay?: { port: number; token: string } }`. Per client connection: with `relay` → `openRelayConnection`; on success pipe; on `ERR ECONNREFUSED` log (rate-limited per port) `ports: <port>: nothing is listening on port <port> inside the container` and close the client; on relay unreachable, log (rate-limited) `ports: <port>: relay unreachable (<msg>), connecting directly` and fall back to the direct connection. Without `relay` → today's behaviour. The client socket is paused until the upstream is ready so no bytes are lost. |
| `Orchestrator` | In bring-up, after the container is running: resolve the binary, `relay.ensureRunning`, then `forwardPorts` with the relay target when active, then launch opencode. In `adopt()` for running containers: the same relay step before forwarding. `stop()` calls `relay.stop` (best effort) before stopping the container. Relay outcomes are logged as `relay: active (bun)` / `relay: unavailable (<reason>)` and stored in `runtime.relay`. |
| State | `PersistedRuntime.relayToken` and `ProjectRuntime.relayToken` (32 random bytes, base64url; generated on first need, kept across restarts; never in `PublicRuntime`). `ProjectRuntime.relay?: "active" \| "unavailable"` (public, not persisted). |
| Dashboard | Ports row appends a muted `via relay` or `direct` hint when `runtime.relay` is set. |

### 4.2 Relay port and token handling

- Relay port inside the container: `4097`, a constant next to `OPENCODE_PORT`.
  If it is taken in the container, launch fails its ping → `unavailable`
  (reason: the last line of `/tmp/opendevhub-relay.log`), direct fallback.
- The token is passed via `--remote-env ODH_RELAY_TOKEN=…` (same exposure as
  the opencode password, already documented in the README).

## 5. Error handling

| Situation | Behaviour |
|---|---|
| No opencode binary / no Bun mode and no node | `relay: unavailable (…)`, forwarding direct, project starts normally. |
| Relay process dies later | Each new connection falls back to direct (logged, rate-limited); next Start/adopt relaunches the relay. |
| Container app not running | `ERR ECONNREFUSED` → client closed, one log line per 30 s per port. |
| Wrong token / garbage on the relay port | Relay closes the connection silently. |

## 6. Testing

- **Relay script (unit, real sockets, run under Node via `process.execPath -e RELAY_SCRIPT`):** `OK` + byte pipe to a `127.0.0.1` target; falls back to a `::1`-only target; `ERR ECONNREFUSED` when neither listens; `PONG`; wrong token, malformed header, oversized header and 5 s timeout close without reply; missing token exits non-zero.
- **Relay client (unit):** against the real script — ping true/false; `OK` resolves; `ERR` rejects with `code`; unreachable relay rejects.
- **PortForwarder:** relay path end to end with the real script (target bound to `127.0.0.1` on a different loopback than the direct path would use, so only the relay can reach it); `ERR ECONNREFUSED` logging; fallback to direct when the relay port is closed.
- **RelayRuntime (fake runner + real script for ping):** already running → no exec; launches Bun candidate with env and marker; falls back to node; both fail → unavailable with reason; stop runs the pkill.
- **Orchestrator:** relay started before forwarding and its target passed to the forwarder; unavailable relay → direct target, project still starts; adopt re-ensures the relay; stop stops it; token persisted and reused.
- **E2E:** the fixture's web server listens on `127.0.0.1:8080` only; the test asserts `runtime.relay === "active"` and that `http://127.0.0.1:<hostPort>/` answers through the forward.

## 7. Out of scope

- Relaying ports of other compose services (`"db:5432"`).
- Letting the user choose the relay port.
- Bundling our own relay binary.
