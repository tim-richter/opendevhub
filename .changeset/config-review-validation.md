---
"opendevhub": patch
---

Preserve strings when parsing devcontainer checks and reject invalid JSONC. Recover from saved config or state files whose top-level value is not an object, keeping a backup. Reject invalid `.lock` components in worktree branch names before invoking Git. Keep text diffs visible when their content mentions Git's binary patch marker.
