## 1. Verify opencode data

- [ ] 1.1 Against a running opencode 2.0.26, check and record:
  - the tool-call `state.input` keys for `skill` and `task` calls
  - whether `/api/mcp` (or similar) lists configured MCP servers
  - how MCP tool names are formed
  - whether denied permissions are visible in message history or events

  Update design decisions 2 and 8 with what you find.

- [ ] 1.2 Save a trimmed real transcript (skill, subagent, MCP and bash calls; prompts redacted) as a test fixture

## 2. Statistics

- [ ] 2.1 Add `input?: Record<string, unknown>` to `RawAssistantContent.state` in `server/opencode/client.ts`, and an MCP server list call if 1.1 found one
- [ ] 2.2 Define the `SessionStats` and `FeedbackReport` types in `shared/`
- [ ] 2.3 Implement pure `summarize()` in `server/sessions/statistics.ts`:
  - totals and turns/compactions
  - tool, MCP, skill and subagent classification
  - slash commands
  - diff counts
  - `truncated`
- [ ] 2.4 Implement the hub-facts query: variant picked/count, branch published, PR linked, newest review findings count
- [ ] 2.5 Implement `buildStats(chat | variant)`: walk the session tree (`childSessions` recursively, in parallel), page `messages()` up to the cap, and combine with hub facts. If the session was removed, report "no statistics".
- [ ] 2.6 Unit tests for `summarize()` from the 1.2 fixture, covering every session-statistics scenario, including the "nothing private" check that no prompt, path or command text appears

## 3. Storage and settings

- [ ] 3.1 Append a migration creating `session_feedback` with its unique indexes (don't edit existing migrations)
- [ ] 3.2 Add `server/db/feedback.ts`: insert, get by chat or variant, and mark sent/failed
- [ ] 3.3 Add feedback settings (enabled, url, auth, username, autoAsk) with the secret in `OsSecretStore("opendevhub.feedback")`, validating the URL with `integrationUrl()`
- [ ] 3.4 Tests for the settings: loopback-only HTTP, the secret is never returned, `hasSecret` is reported

## 4. Delivery and API

- [ ] 4.1 Implement `deliver(payload, settings)`: POST JSON with a Bearer/Basic header and a 10 s timeout; 2xx means sent; redact the secret from errors
- [ ] 4.2 API routes:
  - `GET` feedback settings, `PUT` feedback settings, `POST` test
  - `GET` preview for a chat or variant (stats + existing feedback)
  - `POST` submit (score 1–5, comment ≤ 2000)
  - `POST` resend
- [ ] 4.3 Submit flow: refuse a second feedback for the same chat or variant, build the report with a new `reportId`, store it as pending, deliver, then store the result
- [ ] 4.4 Tests:
  - submit happy path
  - endpoint down → failed
  - resend posts an identical payload with the same `reportId`
  - duplicate submit refused
  - feedback off → routes refuse and nothing is posted

## 5. Web

- [ ] 5.1 Add a "Feedback" section to the settings dialog (switch, URL, auth mode, username/secret, auto-ask, "Send test" with result), modelled on `integrations-settings.tsx`
- [ ] 5.2 Build `FeedbackDialog` in `web/features/sessions/feedback-dialog.tsx`:
  - 1–5 score, comment, collapsible JSON preview
  - send disabled until a score is chosen
  - shows the stored state with Resend when the chat or variant was already rated
- [ ] 5.3 Add the "Send feedback" button to the chat view and task page headers, shown only while feedback is on, rating the shown variant on a task
- [ ] 5.4 Auto-ask: open the dialog after archiving a chat or ending a task when `enabled && autoAsk` and no feedback exists
- [ ] 5.5 Stories for the dialog (new, sending, sent, failed) and the settings section, plus mock fixtures/handlers for the new API

## 6. Finish

- [ ] 6.1 Run `pnpm exec ultracite fix`, typecheck and tests
- [ ] 6.2 Check end to end against a local HTTP receiver on loopback: test send, rate a chat, failed then resent delivery
- [ ] 6.3 Run `graphify update .`
