# opendevhub

A local dashboard that orchestrates [opencode](https://opencode.ai) v2 agents, each running inside its project's devcontainer.

- Discovers projects with a `.devcontainer/devcontainer.json` (or `.devcontainer.json`) under your roots (up to 2 levels deep).
- Starts, stops and rebuilds one devcontainer per project and runs `opencode serve` inside it.
- Shows live session status (running, idle, needs permission, question waiting) and sends browser notifications.
- Opens each project's opencode web UI at `http://<project>.localhost:7777`, already authenticated.
- Overview page puts sessions that need you first; each project has its own page with Sessions, Ports and Logs tabs. Press `Ctrl/⌘ K` to jump to any project or session.
- Forwards the ports listed in each project's `forwardPorts` to `localhost` on your machine while the project runs, using the next free port if one is taken. The dashboard shows each mapping as a link.

## Requirements

- Linux or macOS
- Docker (on macOS: Docker Desktop, OrbStack, Colima or similar), and the devcontainer CLI: `npm i -g @devcontainers/cli`
- Node.js 20 or newer
- opencode v2 installed in each project's devcontainer, either with `npm i -g @opencode/cli@2` (for example in `postCreateCommand`) or with the official installer (`curl -fsSL https://opencode.ai/install | bash`). opendevhub looks for the binary on `PATH`, in `~/.opencode/bin`, `~/.local/bin` and `~/.bun/bin`, and in the `PATH` that bash or zsh set up from their startup files.
- LLM provider credentials available inside the container (via `containerEnv`, `remoteEnv` or mounts). opendevhub does not manage credentials.

## Usage

```bash
npx opendevhub --root ~/code --root ~/work   # roots and port are remembered
npx opendevhub                               # reuse the saved roots
npx opendevhub --port 8080 --no-open
```

Containers keep running when opendevhub exits. The next time it starts, it reconnects to them.

### How opendevhub reaches containers

On Linux with a native Docker engine, opendevhub connects to each container's IP directly. When that IP is not reachable from the host (macOS, where containers live in a VM; rootless Docker; Docker Desktop on Linux), it starts one `opendevhub-gateway` container (`node:22-alpine`) that publishes a single port on `127.0.0.1` and relays to the project containers, joining their Docker networks as needed. The project log says which route a project uses. The gateway is left running when opendevhub exits and is replaced when opendevhub needs a newer one.

| Variable | Effect |
| --- | --- |
| `OPENDEVHUB_ROUTE` | `auto` (default) probes each container IP; `direct` or `gateway` forces a route. On macOS, `auto` only goes direct when something already answers on the container IP, so OrbStack users who want to skip the gateway can set `direct`. |
| `OPENDEVHUB_GATEWAY_IMAGE` | Image for the gateway container (default `node:22-alpine`; it needs `node` on `PATH`). |

## Development

```bash
npm install
npm test                # unit + integration tests
npm run test:e2e        # real devcontainer + opencode (slow, needs Docker)
OPENDEVHUB_ROUTE=gateway npm run test:e2e   # the same, through the gateway (the macOS path)
npm run dev             # API server on :7777
npm run dev:web         # Vite dev server that proxies /api to :7777
npm run build           # dist/bin.js + dist/web
```

On macOS, the port forwarder tests use `127.0.0.2` and `127.0.0.3`, which macOS does not configure by default: `sudo ifconfig lo0 alias 127.0.0.2 up && sudo ifconfig lo0 alias 127.0.0.3 up`.

## Known limitations

- `forwardPorts` entries that name another compose service (for example `"db:5432"`) are not forwarded yet.
- Forwarded ports are only open while opendevhub is running.
- Forwarded ports go through a small relay that opendevhub starts inside the container, so apps bound to the container's `localhost` work too. The relay runs on the opencode binary (Bun mode) or `node`; if neither can run it, forwarding connects directly and only apps listening on `0.0.0.0` are reachable (the project log says so).
- `http://<project>.localhost:7777` relies on the browser resolving subdomains of `localhost` to loopback, as Chrome and Firefox do.
- Containers using `--network=host` are not supported.
- The opencode password is passed through `devcontainer exec --remote-env`, so other users on the same machine can see it in the process list while the command runs.
