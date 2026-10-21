## 1. Server: transcript in the session detail

- [x] 1.1 Add `TranscriptPart` and `TranscriptMessage` to `shared/types.ts` and `transcript: TranscriptMessage[]` to `SessionDetail`
- [x] 1.2 Read `state.title` on tool parts and the part's text for reasoning in `RawAssistantContent` (`server/opencode/client.ts`)
- [x] 1.3 Implement `toTranscript(newestFirst)` in `server/sessions/detail.ts`. It returns messages oldest first, maps user, assistant and compaction messages, skips other types, caps each text or reasoning part at 20,000 characters, and keeps assistant errors
- [x] 1.4 Add `transcript` to the detail built in `server/sessions/sessions.ts` from the messages it already reads
- [x] 1.5 Unit tests in `test/server/sessions/detail.test.ts`: ordering, the part kinds, tool status and title, skipped types, compaction divider, caps, errors

## 2. Web: conversation shell and transcript

- [x] 2.1 Add `useStickToBottom` (`features/sessions/use-stick-to-bottom.ts`): at-bottom tracking within 48 px, auto-follow, `behind` flag and `scrollToBottom`
- [x] 2.2 Add `transcript.tsx`: user bubbles, assistant markdown (`react-markdown` + `remark-gfm`, safe links), "Thinking" collapsible, tool rows with status icons, more than 5 consecutive tool rows collapsed to "N tool calls", inline errors, compaction divider, empty state, and the "older messages left out" note linking to opencode
- [x] 2.3 Add `conversation.tsx` with a full-height layout: a one-line header (title, status, model and agent chips, optional task chip, usage button, "Open in opencode", and a slot for extra actions such as "Open task"), the scrolling transcript, the "Jump to latest" button, and a footer with the `PendingStack` and the `Composer`
- [x] 2.4 Refetch the detail every 2 s while the session isn't idle (`refetchInterval`). Keep the snapshot-driven invalidation, and scroll to the bottom when a message is sent

## 3. Web: usage popover and side panel

- [x] 3.1 Replace `Stats` with `usage-popover.tsx`: the button shows the context share, or the context tokens when the window is unknown, and the popover holds cost, tokens with breakdown, context meter, start time, last outcome and the subagents note
- [x] 3.2 Add `side-panel.tsx`: a rail of `Toggle`s with `Tip` tooltips and `aria-pressed`, one open panel at a time, a close button, the open panel remembered in `localStorage` (`opendevhub.conversation.panel`, wrapped in try/catch, none by default), a column of about 26rem on `lg` widening to 40% on `xl`, and a `Sheet` below `lg`
- [x] 3.3 Move `TurnItem` and the turns list into the Turns panel, and the subagents list into the Subagents panel, which only shows its button when there are subagents
- [x] 3.4 Remove the old inline Stats, Turns and Subagents sections from `SessionView`. Keep `SessionView` as the exported entry point that renders `Conversation`

## 4. Wire both views

- [x] 4.1 Chat view (`chat-view.tsx`): fold its header into the conversation header (project and checkout chips, an "Open task" action), and give `ChatColumn` a bounded height in the non-centred mode so the composer sits at the bottom of the viewport
- [x] 4.2 Conversation tab (`task-conversation.tsx` / `project-task.tsx`): give the tab content `flex-1 min-h-0` while Conversation is active so the composer is pinned. Keep the thread list above the conversation
- [x] 4.3 Check `VariantWaiting` (conversation not started yet) still renders well inside the new shells

## 5. Stories, checks and specs

- [x] 5.1 Add transcript fixtures to `web/mocks/fixtures.ts` and update `chat-view.stories.tsx` and the session stories: a short chat, a long transcript with tool calls, a pending question, an open Turns panel, and the mobile sheet
- [ ] 5.2 Check the Chat view and the Conversation tab in the running app: a back-and-forth, scrolling while the agent works, the usage popover, opening, switching and closing panels, and the narrow-screen sheet
- [x] 5.3 Run `pnpm exec ultracite fix`, the type check and the tests. Then run `graphify update .`
