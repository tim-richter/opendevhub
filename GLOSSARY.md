# Glossary

Domain terms for opendevhub. Code, docs and reviews use these names.

**Hub**: the machine opendevhub runs on, and the project's repository there. The Hub's git, worktrees and publisher act on that repository for every Node, e.g. reading the base branch for a task on another Node. _Avoid_: home (collides with `Host.home`, a folder), local repo.

**Node**: a machine that runs Environments: `local` (the Hub itself) or an ssh destination. _Avoid_: box, server.

**Host**: how opendevhub reaches a Node's machine: run commands, dial TCP, read and write files. `localHost` and the ssh host are its two adapters.

**NodeKit**: the adapters that act on one Node's Docker and files (containers, opencode runtime, relay, network, env files, credentials, images, git, node repository). Every Node has one, `local` included; `NodeKits.kit(node)` answers for any online Node.

**Node repository**: a project's repository as a Node sees it. On `local` it is the Hub's repository; on a remote Node it is a copy fed by pushes from the Hub. It prepares a base, adds and removes task worktrees, and brings branches to the Hub.

**Environment**: one devcontainer with its own opencode, relay, route, port forwards and monitor. A project's main Environment has the project's id; a task Environment serves one worktree. _Avoid_: box, container (the container is one part of it).

**Provision**: get an Environment's container running (`devcontainer up` and what precedes it). The main Environment and task Environments provision differently; the caller does it, not the Environment.

**Connect**: wire a running Environment's container to the Hub: route, relay, port forwards, credentials and ssh-agent tunnel, opencode, monitor. **Disconnect** drops all of them. Used after provisioning, when adopting a container found at startup, and when a Node comes back. _Avoid_: attach (taken by the gateway, VS Code and devcontainer's `postAttachCommand`).

**Bring home**: fetch a remote Environment's branch into the Hub's repository.
