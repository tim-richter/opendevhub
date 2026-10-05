# opendevhub

A local dashboard that orchestrates [opencode](https://opencode.ai) v2 agents, each running inside its project's devcontainer.

- Discovers projects with a `.devcontainer/devcontainer.json` (or `.devcontainer.json`) under your roots (up to 2 levels deep).
- Starts, stops and rebuilds one devcontainer per project and runs `opencode serve` inside it.
- Shows live session status (running, idle, needs permission, question waiting) and sends browser notifications.
- Opens each project's opencode web UI at `http://<project>.localhost:7777`, already authenticated.
- Overview page puts sessions that need you first; each project has its own page with Sessions, Ports and Logs tabs. Press `Ctrl/⌘ K` to jump to any project or session.
- Creates git worktrees for parallel agent sessions in a folder next to the project (`~/code/demo.worktrees/<branch>`), mounted into the container, so you can open and edit them on your machine. See [Worktrees](#worktrees).
- "Open in…" menu for the project and each worktree: attaches VS Code to the container, or opens the checkout in VS Code, Cursor, Zed, JetBrains IDEs, Neovide or Neovim in your terminal. Only editors found on your machine are listed.
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
| `OPENDEVHUB_PUSH` | Where Publish runs git: `host` or `container`. Default: the host when the checkout works there, else the container. |

## Publish

The Review tab's **Publish** panel pushes a branch and opens a pull request on the forge, with no `gh` and no tokens.

- The push runs on your machine with your own ssh-agent and credential helpers (so pre-push hooks run there too). If the checkout isn't usable on the host, it runs in the container instead. `OPENDEVHUB_PUSH=host|container` forces one. Git never prompts for credentials: a missing one fails the push.
- The forge is detected from the remote URL: the `forges` map in `config.json` first, then the built-in hosts (`github.com`, `gitlab.com`, `codeberg.org`, `bitbucket.org`), then a one-time unauthenticated probe of the host's Forgejo/Gitea API. The result is cached in `config.json`; delete the entry to probe again. Unreachable hosts aren't cached.
- Forgejo and Gitea default to AGit (`refs/for/<base>`), which opens the PR on push. Other forges push the branch and open a pre-filled compare page.
- Opendevhub never force-pushes. If the remote branch has commits yours doesn't, pull them and publish again.

To tell opendevhub about a host, or an ssh alias it can't probe, add it to `config.json`:

```json
{
  "forges": {
    "git.example.com": { "kind": "forgejo" },
    "work": { "kind": "gitlab", "web": "https://gitlab.example.com" }
  }
}
```

`kind` is one of `github`, `gitlab`, `forgejo`, `gitea`, `bitbucket` or `unknown`; `web` is the site's origin, needed when the remote host is an ssh alias (`work:team/app.git`).

## Tasks

**New task** (on the Overview and project pages, in `⌘K`, or press `n`) starts agent work from a prompt, without opening the opencode tab. By default it creates a worktree on a branch named after the prompt's first line (`-2`, `-3`… when taken), starts a session there and sends the prompt. **Main checkout** runs it in the project folder instead.

**Compare with another model** runs the same prompt on up to four models, each in its own worktree (`<branch>-<model>`). The task page shows each variant's status, cost, tokens and changes, with a Review link. **Pick this one** hides the other variants and can remove their worktrees and branches (after a confirmation that lists uncommitted changes).

A task is stored in its sessions' opencode metadata (`metadata.opendevhub`), so it survives restarts of opendevhub and of the container.

## Worktrees

When opendevhub starts a container it bind-mounts `<project>.worktrees` (created next to the project) at `<workspaceFolder>.worktrees` in the container. The project's **Worktrees** tab creates a branch and worktree there with `git worktree add` inside the container, and can start an opencode session in it straight away.

- Because the folder sits next to the checkout on both sides, worktrees are created with `--relative-paths`, so git works in them on your machine too. This needs git 2.48 or newer on your machine and in the container, and the workspace folder must have the same name as the project folder (the default `/workspaces/<name>`). Otherwise opendevhub falls back to absolute links: the files are still on your machine, but git commands in the worktree only work inside the container.
- Relative links set `extensions.relativeWorktrees` in the repository. Tools built on libgit2 (some git GUIs and editor git integrations) can't open such a repository yet. Set `OPENDEVHUB_RELATIVE_WORKTREES=0` to always use absolute links.
- Containers created before this feature don't have the mount. The Worktrees tab offers a rebuild.
- Worktrees that opencode or a shell create elsewhere in the container are listed too, but they only exist inside the container. VS Code can still attach to them.
- Sessions running in a worktree are tagged with its branch, and their permission requests and questions show up like any other session's.

Editors are launched by the opendevhub process, so it needs your desktop session's environment (`DISPLAY`/`WAYLAND_DISPLAY`). Neovim opens in `$TERMINAL`, or the first of kitty, ghostty, wezterm, alacritty, foot, gnome-terminal, konsole or xfce4-terminal it finds. Attaching VS Code needs the Dev Containers extension.

## Own containers for worktrees

A worktree can run in its own devcontainer, with its own opencode, processes, ports and `$HOME`, so parallel agents don't trip over each other's dev servers or databases. Choose **Run in its own container** from a worktree's container menu (the box icon on its card or page), or **Environment: Own container** in the New task dialog.

- The container starts from an image built once per project and devcontainer config (`opendevhub/<project>:<key>-base`). All lifecycle commands run in each container, so a task gets its own `npm ci`.
- Make it the default for a project in `devcontainer.json`:

  ```jsonc
  "customizations": {
    "opendevhub": {
      "isolation": "isolated",            // "shared" (default) | "isolated"
      "keyFiles": ["package-lock.json"]   // files whose change means a new image
    }
  }
  ```

  or, for a repo you don't own, in `~/.config/opendevhub/config.json`: `"projects": { "/path/to/repo": { "isolation": "isolated" } }`.
- Git commands (review, commit, merge, worktree add and remove) still run in the project's container, which has to be running.
- Removing a worktree's container deletes the sessions that ran in it; the worktree and its files stay.

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
- Worktree folder paths containing a comma can't be mounted (Docker's `--mount` syntax).
- The opencode password is passed through `devcontainer exec --remote-env`, so other users on the same machine can see it in the process list while the command runs.
- Own containers don't support Docker Compose configs, `appPort`, `runArgs` that publish ports, host networking, or lifecycle commands that use `${containerWorkspaceFolder}`; such projects run tasks in the shared container and say why.
- A Dockerfile whose build context reaches outside `.devcontainer` can change without opendevhub noticing; remove the `opendevhub/<project>:*` images to force a rebuild.
