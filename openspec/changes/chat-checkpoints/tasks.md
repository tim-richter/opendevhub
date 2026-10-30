## 1. opencode client

- [x] 1.1 Add `revert?: { messageID: string; files?: RawFileDiff[] }` to `RawSession` in `server/opencode/client.ts` (only the fields we read)
- [x] 1.2 Add `stageRevert(sessionId, messageId, directory)` (`POST /api/session/:id/revert/stage`, `files: true`), `clearRevert` (`DELETE /api/session/:id/revert`) and `commitRevert` (`POST /api/session/:id/revert/commit`), with tests in `test/server/opencode/client.test.ts`
- [ ] 1.3 Check against opencode 2.0.27 that a prompt sent while a revert is staged commits it; write the result in a comment on `commitRevert`

## 2. Session detail

- [x] 2.1 Add `SessionRevert { messageId; hidden; files: { path; additions?; deletions? }[] }` and `SessionDetail.revert?` to `shared/types.ts`
- [x] 2.2 In `server/sessions/detail.ts`, add a helper that cuts a newest-first message list at the boundary message (inclusive), and returns the visible messages and how many transcript messages were cut, including when the boundary is older than the messages read; unit tests in `detail.test.ts`
- [x] 2.3 Use it in `Sessions.sessionDetail` before `toTranscript` and `toSessionTurns`, and return `revert`; test in `sessions.test.ts`

## 3. Restore and redo

- [x] 3.1 Add `Sessions.restoreCheckpoint(id, sessionId, messageId)` and `Sessions.redoCheckpoint(id, sessionId)`: look up the session, call the client, `reconcile` the environment, and map opencode's busy error to a `ConflictError` saying the agent is still working
- [ ] 3.2 If 1.3 found that a prompt does not commit, call `commitRevert` in `sendMessage` and `promptSession` when the session has a staged revert
- [x] 3.3 Add `POST` and `DELETE /api/projects/:id/sessions/:sid/checkpoint` in `server/api/projects.ts`, with a `bodies.checkpoint` validator; route tests
- [x] 3.4 Add `restoreCheckpoint` and `redoCheckpoint` to the web API client, invalidating the session detail query on success

## 4. UI

- [x] 4.1 Add the AI Elements Checkpoint component to `packages/ui` with the shadcn CLI, as the docs show; add a story next to it
- [x] 4.2 In `transcript.tsx`, render a Checkpoint above each user message with a "Restore checkpoint" trigger and a `Tip`, turned off with its own tip while the session runs; take `onRestore` and `restoreDisabled` props
- [x] 4.3 Add a `fill` prop to `Composer` that sets the text when its key changes and the box is empty
- [x] 4.4 Add `RevertBar` to `conversation.tsx` above the composer: hidden message count, collapsible restored file list (or "no files changed back"), the "sending makes it permanent" note, and "Redo" (off while running); show request errors as the view's notice
- [x] 4.5 Wire restore in `conversation.tsx`: call the API, then fill the composer with the restored message's text
- [x] 4.6 Add transcript and conversation stories for a staged revert and for a running session

## 5. Verify

- [x] 5.1 Run `pnpm exec ultracite fix`, typecheck and the test suite
- [ ] 5.2 In a real environment: restore a checkpoint after a turn that edited files, check the files and the transcript, redo, restore again and send a message, and check that the revert is permanent in opencode's own UI as well
- [x] 5.3 Run `graphify update .`
