## 1. Verify opencode 2.1

- [ ] 1.1 Against a running opencode 2.1.0, check and record in design decisions 2, 3 and 5:
  - the `cursor.next` format, and that `?cursor=` alone continues the filtered list
  - that `PATCH /api/session/:id { archived }` returns 204 and sets `time.archived`, and what 2.0.x answers to it
  - that a worktree's sessions share the workspace's `projectID`
  - the error `_tag` for a missing saved permission
- [ ] 1.2 Add an `atLeast(version, min)` helper next to `parseOpencodeVersion` in `server/opencode/runtime.ts`, with tests

## 2. Session lookup fix

- [ ] 2.1 Add `allSessions({ cap })` to `OpencodeClient`, following `cursor.next` (`limit=200`, cap 2000, log when capped)
- [ ] 2.2 `cleanupConversation()`:
  - look the session up with `client.session(id)`, where 404 means removed and any other error skips the item
  - find the roots of active sessions by walking `parentID` with cached single lookups
- [ ] 2.3 Switch `staleSessionsIn()` to `allSessions()`
- [ ] 2.4 Tests with a fake opencode serving more than 50 sessions:
  - an old archived chat is deleted, not reported removed
  - a 404 is reported removed
  - a timeout is skipped
  - an old root with an active subagent is skipped as running
  - the stale scan sees every page

## 3. Archive sync

- [ ] 3.1 Add `setArchived(id, archived, directory)` to `OpencodeClient`
- [ ] 3.2 Add `ArchiveSync` (`server/sessions/archive-sync.ts`):
  - `archive(envId, ids)` and `unarchive(envId, ids)`, gated on version and running container, logging instead of throwing
  - `catchUp(envId, rawSessions)`, which only archives and tries each id once per run
- [ ] 3.3 Call it from:
  - `ChatService.archive`
  - `TaskService.archiveTask` (every variant's sessions)
  - `TaskService.restoreTask` (variants not discarded, conversations not closed)
  - `Sessions.archiveTaskConversation`
- [ ] 3.4 Have the monitor call `catchUp` after each successful poll (via `onRawSessions` or a new hook)
- [ ] 3.5 Tests:
  - archiving a chat or task sends the PATCH
  - restore unarchives only the right sessions
  - 2.0.x sends nothing
  - catch-up archives a missed session once and never unarchives

## 4. Saved permissions

- [ ] 4.1 Add `projectID?` to `RawSession`; add `RawSavedPermission`, `savedPermissions()`, `updateSavedPermission()` and `deleteSavedPermission()` to `OpencodeClient`, and `PermissionSavedNotFoundError` to `GONE_TAGS`
- [ ] 4.2 Add a hub method and routes `GET` / `PATCH` / `DELETE .../environments/:env/permissions/saved[/:rule]`:
  - zod validation with non-empty strings
  - 409 on PATCH below 2.1
  - `canEdit` in the response
  - gone counts as success
- [ ] 4.3 Server tests: list filtered to the project, delete of a missing rule, edit refused on 2.0.x, stopped container
- [ ] 4.4 Web: a "Saved permissions" section by the environment's runtime controls, with:
  - the list, remove with a confirm, and inline edit when `canEdit`
  - a confirm for `*` / `**` patterns
  - a stopped-container state
- [ ] 4.5 Add the "always" hint in `pending-cards.tsx`, linking to the section
- [ ] 4.6 Stories and mock handlers for the section: empty, rules, edit, 2.0.x, stopped

## 5. Wrap up

- [ ] 5.1 Run `pnpm exec ultracite fix`, the typecheck and the tests; run the e2e suite against an opencode 2.1.0 container
- [ ] 5.2 Run `graphify update .`
