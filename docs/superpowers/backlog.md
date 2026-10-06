# Backlog

Features discussed but not specced yet. Each one is a sketch; it gets a spec in `specs/`
once it's picked up. Specced so far: respond inline, tasks, review, publish, per-task
environments, git identity and ssh-agent forwarding (the git half of credential setup), add project,
usage tracking, resource stats, cleanup.

opencode 2.0.22 endpoints that make an item cheaper are noted where they exist. They come from
the live server's `/openapi.json`.

## High value

- **Notifications on your phone.** Web Push reaches this computer's browser. Add outgoing
  webhooks to ntfy, Pushover, Slack or a generic URL.
- **Remote access.** An opt-in bind beyond loopback (e.g. a Tailscale IP) with dashboard
  authentication, so you can approve from your phone. Today the server binds 127.0.0.1 and only
  checks the Host header. This pairs with the notifications item.
- **Credential setup.** The biggest onboarding wall: today every user wires up LLM keys, git
  and ssh by hand. Git identity and ssh-agent forwarding are specced
  (`2026-10-05-git-ssh-credentials-design.md`). What's left:
  - Mount or inject provider keys, and https git credentials.
  - opencode exposes `/api/credential` and `/api/integration/*/connect/{key,oauth}`, so the
    dashboard could connect providers in each container without touching files.
- **Network egress allowlist + auto-approve policy.** Default-deny outbound traffic with an
  allowlist (iptables in the container, as in Anthropic's `init-firewall.sh`, or a proxy in
  the gateway). Once egress is fenced, a per-project "auto-approve" policy becomes reasonable,
  and that removes most of the interruptions. opencode sessions accept `permissions[]` rules
  when created and through PATCH.

## Medium

- **Terminal in the browser** (xterm.js), to step in when an agent is stuck. opencode has a PTY
  API (`/api/pty`, `/api/pty/:id/connect` over WebSocket) and persistent PTYs, so this needs no
  `docker exec` plumbing.
- **Resource stats** per environment from `docker stats` (CPU, memory), shown on project and
  environment tiles.
- **Idle auto-stop for main environments.** The per-task environments spec covers task
  containers; extend it to whole projects, as an opt-in.
- **Forward compose service ports** (`"db:5432"` in `forwardPorts`): a known limitation in the
  README.
- **Tasks from issues.** Turn a Forgejo, GitHub or GitLab issue into a task and link the PR
  back. This needs the forge APIs listed under "later" in the publish spec.

## Later / speculative

- **Scheduled and reactive tasks.** Cron prompts, such as nightly dependency bumps, and
  watching a PR's CI so a failure starts a "fix CI" session.
- **Per-task environments for Docker Compose projects.** A generated override that drops host
  ports, plus `COMPOSE_PROJECT_NAME` per environment. This is phase 6 of the per-task
  environments spec.
- **Agents other than opencode, through ACP.** Only if supporting other agents becomes a goal.
  It would be a second, thinner backend behind an `AgentBackend` interface; the HTTP API stays
  the rich path for opencode. Decided against for now (see the discussion on PR #5).
- **Review polish.** Syntax highlighting, a side-by-side diff, and reviewing existing forge PRs.
- **GitLab `merge_request.*` push options,** the GitLab counterpart to Forgejo's AGit
  publishing.
- **Bulk "allow all"** for a session with several identical permission requests.

## Upstream

- **devcontainers/cli: `--skip-on-create`** for `up` and `run-user-commands`, mirroring
  `--skip-post-create`. It would replace marker stamping in the per-task environments
  `snapshot` mode. Include the reproduction of lifecycle commands running twice and of the
  marker behaviour.

## Decided against

- **A kanban board.** It's a commodity view that doesn't keep users: Vibe Kanban went open
  source after shutting down, and Crystal was deprecated.
- **Copying or cloning dependency folders** (`node_modules` etc.) into worktrees: too much
  magic. Projects install through their own lifecycle commands.
- **A shared Docker network per project** for task environments: not needed.
