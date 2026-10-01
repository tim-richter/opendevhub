# macOS support: the gateway route

## Problem

Every host → container connection (opencode API and proxy, relay, direct port forwarding) went to
the container's bridge IP. That only works where the host shares a kernel with the containers:
Linux with a native engine. On macOS (Docker Desktop, Colima), rootless Docker and Docker Desktop
on Linux, the IP exists in `docker inspect` but is not routable from the host.

## Decision

A `Route` per running project says how the host reaches it:

| Route | opencode / relay | Other container ports (direct fallback) |
| --- | --- | --- |
| `direct` | `<ip>:4096` / `<ip>:4097` | `net.connect(<ip>, port)` |
| `gateway` | loopback tunnels `127.0.0.1:<ephemeral>` | `dial(port)` through the gateway |

The gateway is one long-lived container, `opendevhub-gateway`, running the relay script in remote
mode (`ODH_RELAY_REMOTE=1`) on a `node` image, publishing `127.0.0.1::4097`. Remote mode adds a
`<token> <ip> <port>` request (IP literals only) next to the existing `<token> <port>` and
`<token> ping`. The gateway joins each project container's Docker network
(`docker network connect`), so compose networks work too. Connection chain for a forwarded port:
host listener → gateway → `<ip>:4097` relay → container loopback.

Rejected:

- **Published ports per project** (`runArgs`/`appPort`): fixed at container creation, so adopted
  containers need a rebuild; compose configs need a separate override; host-port clashes.
- **Tunnel over `docker exec` stdio**: works even with `--network=host` and remote engines, but
  needs a multiplexing protocol and makes opencode depend on the in-container relay runtime.

## Route selection

`OPENDEVHUB_ROUTE=auto|direct|gateway` (default `auto`). `auto` probes `<ip>:4097` for 500 ms.
An accepted connection means direct. On Linux, `ECONNREFUSED` also means direct: the container's
kernel answered. Elsewhere a refusal more likely comes from a VPN or firewall, so only an accepted
connection counts; OrbStack users who want direct set `OPENDEVHUB_ROUTE=direct`.

On Linux with a native engine nothing changes: the probe answers immediately, no gateway is
created and every connection takes the same path as before.

## Lifecycle

- Created lazily on the first gateway route; reused across runs when running, of the current
  version (label = hash of image + relay script) and answering a ping. Otherwise `rm -f` + `run`.
- The token is read back from the container's env, and passed to `docker run` through the CLI's
  environment (`-e ODH_RELAY_TOKEN`), not the command line.
- A connection that cannot reach the gateway recreates it (at most every 10 s) and rejoins the
  networks it had.
- Left running when opendevhub exits, like project containers. Tunnels close with the route
  (stop, rebuild, external stop, shutdown).

## Not covered

- `--network=host` containers (no IP; unchanged).
- Remote Docker hosts (`DOCKER_HOST=ssh://…`): the published port is on the remote loopback.
- Hosted CI on macOS cannot run Docker; the gateway path is covered on Linux with
  `OPENDEVHUB_ROUTE=gateway npm run test:e2e`.
