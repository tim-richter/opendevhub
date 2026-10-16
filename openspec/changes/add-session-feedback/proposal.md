## Why

opendevhub runs many opencode sessions across chats and task variants, but nothing records whether the result was any good, or which models, agents, skills and MCP tools were behind a good or bad outcome. Asking the user for a score at the end of a chat or task, and pairing it with usage statistics opendevhub can already read from opencode, gives a team the data to compare setups. A configurable endpoint lets them collect this centrally.

## What Changes

- New **session statistics**: on request, opendevhub builds a summary of a chat's or task variant's opencode session, subagent sessions included. The summary holds counts and names only:
  - model, agent, duration, turns and compactions
  - cost and tokens
  - tool calls per tool, with error counts
  - MCP tools per server
  - skills, subagents and slash commands used
  - permission requests asked and denied
  - files and lines changed
  - opencode's outcome, plus opendevhub facts such as variant picked, branch published, PR linked and review findings
- New **feedback prompt**:
  - The user gives a 1–5 score with an optional comment from a "Send feedback" button on a chat or task.
  - opendevhub also offers the prompt when a chat is archived or a task is ended.
  - The user sees exactly what will be sent before it is sent.
  - Each session is rated at most once, and a rating can be resent if delivery failed.
- New **feedback settings**:
  - an on/off switch
  - an endpoint URL, HTTPS or loopback HTTP, validated like the other integration URLs
  - optional authentication: none, bearer token, or basic auth (username + password). The secret is kept in the OS credential store.
  - a "Send test" action
  - whether to ask automatically at chat archive and task end
- Feedback is stored locally (score, comment, payload, delivery state) so it survives a failed send and isn't asked for twice.
- Prompt text, file paths, diffs, tool arguments and any secrets never leave the machine.

## Capabilities

### New Capabilities

- `session-statistics`: building a privacy-safe statistics summary of a chat's or task variant's opencode session tree from opencode messages, sessions and opendevhub's own records.
- `session-feedback`: asking the user for a score and comment on a chat or task, previewing the report, storing it locally, and delivering it to a configured endpoint with optional authentication. The feedback settings are part of this capability.

### Modified Capabilities

<!-- None: the chat and task pages gain a button and an optional prompt, but their existing requirements don't change. -->

## Impact

- **Server:**
  - `server/opencode/client.ts`: read a tool call's `state.input`, needed to name skills and subagents.
  - new `server/sessions/statistics.ts` and a feedback module.
  - a new DB migration for a `session_feedback` table.
  - a new settings file and credential-store entry for the feedback endpoint.
  - new API routes for the statistics preview, feedback submit/resend, settings and the test send.
- **Web:**
  - a feedback dialog (score, comment, payload preview) in `web/features/sessions`.
  - a button on the chat and task pages.
  - auto-prompt hooks on chat archive and task end.
  - a new "Feedback" section in the settings dialog.
- **External:** opendevhub makes outbound HTTP POSTs to the endpoint the user configures. No new dependencies.
