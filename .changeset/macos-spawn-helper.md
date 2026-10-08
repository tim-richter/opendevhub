---
"opendevhub": patch
---

Fix `devcontainer up` and terminals failing with `posix_spawnp failed` on macOS: node-pty 1.1.0's `spawn-helper` ships without its execute bit, so opendevhub now restores it on startup.
