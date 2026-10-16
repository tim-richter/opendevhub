---
"opendevhub": minor
---

Teams can share more project settings in `devcontainer.json` under `customizations.opendevhub`: the project's name, sidebar letters and color, and its Jira and Forgejo links, alongside checks, isolation and key files. The project's settings pages mark values that come from the team, and a **Just me / Team** switch saves a setting to your own config or to `devcontainer.json`, keeping its comments and formatting. Forwarded ports can be saved to the file's `forwardPorts` the same way.

Your own checks are now laid over the team's by name instead of replacing the whole list: a check with a new name is added, one with a team check's name replaces it for you, and **Turn off** stops you running a team check. If you had saved your own list before, team checks that aren't in it now run as well.

`sshAgent` in `devcontainer.json` is no longer read; turn ssh-agent forwarding off in `~/.config/opendevhub/config.json` instead.
