---
"opendevhub": patch
---

Fix Forgejo and Jira tokens getting stuck behind "The OS credential store is unavailable or locked": replacing or clearing a token no longer fails when the old keychain entry can't be read or deleted (for example after denying the macOS keychain prompt). Credential store errors now say whether access was denied, no prompt could be shown, or the native module failed to load, and the underlying cause is logged with the secret redacted.
