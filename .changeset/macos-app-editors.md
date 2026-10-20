---
"opendevhub": patch
---

Find editors installed as macOS apps, not just commands on PATH: on macOS, "Open in…" now also looks inside `/Applications/<Editor>.app` (and `~/Applications`) for the bundled CLI, so VS Code, Cursor and Zed appear even when their "Install command in PATH" was never run — e.g. when the app is only ever opened from the launcher.
