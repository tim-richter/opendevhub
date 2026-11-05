## 1. Server: resolve targets

- [x] 1.1 Add host-path → environment resolution to `Environments`: find the project whose folder or worktrees folder contains a host path, map it to the container folder (`project.path ↔ workspaceFolder`, worktree root mapping), and pick the task or main environment
- [x] 1.2 Add name resolution (env id or branch) with "not found" / "ambiguous" errors listing candidates; remote environments only by name
- [x] 1.3 Return a `CliTarget` (project, env, branch, node, state, and when running the exec target with container folder and ssh target), reusing `terminalTarget`'s remoteEnv probe
- [x] 1.4 Unit tests for folder → env (repo subfolder, task worktree, shared-container worktree, outside any project) and name matching

## 2. Server: API

- [x] 2.1 Add `GET /api/cli/target?dir=&name=` and `GET /api/cli/envs?dir=` behind the dashboard cookie, with request validation
- [x] 2.2 Make sure `ApprovalRequiredError` from the start routes carries the pending settings in a form the CLI can print
- [x] 2.3 API tests for both endpoints, including the unregistered-folder and ambiguous-name errors

## 3. Shared exec command

- [x] 3.1 Extend `terminalCommand` with a `tty` flag and an explicit command, keeping the dashboard's call unchanged
- [x] 3.2 Add the default-shell fallback wrapper (`$SHELL` name if allowed and present, else bash, else sh)
- [x] 3.3 Unit tests for local and ssh-wrapped command lines, with and without TTY

## 4. CLI

- [x] 4.1 Add a small local API client: read port from config, derive the `odh` cookie via `Access`, map connection refused to "opendevhub isn't running — start it with `opendevhub`"
- [x] 4.2 `opendevhub ls`: print branch, env id, node and state, main environment first
- [x] 4.3 `opendevhub up [target]`: call the matching start route, poll and print log lines until done, print approvals plus the dashboard link on `ApprovalRequiredError`, exit non-zero on failure
- [x] 4.4 `opendevhub attach [target] [--shell]`: start if not running (via 4.3), resolve again, spawn the exec with inherited stdio, exit with its code
- [x] 4.5 `opendevhub exec [target] -- <cmd…>`: TTY only when stdin and stdout are TTYs, pass the exit code through, refuse stopped environments with a hint to run `opendevhub up`
- [x] 4.6 Update `USAGE` and subcommand dispatch in `cli.ts`; tests for argument parsing and the error messages

## 5. Docs and verification

- [x] 5.1 Add a "Working from your own terminal" docs page (commands, target resolution, remote nodes, tmux tip)
- [x] 5.2 Manually verify against a real project: attach from repo subfolder and from a task worktree, `exec` in a pipe, approval-blocked start, server stopped
- [x] 5.3 Run `pnpm exec ultracite fix`, typecheck, tests, and `graphify update .`
