# opendevhub

A local dashboard that orchestrates [opencode](https://opencode.ai) v2 agents, each running inside its project's devcontainer.

- Discovers projects with a `.devcontainer/devcontainer.json` (or `.devcontainer.json`) under your roots (up to 2 levels deep).
- Starts, stops and rebuilds one devcontainer per project and runs `opencode serve` inside it.
- Shows live session status (running, idle, needs permission, question waiting) and sends browser notifications.
- Opens each project's opencode web UI at `http://<project>.localhost:7777`, already authenticated.

## Requirements

- Linux (macOS support is planned)
- Docker, and the devcontainer CLI: `npm i -g @devcontainers/cli`
- Node.js 20 or newer
- opencode v2 installed in each project's devcontainer. For example, add `"postCreateCommand": "npm i -g @opencode/cli@2"` to the project's devcontainer.json.
- LLM provider credentials available inside the container (via `containerEnv`, `remoteEnv` or mounts). opendevhub does not manage credentials.

## Usage

```bash
npx opendevhub --root ~/code --root ~/work   # roots and port are remembered
npx opendevhub                               # reuse the saved roots
npx opendevhub --port 8080 --no-open
```

Containers keep running when opendevhub exits. The next time it starts, it reconnects to them.

## Development

```bash
npm install
npm test                # unit + integration tests
npm run test:e2e        # real devcontainer + opencode (slow, needs Docker)
npm run dev             # API server on :7777
npm run dev:web         # Vite dev server that proxies /api to :7777
npm run build           # dist/bin.js + dist/web
```

## Known limitations

- Linux only: the proxy connects to each container's bridge IP directly.
- Containers using `--network=host` are not supported.
- The opencode password is passed through `devcontainer exec --remote-env`, so other users on the same machine can see it in the process list while the command runs.
