## Context

`Sessions.startTaskConversation` (`server/sessions/sessions.ts`) creates an empty opencode session in the variant's checkout, attaches it to the variant and, when given one, sends a first prompt. It is the single path for every conversation started in an existing task: the sidebar's New conversation, `/new`, a spec's "implement in a new conversation", and a review started in the task. Nothing about the task reaches the new agent.

opencode v2's prompt input is only `{ text, files?, agents?, skills? }`, so there is no system field or no-reply flag. It has two other ways in, read from the 2.0.27 and 2.1.2 binaries:

- `PUT /api/experimental/session/:id/instructions/entries/:key` with `{ value: <JSON> }`: "Attach or replace one durable instruction entry. Changes announce as updates at the next step boundary." Keys match `^[a-z0-9][a-z0-9._-]*$`, and values are capped at 256 KiB (413 above). An update emits `session.instructions.updated`, which opencode keeps as a `system` message with the text and `metadata.notice: "instructions"`.
- `POST /api/session/:id/synthetic` with `{ text, resume: false }`: a synthetic message in the history.

## Goals / Non-Goals

**Goals:**

- Every conversation started in an existing task knows what the task is, where it stands, and where the record of earlier work lives.
- The briefing is deterministic, cheap and accurate, built only from data opendevhub already has.
- The user can see what the agent was told.
- A briefing failure never blocks starting a conversation.

**Non-Goals:**

- An LLM-written summary of the previous conversation (a possible opt-in later).
- A notes file that agents keep up to date.
- Updating the briefing while a conversation runs (the entry allows it; not now).
- Briefing a variant's first session or plain chats.

## Decisions

**Instruction entry over synthetic message or first-turn prefix.** The entry is part of the session's instructions rather than a turn in the conversation, so the agent reads it as context, not as a request to act on. It is also keyed, so a later change can replace it in place. A synthetic message would sit in the history like a user turn, and prefixing the first prompt would also fail when there is no first prompt (New conversation sends none). The route is marked experimental, so it is called from one `OpencodeClient.putInstruction` method, and there is no synthetic fallback: if the route goes away, the conversation simply starts without a briefing.

**The value is a single markdown string.** We don't know exactly how opencode turns a JSON value into prompt text. A string means the agent sees the markdown we wrote, whatever that serialization is.

**Build in a dedicated module, `server/tasks/briefing.ts`.** It exposes `buildBriefing(input): string`, a pure function over plain data (task, variant, ticket, commits, diffstat, status lines, spec progress, earlier titles), plus a small gatherer that collects that data through the existing deps: the task store, `GitOps` with the variant's `ExecTarget` (`recordedBase`/`mergeBase` for the base, then `log`, `diff --stat` and `status --short`), and the specs module for the change's phase and `tasks.md` progress. Each gather step is caught on its own, and a failed step leaves its section out. Keeping the function pure makes the contents testable without git or opencode.

**Size bounds.** At most 30 commits (with "and N more"), the diffstat's summary line plus at most 40 file lines, and at most 40 status lines. The brief is included in full, since it is the user's own text. This keeps the briefing far under the 256 KiB cap, so no 413 handling is needed beyond logging.

**Order in `startTaskConversation`:** create the session, attach it to the variant, release the claim, put the briefing, then send the prompt. The briefing put is awaited, so it reaches the session before the first prompt, and any error is caught and logged with `{ taskId, sessionId }`.

**Rendering.** Checked against 2.1.2: an entry set before the first prompt joins the session's first instructions and adds no message to the history; only a later change adds a `system` message (`metadata.notice: "instructions"`, `metadata.instructionSources` naming `api/opendevhub-task`), whose text can also carry other sources' updates. So the briefing is read back from the entry itself: `server/sessions/detail.ts` reads `GET /api/experimental/session/:id/instructions/entries` (in 2.0.27 and 2.1.2) alongside the messages and, when `opendevhub-task` holds a string, puts a `{ role: "briefing", text }` row at the start of the transcript. A 404 or any failure there means no row. `system` messages stay hidden as today. `transcript.tsx` renders the row as a collapsed disclosure labelled "Task briefing", using the existing markdown renderer.

## Risks / Trade-offs

- [The experimental route changes or is removed upstream] → It is one client method; a 404 or failure degrades to today's behavior, and tests cover the 404 path.
- [The entries read route changes upstream] → The transcript then shows no briefing row; the agent still has the briefing.
- [Stale briefing: it describes the task when the conversation starts, not later] → Acceptable for now; the entry is keyed, so a later change can refresh it.
- [Git calls add latency to New conversation] → Three cheap git commands in the checkout, run in parallel; measured during implementation.

## Open Questions

- Whether opencode versions before 2.0.27 have the instructions route; handled by the 404 path either way.
