## 1. opencode instructions API

- [x] 1.1 Verify against a running v2 environment: PUT a string entry on a scratch session, confirm a 204, send a prompt and confirm the model sees the text, and record the raw `system` message's shape (type, text, metadata) from the messages endpoint
- [x] 1.2 Add `OpencodeClient.putInstruction(sessionId, key, value, directory)` for `PUT /api/experimental/session/:id/instructions/entries/:key`, with a doc comment naming the experimental route
- [x] 1.3 Support the route in `test/helpers/fake-opencode.ts`: store entries per session, list them on `GET …/instructions/entries`, and offer a mode that answers 404 (no `system` message: opencode adds none for an entry set before the first prompt)
- [x] 1.4 Client test: the request's path, method and body, and that a 404 surfaces as an error

## 2. Building the briefing

- [x] 2.1 Create `server/tasks/briefing.ts` with a pure `buildBriefing(input): string` covering the title, brief, ticket, branch/base/path, commits (at most 30, plus "and N more"), diffstat (at most 40 file lines), uncommitted changes (at most 40 lines), spec change/phase/progress/folder, and earlier conversation titles; empty sections are said to be empty, and missing data leaves its section out
- [x] 2.2 Unit tests for `buildBriefing`: a plain task, a task with a ticket, a spec-first implementing task, truncation, and missing sections
- [x] 2.3 Add a gatherer that reads the inputs from the task store, `GitOps` on the variant's exec target (base via `recordedBase`/`mergeBase`, then log, `diff --stat`, `status --short`, run in parallel), the specs module (phase and `tasks.md` checked/total), and the variant's earlier sessions; each step is caught on its own

## 3. Attaching it

- [x] 3.1 In `Sessions.startTaskConversation`, after attaching the session and releasing the claim, gather and build the briefing and put it as `opendevhub-task`, awaited before the first prompt; catch, and log a warning with the task and session ids
- [x] 3.2 Hub tests: New conversation puts the entry before any prompt; `/new <text>` puts it and then prompts; a 404 from opencode still starts the conversation and sends the prompt; starting a task gives its first sessions no entry

## 4. Showing it

- [x] 4.1 Add `OpencodeClient.instructions(sessionId)` for `GET /api/experimental/session/:id/instructions/entries`; in `server/sessions/detail.ts`, put the `opendevhub-task` entry's text as a `{ role: "briefing", text }` message at the start of the transcript (none on 404 or failure); `system` messages stay hidden
- [x] 4.2 In `web/features/sessions/transcript.tsx`, render a briefing row as a collapsed, keyboard-accessible disclosure labelled "Task briefing" that shows the text as markdown when expanded
- [x] 4.3 Add a story or fixture with a briefing row, and a detail mapping test

## 5. Finish

- [x] 5.1 `pnpm exec ultracite fix`, typecheck, and run the test suite
- [x] 5.2 Check in the real app: start a New conversation in a task, expand the Task briefing row, and confirm the agent can answer "what is this task about?" without reading files
- [x] 5.3 `graphify update .`
