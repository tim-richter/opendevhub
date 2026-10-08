---
"opendevhub": patch
---

Warn when the forwarded ssh-agent holds no keys: the checkout page shows "ssh-agent has no keys" and the log says to run `ssh-add` on this machine, instead of git in the container failing with "Permission denied (publickey)" while the agent shows as forwarded. The warning clears by itself once a key is added. The Git and ssh docs now explain loading your key into the agent and how to troubleshoot ssh in containers.
