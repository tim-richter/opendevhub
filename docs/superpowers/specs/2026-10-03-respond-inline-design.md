# Respond inline

Date: 2026-10-03
Status: Draft for review
Depends on: nothing

## Problem

The dashboard tells you an agent is waiting on a permission or a question, then sends you to the
opencode tab to answer it. The answer is usually one click, so make it one click here. The
opencode web UI stays the place for chatting with an agent.

## Verified opencode facts (2.0.22)

From `GET /openapi.json` on `opencode serve` 2.0.22:

| Need | Endpoint | Notes |
| --- | --- | --- |
| Pending permissions | `GET /api/permission/request` | Items: `{ id, sessionID, action, resources[], save?[], message?, metadata?, source? }`. Listed per directory, as the monitor already does. |
| Reply to a permission | `POST /api/session/:sid/permission/:rid/reply` | `{ decision: "once" \| "always" \| "reject", message?: string }` |
| Pending forms | `GET /api/form` | `{ id, sessionID, title, fields[] }`. Field types: `string` (with optional `options`, `custom`, `format`, `pattern`), `number`, `integer`, `boolean`, `multiselect`, `external` (`url`). Every field may have `required`, `hidden` and `when: [{ key, op: eq\|neq, value }]`. |
| Answer a form | `POST /api/session/:sid/form/:fid/reply` | `{ answer: { [key]: string \| number \| boolean \| string[] } }` |
| Cancel a form | `DELETE /api/session/:sid/form/:fid` | Takes no reason (checked against `openapi.json` while implementing): the asker only learns it was cancelled. |
| Test fixtures | `POST /api/session/:sid/permission`, `POST /api/session/:sid/form` | Create real pending items without an LLM. |

## Data

The monitor already fetches permission requests and forms, then reduces them to a status. Keep
the items and attach them to the root session that the status rolls up to:

```ts
interface PendingPermission {
  id: string;
  sessionId: string;        // the session that asked (may be a subagent); used in the reply path
  action: string;           // e.g. "bash", "edit", "webfetch"
  resources: string[];
  save?: string[];          // patterns "always" would persist
  message?: string;
  createdAt?: number;       // first time the monitor saw it; for ordering
}

interface PendingForm {
  id: string;
  sessionId: string;
  title: string;
  fields: FormField[];      // the opencode schema, passed through unchanged
}

interface SessionSummary {
  // …existing
  pending?: { permissions: PendingPermission[]; forms: PendingForm[] };
}
```

`deriveSessions` already maps each item to its root session. It now also collects the items.
Snapshots stay small: rarely more than a handful are pending at once.

## API

| Route | Body | Calls |
| --- | --- | --- |
| `POST /api/projects/:id/permissions/:rid` | `{ decision, message? }` | `…/permission/:rid/reply` |
| `POST /api/projects/:id/forms/:fid` | `{ answer }` | `…/form/:fid/reply` |
| `DELETE /api/projects/:id/forms/:fid` | none | `DELETE …/form/:fid` |

- **Known ids only.** The server finds `rid`/`fid` in the project's latest snapshot to get the
  `sessionId`. Unknown ids get a 404, so the dashboard only ever forwards ids it listed itself.
- **Already answered elsewhere.** When opencode answers 404 (`PermissionNotFound`,
  `FormNotFound`) or `FormAlreadySettled`, the item was handled in another client, for example
  the opencode tab. The route returns 409 `already answered`, and the UI drops the card without
  showing an error.
- **Invalid answers.** `FormInvalidAnswer` → 400 with opencode's message, shown under the form.
- **Refresh.** After every reply, call `monitor.reconcile()` so the snapshot updates without
  waiting for the SSE event.
- **Security.** No new checks are needed beyond the existing Origin check. Agent-supplied text
  (`message`, `resources`, form titles) is rendered as plain text, never as HTML or Markdown.

## UI

Rows in "Needs you" (on the Overview, the project's Sessions tab and `/sessions`) expand into
cards.

**Permission card.** Shows "*session title* wants to **action**", the resources in monospace
(the first 5, then "+n more"), and the message. Buttons:

- **Allow once**
- **Always allow**: its tooltip lists the `save` patterns, so you know what gets saved as a rule
- **Reject…**: opens an optional reason field; the reason goes back to the agent as `message`

If `metadata` holds a string `diff` or `patch` (likely for `edit`, but not verified), show it as
a plain unified diff. If the review feature has shipped, reuse its diff component.

**Form card.** Renders the fields:

| Field | Control |
| --- | --- |
| `string` with `options` | radios (5 options or fewer) or a select; plus a text input when `custom` |
| `string` | text input, with HTML validation from `format`, `pattern`, `min/maxLength` |
| `number` / `integer` | number input |
| `boolean` | checkbox |
| `multiselect` | checkboxes, honouring `minItems`/`maxItems` and `custom` |
| `external` | "Open" link to `url` |

`when` and `hidden` are evaluated in the browser. Buttons: **Submit**, and **Dismiss** (cancels;
opencode takes no reason). If a field type isn't in the table, the fields are shown read-only
with a link to "Answer in opencode".

**Other behaviour:**

- Several pending items in one session stack oldest first; answering one shows the next.
- Keys, while a card has focus: `Enter` allow once, `a` always, `r` reject, `j`/`k` move
  between cards.
- Notifications say what is being asked ("api · wants **bash**: `npm test`"). Clicking one
  already opens the session's row; now it also focuses the card.

## Not covered

- Approving from the notification itself. That needs a service worker and Web Push, which
  belongs with remote access.
- A bulk "allow all".

## Testing

- **Unit:** `deriveSessions` rolling pending items up to the root session; form `when`/`hidden`
  evaluation and answer building.
- **Integration** (fake opencode): the three routes, including unknown id → 404 and already
  answered → 409.
- **e2e** (real container and opencode): create a permission and a form through opencode's own
  create endpoints, answer them through the dashboard API, and check they're gone.
