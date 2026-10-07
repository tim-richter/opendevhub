# opendevhub

A local dashboard that orchestrates [opencode](https://opencode.ai) v2 agents, each running inside its project's devcontainer.

- Discovers projects with a `.devcontainer/devcontainer.json` (or `.devcontainer.json`) under your roots (up to 2 levels deep). Git repos without one can be added with **Add project**.
- Starts, stops and rebuilds one devcontainer per project and runs `opencode serve` inside it.
- Shows live session status (running, idle, needs permission, question waiting) and sends [browser notifications](#notifications), even with the dashboard tab closed.
- Opens each project's opencode web UI at `http://<project>.localhost:7777`, already authenticated.
- Overview page puts sessions that need you first; each project has its own page with Sessions, Review and Runtime (forwarded ports and logs) tabs. Press `Ctrl/⌘ K` to jump to any project or session.
- Creates git worktrees for parallel agent sessions in a folder next to the project (`~/code/demo.worktrees/<branch>`), mounted into the container, so you can open and edit them on your machine. See [Worktrees](#worktrees).
- "Open in…" menu for the project and each worktree: attaches VS Code to the container, or opens the checkout in VS Code, Cursor, Zed, JetBrains IDEs, Neovide or Neovim in your terminal. Only editors found on your machine are listed.
- Forwards the ports listed in each project's `forwardPorts` to `localhost` on your machine while the project runs, using the next free port if one is taken. The dashboard shows each mapping as a link.

## Requirements

- Linux or macOS
- Docker (on macOS: Docker Desktop, OrbStack, Colima or similar), and the devcontainer CLI: `npm i -g @devcontainers/cli`
- Node.js 22.13 or newer
- opencode v2 installed in each project's devcontainer (**Add project** sets this up for you), either with `npm i -g @opencode/cli@2` (for example in `postCreateCommand`) or with the v2 installer (`curl -fsSL https://opencode.ai/v2/install | bash`; `opencode.ai/install` installs v1). opendevhub looks for the binary on `PATH`, in `~/.opencode/bin`, `~/.local/bin` and `~/.bun/bin`, and in the `PATH` that bash or zsh set up from their startup files.
- LLM provider credentials available inside the container (via `containerEnv`, `remoteEnv` or mounts). Git and ssh are set up for you: see [Git and ssh in containers](#git-and-ssh-in-containers).

## Usage

```bash
npx opendevhub --root ~/code --root ~/work   # scan these directories for this run
npx opendevhub                               # scan the current directory
npx opendevhub --port 8080 --no-open
```

`--root` is optional. When omitted, opendevhub scans the current directory. Use `--root` to scan other directories for this run; roots are never saved. The dashboard port is remembered.

Containers keep running when opendevhub exits. The next time it starts, it reconnects to them.

### How opendevhub reaches containers

On Linux with a native Docker engine, opendevhub connects to each container's IP directly. When that IP is not reachable from the host (macOS, where containers live in a VM; rootless Docker; Docker Desktop on Linux), it starts one `opendevhub-gateway` container (`node:22-alpine`) that publishes a single port on `127.0.0.1` and relays to the project containers, joining their Docker networks as needed. The project log says which route a project uses. The gateway is left running when opendevhub exits and is replaced when opendevhub needs a newer one.

| Variable | Effect |
| --- | --- |
| `OPENDEVHUB_ROUTE` | `auto` (default) probes each container IP; `direct` or `gateway` forces a route. On macOS, `auto` only goes direct when something already answers on the container IP, so OrbStack users who want to skip the gateway can set `direct`. |
| `OPENDEVHUB_GATEWAY_IMAGE` | Image for the gateway container (default `node:22-alpine`; it needs `node` on `PATH`). |
| `OPENDEVHUB_PUSH` | Where Publish runs git: `host` or `container`. Default: the host when the checkout works there, else the container. |

## Add project

The **+** next to Projects in the sidebar (or **Add project…** in `⌘K`) lists the git repos under your roots that have no devcontainer. Pick one and opendevhub writes `.devcontainer/devcontainer.json` with a base image for its stack and the opencode v2 installer (`curl -fsSL https://opencode.ai/v2/install | bash`) as `postCreateCommand`, then starts the project. The file is left uncommitted, so you can change it, commit it or delete it.

| Found in the repo | Image (`mcr.microsoft.com/devcontainers/…`) |
| --- | --- |
| `package.json` | `javascript-node:22` |
| `pyproject.toml`, `requirements.txt`, `setup.py` | `python:3` |
| `go.mod` | `go:1` |
| `Cargo.toml` | `rust:1` |
| `Gemfile` | `ruby:3` |
| `pom.xml`, `build.gradle(.kts)` | `java:21` |
| `*.csproj`, `*.sln` | `dotnet:8.0` |
| `composer.json` | `php:8` |
| anything else | `base:ubuntu` |

The first match wins, and you can pick another image in the dialog.

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

## Checks

The commands a change must pass before it's published (tests, lint, a Docker build), defined per project and run from the Review tab:

```jsonc
"customizations": {
  "opendevhub": {
    "checks": [
      { "name": "test", "command": "pnpm test" },
      { "name": "image", "command": "docker compose build", "where": "host" }
    ]
  }
}
```

- `where: "container"` (default) runs in the checkout's container; `"host"` runs on this machine in the checkout's folder, with your own Docker, and only after you approve the exact command once. In a worktree, `COMPOSE_PROJECT_NAME` is set to `<project>-<branch>`.
- **Checks** in the project's settings (the gear on the project page) edits a list of your own, saved in `config.json`, which replaces the one in `devcontainer.json`.
- Results belong to the commit they ran on. **Publish…** warns when they haven't all passed there, and **Ask agent to fix** hands failures to a session.

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

## Git and ssh in containers

Every container opendevhub starts (the project's and each worktree's own) is set up for git when it starts or is reconnected:

- **Identity.** `user.name` and `user.email` are copied from git on your machine, read in the project folder so `includeIf` identities apply. They are only set when the container has none; values it already has are kept.
- **ssh-agent.** Your agent (`SSH_AUTH_SOCK`) is forwarded into the container at `/tmp/opendevhub-ssh-agent.sock` through the relay, so `git fetch`, `git pull`, `git push` and private git dependencies work over ssh. opencode gets `SSH_AUTH_SOCK`, and git's `core.sshCommand` uses the socket so terminals and VS Code use it too (unless the container sets its own `core.sshCommand`). The agent is only reachable while opendevhub runs; when it isn't, git falls back to the shell's own `SSH_AUTH_SOCK` (VS Code's forwarded agent, for example). Your private keys never enter the container, but anything running in it, the agent included, can use them while it's forwarded.
- **known_hosts.** For each ssh remote of the project, the matching entries from your `~/.ssh/known_hosts` are added to the container's. Hosts you haven't connected to from your machine are skipped; the log says to `ssh` to them once.

The checkout page shows whether the agent is forwarded. To turn forwarding off for a project:

```jsonc
"customizations": { "opendevhub": { "sshAgent": false } }
```

or, in `~/.config/opendevhub/config.json`: `"projects": { "/path/to/repo": { "sshAgent": false } }`. It takes effect the next time the container starts or opendevhub restarts. An opencode server started before forwarding was set up picks up `SSH_AUTH_SOCK` after **Restart opencode**.

## Notifications

Click **Enable notifications** in the sidebar to get a notification when:

- an agent asks for a permission. Chrome, Edge and other Chromium browsers show **Allow once** and **Reject** buttons that answer it without opening the dashboard; Firefox and Safari show the notification without buttons.
- an agent asks a question.
- a session finishes.

Each permission and question gets its own notification. Clicking one takes you to its session, in an open dashboard tab or a new one. Notifications answered in the dashboard are closed.

They arrive while the dashboard tab is closed, as long as the browser is running: opendevhub sends them by Web Push through the browser vendor's push service (Google's for Chrome, Edge and Brave, Mozilla's for Firefox, Apple's for Safari), so it needs internet access to that service. The contents are end-to-end encrypted. If it can't reach the service, the terminal says so. To check the setup, use **Send test notification** in `Ctrl/⌘ K`.

Notifications are enabled per browser and address: opening the dashboard on another host name or port (`127.0.0.1` instead of `localhost`, or `--port`) means enabling them again there. The keys and subscriptions are in `~/.local/state/opendevhub/push.json`.

## Forgejo pull requests

Open **Settings** in the sidebar, enable **Forgejo**, and save your instance URL and access token.
Forgejo is optional and disabled by default. Use a token with `read:user`, `read:repository`, and `read:issue`
scopes, with access to the private repositories you want to see. The URL must use HTTPS;
HTTP is supported for local instances at `localhost`, `127.0.0.1`, or `::1`.

The **Forgejo** sidebar link appears when enabled and opens a page with all pull requests authored by the
connected account across repositories accessible to the token, even without a local project.
The page defaults to **All**, including closed and merged PRs; use **Open** or **Closed / merged** to filter.
Select one to see its syntax-highlighted diff in unified or side-by-side layout. **Refresh**
reloads the list or diff; **Open in Forgejo** opens the original PR.

Settings survive restarts in `$XDG_CONFIG_HOME/opendevhub/integrations/forgejo.json`
(default `~/.config/opendevhub/integrations/forgejo.json`). This separate file has mode `0600`
inside a `0700` directory. It contains the URL, enabled state, and an opaque credential reference.
The token is stored in your OS credential store: macOS Keychain, Windows Credential Manager,
or Secret Service on Linux (such as GNOME Keyring or KWallet). Linux needs an unlocked,
persistent Secret Service in your desktop session. An unavailable or locked credential store
produces an error; there is no plaintext or volatile-keyring fallback.

Existing plaintext tokens are migrated into the credential store before use and removed from
the settings file only after credential storage succeeds. The saved token is never returned by
the API, put in browser storage, or injected into task containers. Changing the instance URL
requires a new token. Disabling keeps the credential for later; **Remove token and disable**
deletes it from the OS store.

This view is read-only: PR comments, approvals and merging remain on Forgejo. It uses the
Forgejo REST API independently of the existing git-based Publish action. Responses larger than
20 MiB show an error and can be opened on Forgejo instead.

## Remote nodes (preview)

Other machines can run task environments, reached over ssh. Add one on the Nodes page, or with
`opendevhub nodes add tim@workstation --label Workstation` (then restart opendevhub). The Nodes
page shows whether each node is reachable and ready, and how much CPU and memory it has free.

To run a task there, pick the node in the New task form. It gets a new worktree with its own
container on that node: opendevhub pushes the base branch (the one you choose, or the main
checkout's current branch) into a repository it keeps under `~/.opendevhub/repos` on the node,
creates the worktree there, and starts the container with the node's Docker. Uncommitted changes
in your main checkout stay behind.

Sessions, permissions, forwarded ports, review, commit and Update from base work as for local
tasks. **Bring home** (in the review's Git menu) fetches the branch into this machine's repository;
Merge into base and Publish do that first. Removing the task deletes its worktree and branch on the
node, so bring the branch home first to keep its commits. Checks and Open in editor aren't
available for tasks on other nodes yet.

A node needs:

- Docker, the devcontainer CLI and git 2.48 or newer, on the PATH of a **non-interactive** ssh
  shell. Tools installed through nvm or a login profile often aren't: check with
  `ssh tim@workstation 'devcontainer --version'`, and if it fails, link the binary into
  `/usr/local/bin` or set PATH in `~/.ssh/environment` (with `PermitUserEnvironment yes`).
- An ssh key that logs in without a prompt, and a known host key: run `ssh tim@workstation` once.
- `AllowTcpForwarding yes` in its sshd config (the default).
- A Linux Docker engine: containers are reached at their IP from the node itself.

opendevhub keeps one ssh connection per node (a ControlMaster under
`~/.config/opendevhub/ssh/`) and reconnects by itself when a node drops. Meanwhile its tasks show
as offline. Containers keep running there and are picked up again when the node is back. Nothing is
installed on the node and nothing listens there besides sshd.

## Development

This is a pnpm workspace:

- `apps/opendevhub`: the CLI, server and dashboard (published to npm as `opendevhub`)
- `apps/docs`: the documentation site at https://tim-richter.github.io/opendevhub/ ([Waku](https://waku.gg) + [Fumadocs](https://fumadocs.dev)), content in `apps/docs/content/docs`

```bash
pnpm install
pnpm test               # unit + integration tests
pnpm test:e2e           # real devcontainer + opencode (slow, needs Docker)
OPENDEVHUB_ROUTE=gateway pnpm test:e2e   # the same, through the gateway (the macOS path)
pnpm dev                # API server on :7777
pnpm dev:web            # Vite dev server that proxies /api to :7777
pnpm dev:docs           # docs site
pnpm build              # apps/opendevhub/dist (bin.js + web) and apps/docs/dist
```

### Releasing

Releases use [Changesets](https://github.com/changesets/changesets):

1. In a PR that changes `opendevhub`, run `pnpm changeset`, pick the bump (patch/minor/major) and describe the change for users. Commit the generated `.changeset/*.md`.
2. Once CI (typecheck, unit tests and build) passes on `main`, the Release workflow opens (or updates) a **chore: version packages** PR that bumps the version and writes `apps/opendevhub/CHANGELOG.md`.
3. Merging that PR runs CI and then the Release workflow again: it builds, publishes to npm with provenance, pushes the `opendevhub@x.y.z` tag and creates a GitHub release.

npm auth: configure [trusted publishing](https://docs.npmjs.com/trusted-publishers) for `opendevhub` (repo `tim-richter/opendevhub`, workflow `release.yml`). The package has to exist on npm before that can be set up, so the first release needs an `NPM_TOKEN` repository secret (a granular token with publish rights); remove the secret once trusted publishing is configured.

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
- ssh host aliases from `~/.ssh/config` (remotes like `work:team/app.git`) are not resolved inside containers.
- ssh-agent forwarding needs the relay; when the relay can't run, the agent isn't forwarded (the checkout page and log say so).
- https git credentials and commit signing (GPG or ssh) are not set up in containers.
