## Context

opendevhub talks to each environment's opencode server through `OpencodeClient` (`server/opencode/client.ts`) with plain `fetch`, not opencode's SDK. Each environment has its own opencode database, in a volume per environment. `environments.ts` records the version opencode reports at start as `opencodeVersion`.

- **Session list:** `GET /api/session` returns `{ data, cursor: { previous, next } }`, newest 50 by default. `client.sessions()` reads only `data`.
  - The monitor (`environments/monitor.ts`) knows about the cap: `withMissing()` fetches sessions that are waiting on the user but missing from the page.
  - Cleanup does not. `cleanupConversation()` (`git/cleanup-targets.ts:193`) runs `sessions().find(id)` and returns `"removed"` on a miss. `staleSessionsIn()` scans only the first page.
- **Archive:** opendevhub archives in its own database: `ChatService.archive`, `TaskService.archiveTask` / `restoreTask`, and `Sessions.archiveTaskConversation` → `tasks.archiveSession`. opencode 2.1 adds `archived` to `PATCH /api/session/:id` and stamps `time.archived`, which `RawSession` already reads. The monitor's `directories()` already skips archived sessions.
- **Saved permissions:**
  - `GET /api/permission/saved?projectID=` and `DELETE /api/permission/saved/:id` exist since 2.0.x.
  - 2.1 adds `PATCH /api/permission/saved/:id { action?, resource? }`.
  - `PermissionSaved.Info` is `{ id, projectID, action, resource, time: { created, updated } }`. A saved rule is always an allow rule.

## Goals / Non-Goals

**Goals:**

- No conversation is ever reported as removed while it still exists in opencode.
- opencode's own clients see the same archive state as opendevhub for conversations opendevhub tracks.
- Saved "always" rules can be seen, removed and edited from opendevhub.
- Nothing breaks on opencode 2.0.x.

**Non-Goals:**

- Importing archive state from opencode into opendevhub. Archiving a session in opencode doesn't archive the chat or task.
- Archiving sessions opendevhub doesn't track.
- Creating saved permissions from opendevhub, or managing opencode's config-file permission rules (`opencode.json` `permission`).
- Making the monitor read every page on every poll.

## Decisions

### 1. Single lookup by id; 404 is the only "gone"

`cleanupConversation()` calls `client.session(id)`. On `OpencodeHttpError` with status 404 it reports `removed`. Any other error propagates, so the item is skipped with the error.

The "still running" check walks `parentID` from each id in `client.active()` with `client.session()`. The set is small, since only running sessions are active. A per-call `Map` caches lookups, and the walk is capped at the monitor's `MAX_SESSION_LOOKUPS` (20). This replaces the `parents` map that was built from the first page.

- **Why:** this is O(active), not O(all sessions), and it's correct regardless of page size.
- **Alternative rejected:** `allSessions()` here too. It's correct but loads up to 2000 sessions to answer a yes/no about one.

### 2. `allSessions()` follows `cursor.next`

`client.allSessions({ cap = 2000 })` requests `/api/session?limit=200`, then `?cursor=<next>` until `next` is missing or the cap is reached. A cursor carries its filters, so later pages pass only `cursor`. `staleSessionsIn()` switches to it.

`sessions()` stays one page for the monitor, its hot path on every event. `detail.ts` also stays as it is: it builds subagent trees from `childSessions()`, which filters before the page limit.

### 3. Archive sync is fire-and-forget, plus a catch-up pass

`client.setArchived(id, archived, directory)` sends `PATCH /api/session/:id { archived }`. The service methods update the database first, then call a small `ArchiveSync` helper per environment. The helper skips environments whose `opencodeVersion` is below 2.1 or whose container isn't running, and logs failures instead of throwing.

Sessions of an archived task are those of all its variants, from `tasks` (`task_sessions` plus each variant's own session). Restore unarchives the sessions of variants that aren't discarded and that `isSessionArchived()` doesn't mark as closed on their own.

**Catch-up:** after each poll, the monitor calls `ArchiveSync.catchUp(rawSessions)`. For each listed session that opendevhub expects archived (archived chat, archived task, closed conversation) but whose `time.archived` is missing, it archives the session in opencode. A `Set` of ids tried during this run keeps a failing session from being retried on every poll. Catch-up only sees sessions on the polled page, which is enough: missed archives are almost always of recent sessions, and older ones are caught when they next get activity.

- **Why only archive, never unarchive, in catch-up:** if opendevhub unarchived anything opencode lists as archived, it would fight users who archive in opencode's TUI. Unarchiving happens only on an explicit restore.

### 4. Version gate

The gate is a helper `atLeast(version, "2.1.0")` on `opencodeVersion`. On an unknown version, it doesn't send.

### 5. Saved permissions go through the hub; edit is gated

New `OpencodeClient` methods:

- `savedPermissions(projectID, directory)`
- `updateSavedPermission(id, { action?, resource? })`
- `deleteSavedPermission(id)`

`PermissionSavedNotFoundError` is added to `GONE_TAGS`, so delete and update treat a missing rule as gone.

2.1 has no "current project" endpoint, but every `Session.Info` carries `projectID`. The environment's project id is the `projectID` of its sessions whose `location.directory` is the workspace or one of its worktrees. opencode keys projects by repository, so worktrees share it. Add `projectID?` to `RawSession`. With no session yet, the section shows rules for every `projectID` that `/api/project` lists. Each opencode database belongs to one environment, so that's rarely more than one project.

Routes, under the existing projects router:

- `GET /api/projects/:id/environments/:env/permissions/saved`
- `PATCH /api/projects/:id/environments/:env/permissions/saved/:rule`
- `DELETE /api/projects/:id/environments/:env/permissions/saved/:rule`

PATCH answers 409 below opencode 2.1. The view includes `canEdit` from the version gate.

**UI:** a "Saved permissions" section next to the environment's runtime controls (`features/checkouts/runtime-controls.tsx` area). Each rule shows its action, pattern and relative time. A rule can be removed with a confirm, and edited inline when `canEdit`. `pending-cards.tsx` adds a hint under "always" linking there.

## Risks / Trade-offs

- **Catch-up misses archived sessions beyond the newest page.** These are rare and harmless: opencode just shows them as live. Mitigation: archiving sends the PATCH right away, so catch-up is only the fallback.
- **2.1 can't be downgraded.** If an environment goes back to 2.0.x, its archived flags are simply ignored. opencode's own downgrade caveat is about compactions and is unrelated to this change.
- **Editing a rule's resource to something broad** (`*`) widens what the agent may do without asking. Mitigation: show the effective pattern and require a confirm when the new pattern is `*` or `**`.

## Open Questions

- Should discarding a variant also archive its session in opencode? It's left out for now, because discarded variants are deleted by cleanup soon anyway.
