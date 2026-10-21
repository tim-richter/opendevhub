## Context

`SessionView` (`web/features/sessions/session-page.tsx`) renders a single conversation in two places: the Chat view (`features/chat/chat-view.tsx`) and the task page's Conversation tab (`features/tasks/task-conversation.tsx`). From top to bottom it shows:

- a title row with an "Open in opencode" link
- the pending cards
- four `Stat` cards
- the `Composer`
- a "Turns" section listing `TurnItem`s newest first
- a "Subagents" section

Its data comes from `GET` session detail (`fetchSessionDetail`). On the server, `Sessions` reads the newest `DETAIL_MESSAGES` (200) messages with `client.messages(sessionId, 200)`, newest first, and `toSessionTurns` in `server/sessions/detail.ts` folds them into `SessionTurn`s. Only a 2000-character prompt and a 1200-character last reply survive per turn. The raw messages already carry everything a transcript needs:

- for a user message: `text`
- for an assistant message: `content[]` of text, reasoning and tool parts, plus `error`
- `type` values such as `compaction`

The browser refetches the detail when the snapshot's `session.updatedAt` or `status` changes. The snapshot comes over the dashboard SSE stream, and the server reconciles on opencode `session.*`, `permission.*` and `form.*` events, debounced by 250 ms.

## Goals / Non-Goals

**Goals:**

- A transcript that reads like opencode or Claude: chronological, with bubbles for the user and markdown for the agent.
- Composer at the bottom, with pending cards right above it.
- Usage moved out of the way into a popover. Turns and subagents moved into a right side panel that is closed by default.
- One component for both the Chat view and the Conversation tab.
- No new opencode calls, and no new server-to-browser channel.

**Non-Goals:**

- Token-by-token streaming. Polling while the agent runs is good enough for now (see Decisions).
- Separating chats from tasks. That's the follow-up change `chats-without-tasks`.
- Editing or retrying messages, forking, or loading messages older than the newest 200.
- Showing a tool call's full input and output. The row shows its name, title and status. Changes stay in the Turns panel.

## Decisions

### 1. Build the transcript from the messages the detail already reads

Add `toTranscript(newestFirst: RawMessage[]): TranscriptMessage[]` next to `toSessionTurns` in `detail.ts`. It returns messages oldest first. `SessionDetail` gains `transcript`. Its shape:

```ts
type TranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      name: string;
      title?: string;
      status: "pending" | "running" | "completed" | "error";
    };

type TranscriptMessage =
  | { id: string; role: "user"; created: number; text: string }
  | {
      id: string;
      role: "assistant";
      created: number;
      completed?: number;
      parts: TranscriptPart[];
      error?: string;
      agent?: string;
      model?: ModelRef;
    }
  | { id: string; role: "compaction"; created: number };
```

Messages of other types (synthetic and so on) are skipped. Each text or reasoning part is capped at 20,000 characters, with an ellipsis. `RawAssistantContent` reads `state.title` for tool calls when present. The existing `more` flag drives the "older messages left out" note.

_Alternatives:_

- A separate `/transcript` endpoint. Rejected: it would read the same 200 messages a second time.
- Proxying opencode's message API to the browser. Rejected: it leaks opencode's shapes into the web app and skips the filtering we do on the server.

### 2. Poll every 2 s while the agent runs instead of streaming

`sessionDetailQuery` gets `refetchInterval: running ? 2000 : false`. Snapshot-driven invalidation stays for the idle case. opencode's message-part events don't match `RELEVANT_EVENT`, so the snapshot alone would only update at session boundaries.

_Alternative:_ forward `message.*` events over the dashboard SSE stream and patch the transcript in the browser. That gives real streaming, but it needs a per-session subscription channel and merge logic. It's deferred: polling ships now, and we can swap it out later without changing the UI.

### 3. Layout: a full-height conversation shell

A new `ConversationLayout` fills the space it is given (`flex min-h-0 flex-1`). It has these parts:

- a one-line header
- the transcript, in its own scroll container (`overflow-y-auto`)
- the pending stack and `Composer` in a footer that doesn't shrink
- the icon rail on the right

The open panel is a column of about 26rem between the transcript and the rail on `lg` screens and up. Below that it opens as a `Sheet` (already in `components/ui`).

The Chat view's `ChatColumn` and the task page's Conversation tab must give it a bounded height: the page's height minus the header and tabs. The task page's header and tabs stay above it.

The Chat view's header and `SessionView`'s title row are merged into one header: title, chips, the usage button and the "Open in opencode" / "Open task" links. Its status badge and model chips move into the header's chips.

### 4. Scroll following

A small hook, `useStickToBottom(ref)`, tracks whether the scroll container is within 48 px of the bottom.

- When the transcript grows and the user was at the bottom, it scrolls to the bottom.
- Otherwise it sets `behind = true`, which shows a floating "Jump to latest" button above the composer.
- `onSent` from the composer scrolls to the bottom.

No new dependency is needed.

### 5. Rendering parts

- **User text:** a right-aligned muted bubble with `whitespace-pre-wrap`.
- **Assistant text:** `react-markdown` with `remark-gfm` (already dependencies), styled with prose-like Tailwind classes and links opening with `rel="noopener noreferrer"`.
- **Reasoning:** a `Collapsible` labelled "Thinking".
- **Tool calls:** a row with a status icon (spinner, check or cross), a monospaced tool name and the truncated title.
- **Consecutive tool rows** are grouped visually, so a turn with 30 tool calls stays compact. A group of more than 5 tool rows collapses to "N tool calls" and expands on click.

### 6. Usage popover and side panel

- `Stats` becomes `UsagePopover`: a ghost button showing the context share (or the context tokens) that opens a `Popover` with the same four figures and the meter.
- `TurnItem` and the subagents list move unchanged into `TurnsPanel` and `SubagentsPanel`.
- The rail uses `Toggle` buttons with `Tip` tooltips and `aria-pressed`.
- The open panel id (`turns` | `subagents` | none) is stored in `localStorage` under `opendevhub.conversation.panel`, wrapped in try/catch like `rememberProject`. Its first value is none.

### 7. File split

`session-page.tsx` is split into:

- `conversation.tsx`: the layout and header
- `transcript.tsx`
- `usage-popover.tsx`
- `side-panel.tsx`: the rail and the panels, including `TurnItem`
- `use-stick-to-bottom.ts`

Pure helpers stay in `session-detail.ts`. `SessionView` stays the exported name, so `chat-view.tsx` and `task-conversation.tsx` change only for the height and the header.

## Risks / Trade-offs

- **Bigger detail payload.** 200 messages of text can reach a few hundred KB. → Each part is capped at 20k characters, and polling only happens while the agent runs. If this turns out to be a problem, we can add a `since` cursor later.
- **Turn changes in a narrow panel.** `TurnChanges` renders diffs, which are cramped at 26rem. → The panel widens to 40% of the view on `xl` screens; the Changes tab remains the place for a full diff.
- **2 s polling lag** compared with live streaming in opencode. → Accepted for now (Decision 2). The "Open in opencode" link stays in the header.
- **Height plumbing on the task page.** The Conversation tab currently sits in a normal-flow page. → The tab container becomes `flex-1 min-h-0` while Conversation is active. The other tabs keep normal flow.
- **Stories and tests.** `chat-view.stories.tsx` and the session stories need transcript fixtures. → Transcript fixtures are added to `web/mocks/fixtures.ts`.

## Open Questions

- Should the Turns panel open by default on the task page's Conversation tab, where reviewing changes matters more than in Chat? The spec says closed everywhere, remembered per browser. We can revisit after using it.
