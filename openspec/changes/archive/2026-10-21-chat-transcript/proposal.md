## Why

A conversation in opendevhub doesn't read like a chat. After the first message, the Chat view and the Conversation tab show four usage cards, then the composer in the middle of the page, then a list of turns newest first. Each turn has only a shortened prompt and the last reply. You can't follow a back-and-forth the way you can in opencode or Claude: your message, the agent's answer, its question, your reply. The usage cards also take the space where the conversation should be.

## What Changes

- The conversation is shown as a transcript, oldest at the top. Your messages appear as bubbles. The agent's text is rendered as markdown, and its tool calls and reasoning are collapsed to one line each. Errors and compactions appear inline.
- The composer is pinned to the bottom of the view. Pending permission and question cards sit just above it, at the end of the transcript.
- The transcript stays scrolled to the newest message while the user is at the bottom. If they have scrolled up, a "Jump to latest" button appears instead.
- While the agent works, the transcript refreshes every couple of seconds, so replies show up without leaving the page.
- The four usage cards (cost, tokens, context, started) are replaced by a small usage button in the header that shows the share of the context window. Clicking it opens a popover with the full numbers.
- A rail of icon buttons on the right opens a side panel, closed by default. Its first panels are **Turns** (the current turn list with each turn's changes) and **Subagents**. Only one panel is open at a time, and the panel can be closed.
- The session detail response gains a `transcript` built from the messages it already reads. No new opencode calls are needed.
- The Chat view and the Conversation tab use the same conversation component, so both get the new layout.

## Capabilities

### New Capabilities

- `chat-transcript`: How a single conversation is presented: the transcript of messages and parts, the bottom-pinned composer with pending cards, scrolling, refreshing while the agent works, the usage popover, and the right side panel with Turns and Subagents.

### Modified Capabilities

- `chat-tab`: The Chat view requirement now refers to the transcript layout instead of "the turns".
- `task-navigation`: The Conversation tab requirement now refers to the transcript layout, with turns and subagents in the side panel and usage in the popover.

## Impact

- **Server:** `server/sessions/detail.ts` gains a transcript builder next to `toSessionTurns`. `server/sessions/sessions.ts` adds the transcript to the detail. `RawAssistantContent` in `server/opencode/client.ts` reads a tool call's title and a part's error, if opencode sends them.
- **Shared types:** `SessionDetail` gains `transcript: TranscriptMessage[]`, with new part types.
- **Web:** `features/sessions/session-page.tsx` is split into the conversation layout, the transcript, the usage popover and the side panel. `Stats` and the inline turns section move. `chat-view.tsx` and `task-conversation.tsx` both use the new layout. `react-markdown` and `remark-gfm` are already dependencies.
- **Payload:** the detail response grows, since it now carries message text. Each part's text is capped.
