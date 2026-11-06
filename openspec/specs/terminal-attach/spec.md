# terminal-attach Specification

## Purpose

How `opendevhub ls`, `up`, `attach` and `exec` reach opendevhub-owned environments from the user's own terminal: talking to the running server with the local access token, resolving the target from the current folder or a name, starting through the server so approvals, ports and personalization apply, and running `docker exec` (over ssh for remote nodes) with a real TTY or in pipes.

## Requirements

### Requirement: The CLI needs the running server

The `attach`, `up`, `exec` and `ls` subcommands SHALL talk to the opendevhub server on this machine, at the port in `config.json`. They SHALL authenticate with the dashboard cookie derived from the local access token, so no browser link or extra login is needed. When the server does not answer, the command SHALL exit non-zero with a message telling the user to start `opendevhub`. It SHALL NOT start the server itself.

#### Scenario: Server not running

- **WHEN** the user runs `opendevhub attach` while no opendevhub server is listening on the configured port
- **THEN** the command prints that opendevhub isn't running and how to start it, exits non-zero, and no server process is started

#### Scenario: Authenticated without a browser

- **WHEN** the server is running and the user runs `opendevhub ls`
- **THEN** the request is accepted using the token in the state folder, and the user is never asked to open a link

### Requirement: Only opendevhub-owned environments are targeted

The CLI SHALL act only on environments the server knows: a registered project's main environment and its task environments. It SHALL NOT create, register or attach to any other container. When the current folder is not inside a registered project, the command SHALL exit non-zero and tell the user to add the project in the dashboard.

#### Scenario: Unregistered folder

- **WHEN** the user runs `opendevhub attach` in a folder that is not inside any registered project or its worktrees
- **THEN** the command exits non-zero with a message pointing to the dashboard, and no container is created

#### Scenario: Plain devcontainer of the same folder is ignored

- **WHEN** a container created by VS Code or a plain `devcontainer up` exists for the project folder, and the project's opendevhub main environment is stopped
- **THEN** `opendevhub attach` starts and attaches to the opendevhub main environment, not the other container

### Requirement: The target comes from the current folder or a name

Without a target argument, the CLI SHALL resolve the environment from the current folder. A folder inside a task's worktree SHALL select that task's environment. Any other folder inside the project SHALL select the project's main environment. With a target argument, the CLI SHALL match it against the project's environments by env id or branch name. When the argument matches no environment, or more than one, the command SHALL exit non-zero and list the candidates. Environments on remote nodes SHALL be selectable only by name.

#### Scenario: Inside a task worktree

- **WHEN** the user runs `opendevhub attach` inside the worktree of a task that has its own environment
- **THEN** the shell opens in that task's container

#### Scenario: Inside the project folder

- **WHEN** the user runs `opendevhub attach` in a subfolder of the project's repository
- **THEN** the shell opens in the project's main environment

#### Scenario: By branch name

- **WHEN** the user runs `opendevhub attach feat/login` from inside the project
- **THEN** the shell opens in the environment whose branch is `feat/login`

#### Scenario: Ambiguous name

- **WHEN** the given name matches two environments
- **THEN** the command exits non-zero and lists both with their env ids

### Requirement: Environments can be listed

`opendevhub ls` SHALL list the current project's environments, main environment first, each with its branch, env id, node and container state.

#### Scenario: Listing a project

- **WHEN** the user runs `opendevhub ls` inside a project with a running main environment and a stopped task environment
- **THEN** both are listed with branch, env id, node and their states `running` and `stopped`

### Requirement: Starting from the terminal goes through the server

`opendevhub up` and `opendevhub attach` (on a stopped environment) SHALL start the environment through the server's existing start actions, so personalization, port forwarding and host ports apply exactly as when starting from the dashboard. The CLI SHALL print the start progress while it waits, and SHALL exit non-zero when the start fails. When the start is blocked by host-affecting settings that are not approved, the command SHALL exit non-zero, name the unapproved settings, and print the dashboard link to approve them. The CLI SHALL offer no way to approve them.

#### Scenario: Start applies personalization and ports

- **WHEN** the user runs `opendevhub up` for a stopped project that has personal features, forwarded ports and host ports
- **THEN** the container is started with those features, and its ports and host ports are forwarded as when started from the dashboard

#### Scenario: Approval missing

- **WHEN** the user runs `opendevhub attach` and the project's devcontainer.json has host-affecting settings that aren't approved
- **THEN** the command lists those settings, prints the dashboard link, exits non-zero, and no container is started

#### Scenario: Already running

- **WHEN** the user runs `opendevhub attach` for a running environment
- **THEN** no start is requested and the shell opens straight away

### Requirement: Attaching opens a real shell in the user's terminal

`opendevhub attach` SHALL run `docker exec` itself with an interactive TTY, as the container's remote user and with its `remoteEnv`, and SHALL wait for it to exit. For an environment on a remote node it SHALL run the same command through the node's ssh connection. The shell SHALL start in the container folder that matches the current host folder when the current folder is inside the environment's checkout, and in the checkout's root otherwise. The shell SHALL be the one given with `--shell` (bash, zsh, sh or fish). Without `--shell`, it SHALL be the host `$SHELL`'s name if that shell exists in the container, otherwise bash, otherwise sh. A session with a TTY SHALL use the host's `TERM` when the container has terminfo for it, and `xterm-256color` otherwise.

#### Scenario: Terminal unknown to the container

- **WHEN** the user's `TERM` is `xterm-ghostty` and the container has no terminfo entry for it
- **THEN** the shell runs with `TERM=xterm-256color`, so line editing and backspace work

#### Scenario: Subfolder carried over

- **WHEN** the user runs `opendevhub attach` in `<project>/packages/ui`
- **THEN** the shell's working directory is `packages/ui` under the container's workspace folder

#### Scenario: Default shell

- **WHEN** the user's `$SHELL` is `/usr/bin/zsh` and the container has no zsh
- **THEN** the shell is bash, or sh when bash is missing too

#### Scenario: Remote node

- **WHEN** the user runs `opendevhub attach <env-id>` for an environment on an online remote node
- **THEN** the shell opens in that container over the node's ssh connection

### Requirement: exec behaves like a command

`opendevhub exec [target] -- <command…>` SHALL run the command in the environment with the same user, environment and working-directory rules as `attach`. It SHALL allocate a TTY only when both stdin and stdout are terminals, so piped output carries no terminal control characters, pass stdin, stdout and stderr through, and exit with the command's exit code. It SHALL NOT start a stopped environment; it SHALL exit non-zero and suggest `opendevhub up`.

#### Scenario: Exit code passed through

- **WHEN** the user runs `opendevhub exec -- sh -c 'exit 3'`
- **THEN** the CLI exits with code 3

#### Scenario: Used in a pipe

- **WHEN** the user runs `echo '{}' | opendevhub exec -- jq .`
- **THEN** jq reads the piped input and its output is printed without TTY control characters

### Requirement: The CLI leaves no trace in the dashboard

Sessions opened by `attach` or `exec` SHALL NOT be recorded by the server or shown in the dashboard. Starting an environment from the CLI SHALL show in the dashboard exactly as a start from the dashboard does.

#### Scenario: Attached shell not listed

- **WHEN** the user has an `opendevhub attach` shell open
- **THEN** the dashboard's terminal tabs and the database are unchanged
