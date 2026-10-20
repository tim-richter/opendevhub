## Why

opencode 2.1.0 brings session archiving back (`PATCH /api/session/:id { archived }`, `GET /api/session?archived=`) and adds editing of saved permissions (`PATCH /api/permission/saved/:id`). opendevhub already archives chats and task conversations, but only in its own database, so opencode's own TUI and desktop app still list them as live. Someone who answers a permission prompt with "always" also has no way to see or undo that rule without going into the container.

While checking the 2.1 changes we also found a bug that 2.1 didn't cause: `GET /api/session` returns only the newest 50 sessions. Cleanup searches that page for a single session, so a conversation older than the newest 50 is reported as already removed and is never deleted.

## What Changes

- **Session lookup fix:**
  - Cleanup looks up a single session by id, and only a 404 means it's gone.
  - Code that needs every session follows opencode's list cursor.
- **Archive sync:** when opendevhub archives a chat, a task, or one task conversation, it also archives the opencode session. Restoring a task unarchives its sessions.
  - Sync is best effort and catches up once the environment's opencode is reachable again.
  - It needs opencode 2.1 or later. Older servers are skipped without error.
- **Saved permissions:** each environment gets a "Saved permissions" list, read from opencode's own saved-permission store, where the user can:
  - see the saved rules
  - remove a rule
  - edit a rule's action or resource pattern, on opencode 2.1 or later

## Capabilities

### New Capabilities

- `opencode-session-lookup`: how opendevhub finds one opencode session, or all of them, despite the list's page size.
- `opencode-session-archive`: keeping opencode's archive flag in step with opendevhub's archived chats, tasks and task conversations.
- `saved-permissions`: listing, editing and removing the permission rules opencode saved from "always" answers.

### Modified Capabilities

<!-- None: existing specs don't describe opencode session lookup, archiving or permission prompts. -->

## Impact

- **Server:**
  - `server/opencode/client.ts`:
    - `allSessions()`, which follows the list cursor
    - `setArchived()`
    - `savedPermissions()`, `updateSavedPermission()` and `deleteSavedPermission()`
    - the `PermissionSavedNotFoundError` tag in `GONE_TAGS`
  - `server/git/cleanup-targets.ts`: single-session lookup in `cleanupConversation`, and `allSessions()` in `staleSessionsIn`
  - archive and restore paths in `server/sessions/chat.ts`, `server/sessions/sessions.ts` and `server/tasks/tasks.ts`, plus a catch-up pass in `server/environments/monitor.ts`
  - new API routes for saved permissions
- **Web:** a "Saved permissions" section per environment, and a link to it next to the "always" choice in `features/sessions/pending-cards.tsx`.
- **Compatibility:**
  - Everything keeps working on opencode 2.0.x.
  - Archive sync and permission editing turn on for environments that report opencode 2.1 or later.
  - Listing and removing saved permissions already work on 2.0.x.
- **No database migration.**
