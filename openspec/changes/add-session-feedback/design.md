## Context

opendevhub reads everything it needs about a session from opencode over HTTP (`server/opencode/client.ts`):

- **Sessions** (`RawSession`): cost, tokens, model, agent, outcome and parent.
- **Messages** (`RawMessage`): user prompts, assistant content parts with tool calls, errors, compactions and changed files.

It keeps its own records in SQLite: chats, tasks, variants, task_sessions, branches, pull_requests, reviews and events. It already adds subagent spend into the root session (`rollUp` in `server/sessions/status.ts`).

External integrations (Forgejo, Jira) store a URL in a settings file and a token in the OS credential store through `FileIntegrationSettings` + `OsSecretStore` (`server/integrations/settings.ts`, `secrets.ts`). `integrationUrl()` validates the URL.

Today `RawAssistantContent` keeps only a tool call's `name`, `state.status` and `state.title`. Skill and subagent names are in the call's input, which isn't read yet.

## Goals / Non-Goals

**Goals:**

- One user action rates one chat or task variant and posts a privacy-safe report to an endpoint the user configures.
- The report is built from data opendevhub can already reach, with no new collection running during sessions.
- Failed deliveries can be retried, and nothing is asked for twice.

**Non-Goals:**

- A receiving server, a dashboard or any aggregation. The endpoint is the user's.
- Rating single turns or messages.
- Sending prompt text, code, paths or diffs, even as an opt-in.
- Automatic background retry or batching.
- Rating sessions that opendevhub doesn't track as a chat or variant.

## Decisions

### 1. Build statistics on demand from opencode, not live from the event stream

When the dialog opens, `GET .../feedback/preview` calls `session()`, `childSessions()` (recursively) and `messages()` for each session in the tree, then reduces them in a pure function `summarize(sessions, messagesBySession, hubFacts)` in `server/sessions/statistics.ts`.

- **Why:** opencode already keeps the full history, so a reduction on demand works after a restart and needs no new tables or event handling. It's also easy to test with fixtures.
- **Alternative rejected:** counting from `/api/event` as events arrive. That misses events while opendevhub is down and duplicates what opencode already stores.

`messages()` is paged by `limit`. The statistics builder SHALL page until it has every message, with a hard cap: 5000 messages per session. A summary that hits the cap is marked `truncated: true`.

### 2. Classifying tool calls

Each tool call is classified in this order:

- **Skill:** the name is `skill`. The skill name is read from `state.input.name`, falling back to parsing `state.title`.
- **Subagent:** the name is `task`. The agent name is read from `state.input.subagent_type` / `state.input.agent`, and child sessions' `agent` is used as a cross-check.
- **MCP:** the name starts with `<server>_` for one of the MCP servers opencode reports for that directory. It is split into server and tool.
  - If opencode exposes no MCP list, the fallback is: any name that isn't in the built-in tool list and contains `_` counts as MCP, split on the first `_`.
- **Built-in:** everything else.

`RawAssistantContent.state` gains `input?: Record<string, unknown>`. Only the listed keys are read: skill name and agent name. Nothing else from `input` is kept.

**Open:** the exact keys are verified against opencode 2.0.26 in task 1.1 before this is built.

### 3. Hub facts come from the DB

Variant picked or discarded, variant count, `branches.published_at`, linked `pull_request_id`, and the newest `reviews` row's finding count are read in one query helper next to `server/db/provenance.ts`.

Slash commands are counted from user messages whose text starts with `/name`, matched against the known command list. Hub commands are included.

### 4. Storage: a `session_feedback` table in a new migration

```sql
CREATE TABLE session_feedback (
  id           TEXT PRIMARY KEY,           -- random report id, sent as reportId
  chat_id      TEXT REFERENCES chats (id),
  task_id      TEXT,
  variant_n    INTEGER,
  session_id   TEXT NOT NULL,
  score        INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment      TEXT,
  payload      TEXT NOT NULL,              -- exact JSON posted
  state        TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed')),
  error        TEXT,
  submitted_at INTEGER NOT NULL,
  sent_at      INTEGER,
  FOREIGN KEY (task_id, variant_n) REFERENCES variants (task_id, n) ON DELETE SET NULL,
  CHECK ((chat_id IS NULL) <> (task_id IS NULL))
);
CREATE UNIQUE INDEX session_feedback_chat ON session_feedback (chat_id) WHERE chat_id IS NOT NULL;
CREATE UNIQUE INDEX session_feedback_variant ON session_feedback (task_id, variant_n) WHERE task_id IS NOT NULL;
```

The table goes in a new migration appended to `server/db/migrations.ts`, never edited into an existing one.

The stored `payload` is what "Resend" posts, so a resend can't drift from what the user previewed.

