## Why

When the agent goes down the wrong path, the only fix in opendevhub today is to tell it to undo its work, or to open the session in opencode and use `/undo` there. opencode 2.x already snapshots every turn and has a staged revert for messages and files. The chat just doesn't offer it.

## What Changes

- Each user message in the transcript gets a checkpoint just above it: a divider with a "Restore checkpoint" button, built from the shadcn AI Elements Checkpoint component.
- Restoring stages a revert at that message through opencode (`POST /api/session/:id/revert/stage` with `files: true`). That message and everything after it are hidden, and the checkout's files go back to how they were before that message.
- While a revert is staged, a bar above the composer says what was rewound: how many messages, and which files changed back. It has a "Redo" button that clears the staged revert (`DELETE /api/session/:id/revert`), bringing back the messages and the files.
- When the composer is empty, it is prefilled with the restored message's text, so it can be edited and sent again. Sending a message makes the revert permanent (opencode commits it with the next prompt), and redo is gone after that.
- Restore and redo are turned off while the session is running.
- The server exposes the session's staged revert in the session detail, and adds routes to stage and clear it.

## Capabilities

### New Capabilities

- `chat-checkpoints`: Restoring a conversation and its files to an earlier user message, the staged state with redo, and making it permanent by sending a message.

### Modified Capabilities

- `chat-transcript`: While a revert is staged, the transcript leaves out the messages from the boundary on.

## Impact

- **Server**: `OpencodeClient` gets `stageRevert`, `clearRevert`, and reads `revert` on `RawSession`. `Sessions` gets `restoreCheckpoint` and `redoCheckpoint`. `sessionDetail` returns the staged revert. Two new routes in `api/projects.ts`.
- **Shared types**: `SessionDetail.revert` (boundary message id and the files it changed).
- **Web**: `transcript.tsx` renders checkpoints and hides reverted messages. `conversation.tsx` gets the staged-revert bar and prefills the composer. The Checkpoint component is added to `packages/ui` via the shadcn CLI.
- **opencode**: needs 2.x with session snapshots on (the default). If snapshots are off, messages are still rewound but files are not.
