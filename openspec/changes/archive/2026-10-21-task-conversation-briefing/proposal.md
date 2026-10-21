## Why

A task can hold several conversations, but each new one (New conversation, `/new`, a spec's "implement in a new conversation", a review started in the task) starts with empty context. The agent gets the checkout and nothing else: not the task's title or brief, its Jira ticket, its OpenSpec change, or what earlier conversations already committed. It has to rediscover the task from the files, or the user has to retype it. opencode v2 (2.0.27 and 2.1.2 in our environments) now offers durable per-session instruction entries, which let us hand the agent a briefing without turning it into a fake user turn.

## What Changes

- When a conversation is started in an existing task, opendevhub builds a **task briefing**: a deterministic markdown summary made from data it already has, with no LLM call:
  - the task's title, brief and linked ticket;
  - the variant's branch, base and checkout path;
  - commits on the branch since the base, a diffstat against the base, and uncommitted changes;
  - for a spec-first task, its OpenSpec change, phase and task progress, with a pointer to the change's folder;
  - the task's earlier conversations in this variant, by title.
- The briefing is attached to the new opencode session as the instruction entry `opendevhub-task` (opencode's experimental instructions API), before any first prompt is sent.
- If the environment's opencode does not offer that API (404), or the briefing cannot be built, the conversation still starts, without a briefing, and the failure is logged.
- The conversation view shows the resulting "instructions updated" message as a collapsed **Task briefing** row that the user can expand to see exactly what the agent was told.
- Out of scope: an LLM-written handoff summary of the previous conversation, and a task notes file that agents keep up to date. Both may follow later.

## Capabilities

### New Capabilities

- `task-briefing`: what a conversation started in an existing task is told about that task, how it is attached to the session, how it degrades, and how the user sees it.

### Modified Capabilities

<!-- None: starting task conversations is unchanged; the briefing is added alongside. -->

## Impact

- `apps/opendevhub/src/server/sessions/sessions.ts`: `startTaskConversation` attaches the briefing after `createSession` and before the first prompt.
- New server module that builds the briefing (task store, git ops for the variant's checkout, OpenSpec change status).
- `apps/opendevhub/src/server/opencode/client.ts`: a `putInstruction(sessionId, key, value, directory)` method for `PUT /api/experimental/session/:id/instructions/entries/:key`.
- `apps/opendevhub/src/server/sessions/detail.ts` and `web/features/sessions/transcript.tsx`: map and render the instructions-updated message as a Task briefing row.
- `test/helpers/fake-opencode.ts`: support the instructions route (and a 404 mode) for tests.
- Depends on an **experimental** opencode route; the call is kept in one client method so an upstream change is a one-place fix.