### 5. Settings: reuse `FileIntegrationSettings`

Settings live in a `feedback` settings file with this shape:

```ts
{
  enabled: boolean;
  url: string;
  auth: "none" | "bearer" | "basic";
  username?: string;
  autoAsk: boolean;
  secretRef?: string;
}
```

The secret is stored with `OsSecretStore("opendevhub.feedback")`. The URL is validated with `integrationUrl()`.

If `FileIntegrationSettings` can't hold the extra fields cleanly, a small sibling class uses the same file-plus-keychain pattern. The pattern matters more than the class.

The `Authorization` header is either `Bearer <token>` or `Basic base64(username:password)`. The secret is never returned by the settings API, which reports only `hasSecret`.

### 6. Delivery

The POST is made from the server, not the browser. That way the secret stays server-side and CORS doesn't apply.

- It has a 10-second timeout.
- Any 2xx counts as sent.
- Anything else is stored as `failed`, with the status, or the network error with the secret redacted.

The send runs synchronously in the submit request, so the dialog can show the result right away.

"Send test" posts a report with `test: true` and fixed sample statistics.

### 7. Report shape

```jsonc
{
  "schemaVersion": 1,
  "reportId": "uuid",
  "test": false,
  "opendevhubVersion": "x.y.z",
  "submittedAt": "ISO-8601",
  "score": 4,
  "comment": "…",
  "stats": {
    "kind": "chat",
    "project": "shop",
    "opencodeVersion": "…",
    "model": { "providerID": "…", "id": "…" },
    "agent": "build",
    "durationMs": 0,
    "turns": 0,
    "compactions": 0,
    "costUsd": 0,
    "tokens": {
      "input": 0,
      "output": 0,
      "reasoning": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
    },
    "tools": { "bash": { "calls": 5, "errors": 1 } },
    "mcp": { "context7": { "query-docs": { "calls": 2, "errors": 0 } } },
    "skills": ["openspec-propose"],
    "subagents": ["explore"],
    "commands": ["review"],
    "permissions": { "asked": 3, "denied": 1 },
    "diff": { "files": 6, "additions": 210, "deletions": 40 },
    "outcome": "succeeded",
    "variant": { "picked": true, "count": 3 },
    "branchPublished": true,
    "pullRequestLinked": true,
    "reviewFindings": 3,
    "truncated": false,
  },
}
```

The type lives in `shared/` so the dialog preview and the server use the same definition.

### 8. Permission counts

opencode only lists open permission requests (`/api/permission/request`), so the history has to come from somewhere else.

- **Preferred:** count from tool calls whose `state.status` is `error` with a permission-denied marker. Count `asked` from the `permission.asked` / `permission.replied` events opendevhub already receives, and record a running count per session in memory, persisted with the feedback.
- **Fallback:** if neither is reliable (checked in task 1.1), drop `permissions` from v1 rather than report wrong numbers.

### 9. Web

- **Dialog:** `FeedbackDialog` in `web/features/sessions/feedback-dialog.tsx`, built from shadcn `Dialog`, `ToggleGroup` (1–5), `Textarea`, and a collapsible `<pre>` preview.
- **Button:** next to the usage popover in the session header, for both chat and task variant.
- **Auto-ask:** the archive-chat and end-task actions open the dialog after they succeed, when settings say `enabled && autoAsk` and the preview reports no existing feedback.
- **Settings:** a "Feedback" section in `settings-dialog.tsx` that follows `integrations-settings.tsx`.

## Risks / Trade-offs

- **[Skill and subagent names come from opencode's tool input keys, which can change between versions]** → Read defensively, fall back to `title`, and pin the expected keys in a test fixture built from a real 2.0.26 transcript.
- **[MCP detection by name prefix could misclassify a built-in tool with `_`]** → Prefer opencode's MCP server list. Keep an explicit built-in tool set for the fallback.
- **[Large sessions make the preview slow (many message pages)]** → Use the 5000-message cap and the `truncated` flag. Fetch sessions in the tree in parallel.
- **[The project name could identify a private project]** → It's documented in the preview the user sees before sending. Hashing it is left as a later option if teams ask.
- **[Synchronous send blocks the dialog for up to 10 s]** → Show a spinner. On timeout the feedback is stored as failed and can be resent, and the stable `reportId` lets the receiver deduplicate.

## Migration Plan

The table comes from an appended migration, and feedback is off by default, so existing installs see no change until a user turns it on. To roll back, remove the settings file. The table is harmless if left in place.

## Open Questions

- What are the exact `state.input` keys for opencode's `skill` and `task` tools, and does opencode 2.0.26 expose its configured MCP servers over HTTP (`/api/mcp`)? (task 1.1)
- Is there a reliable source for permission history, or is `permissions` dropped from v1? (task 1.1)
