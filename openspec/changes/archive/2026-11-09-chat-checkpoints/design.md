## Context

The Chat view and a task's Conversation tab both render a session through `Transcript` (`web/features/sessions/transcript.tsx`) inside `conversation.tsx`. They read `SessionDetail` from `Sessions.sessionDetail`. That reads the session and its newest `DETAIL_MESSAGES` messages from opencode through `OpencodeClient`.

opencode 2.x (the version we pin, 2.0.27, has all three routes) keeps a staged revert on the session:

- `POST /api/session/:id/revert/stage` with `{ messageID, files?: boolean }` stages, or moves, the boundary at a user message. With `files: true` it also restores the files from the turn's snapshot. It returns `Session.Revert`: `{ messageID, snapshot?, files?: FileDiff[] }`. It fails with `SessionBusyError` while the session runs.
- `DELETE /api/session/:id/revert` clears it and puts the files back as they were before the first stage.
- `POST /api/session/:id/revert/commit` makes it permanent. A new prompt commits it as well.
- `Session.Info.revert` holds the staged state. opencode's own clients hide messages from `revert.messageID` on; the message list itself still returns them.

The UI side is the shadcn AI Elements Checkpoint (`ui.shadcn.com/docs/ai-elements/base/checkpoint`): a divider with an icon and a trigger button, rendered between messages.

## Goals / Non-Goals

**Goals:**

- Restore a conversation and its files to before any user message, from the transcript.
- Show the staged state, and allow redo, until the next message is sent.
- Read the staged state from opencode, so every browser and a reload agree, and so do the opencode TUI and web.

**Non-Goals:**

- `/undo` and `/redo` as hub composer commands. They can come later on top of the same server methods.
- Forking a session at a checkpoint.
- Reverting side effects outside the checkout's files (shell commands, external services). opencode can't, and we say so in the tooltip.
- Checkpoints in subagent sessions.

## Decisions

### Hide reverted messages on the server

`sessionDetail` reads `raw.revert`. It cuts the newest-first message list at the boundary before building `transcript` and `turns`. It returns `revert: { messageId, hidden, files }` on `SessionDetail`, where `hidden` is the number of transcript messages cut and `files` are the restored paths. The web doesn't need the message list's ordering rules, and the Turns panel and the transcript cut at the same place.

The cut is by position, not by comparing ids: drop every message up to and including the one whose id is `revert.messageID`. When the boundary is older than the messages read, every message read is hidden. The transcript then shows the "older messages left out" note, and nothing else.

_Alternative:_ filter in the web. That would leave `turns`, usage and the transcript each filtering on their own.

### Stage with `files: true`, and always use opencode's state

`restoreCheckpoint(id, sessionId, messageId)` calls `stageRevert(..., { files: true })`. `redoCheckpoint` calls `clearRevert`. Both then `reconcile` the environment, so the dashboard's change counts update. Neither keeps state in our store. The next `sessionDetail` read reflects the change, and the web invalidates the detail query on success.

A `SessionBusyError` from opencode maps to a 409 `ConflictError` with "the agent is still working". The web shows it as a notice. The buttons are also turned off client-side while `running`, so this only happens in a race.

### Let the next prompt commit

We don't call `revert/commit` ourselves. opencode commits on the next prompt, from any client, and that's the behavior the spec describes. A task checks this against 2.0.27. If the prompt does not commit, `sendMessage` calls `commitRevert` first when the session has a staged revert.

### Routes

- `POST /api/projects/:id/sessions/:sid/checkpoint` with `{ messageId }` restores.
- `DELETE /api/projects/:id/sessions/:sid/checkpoint` does redo.

Both use the existing `ok(...)` helpers and `validateJson`.

### UI

- **Checkpoint component.** Added to `packages/ui` with the shadcn CLI, used as the docs show, without local rewrites. If its registry item drags in AI Elements pieces we don't use, we add only the Checkpoint item.
- **Transcript.** `Transcript` gets `onRestore(messageId)` and `restoreDisabled`. It renders `Checkpoint` above each user block, with the trigger "Restore checkpoint" and a `Tip` explaining what happens.
- **Staged-revert bar.** `conversation.tsx` renders a `RevertBar` between the pending cards and the composer when `detail.revert` is set. It shows "N messages hidden", a collapsible file list (path, with additions/deletions when given), a note that sending makes it permanent, and a "Redo" button.
- **Composer prefill.** `Composer` gets a `fill?: { text: string; key: number }` prop. When `key` changes and the box is empty, it sets the text and puts the caret at the end. `conversation.tsx` sets it from the restored message's text after a successful restore. A restore by another client doesn't prefill.

## Risks / Trade-offs

- **Hidden messages use up the read window.** If many messages are hidden, fewer visible ones fit in `DETAIL_MESSAGES`. Acceptable: a staged revert is short-lived, and the "older messages" link still works.
- **Snapshots off.** If the user turned off opencode snapshots, staging still hides messages but restores no files, and `files` comes back empty. The bar then says no files were changed back, rather than claiming they were.
- **Files edited outside opencode after the turn.** opencode restores its snapshot over them. That is opencode's behavior, and redo puts back the state before the restore, so nothing is lost before sending.
- **The polling window.** Between the restore and the next detail read, the old transcript can show for a moment. Invalidating the query on success keeps that short.
