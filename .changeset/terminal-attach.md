---
"opendevhub": minor
---

Work in opendevhub's containers from your own terminal, with your keybindings, tmux and scrollback. With opendevhub running, `opendevhub ls` lists the current project's environments, `opendevhub up` starts one, `opendevhub attach` starts it if needed and opens a shell in it, and `opendevhub exec -- <command…>` runs one command and exits with its exit code, so it works in scripts and pipes.

Without a target the folder you're in decides: a task's worktree with its own container picks that task's environment, anything else in the project picks the main one. You can also name an environment by its branch or env id, which is how you reach environments on remote nodes. The shell opens in the container folder that matches your current folder, as the container's user with its `remoteEnv`. Starts go through opendevhub, so forwarded ports, host ports, personalization and approvals work as from the dashboard. A start that needs an approval lists the settings and the dashboard link instead of starting.
