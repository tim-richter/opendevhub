# Respond Inline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer an agent's permission requests and questions (forms) straight from the dashboard, in one click, without switching to the opencode tab.

**Architecture:** The monitor already fetches pending permission requests and forms. It now keeps them, with when it first saw each one, and `deriveSessions` attaches them to the root session as `SessionSummary.pending`. Three dashboard routes look the item up in the latest snapshot, forward the reply to opencode through `OpencodeClient` and then call `monitor.reconcile()`. In the web UI, rows of waiting sessions grow a card stack. The form logic (visibility, answer building) lives in a pure module so it can be unit-tested.

**Tech Stack:** TypeScript, Hono (server), React 19 + react-router (web), vitest (node environment, no DOM), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-03-respond-inline-design.md`

## Global Constraints

- Target opencode 2.0.22. Its endpoints are `POST /api/session/:sid/permission/:rid/reply` `{ decision: "once" | "always" | "reject", message? }`, `POST /api/session/:sid/form/:fid/reply` `{ answer }` and `DELETE /api/session/:sid/form/:fid?message=`.
- No new runtime or dev dependencies.
- Agent-supplied text (`message`, `resources`, form titles, field labels, diffs) is rendered as plain text, never as HTML or Markdown. Never use `dangerouslySetInnerHTML`.
- No new security checks beyond the existing Origin check in `dashboard-api.ts`.
- Unknown ids → 404. Already answered elsewhere → 409 `already answered`. Invalid answer → 400 with opencode's message.
- Call `monitor.reconcile()` after every reply attempt, whether it succeeded or failed.
- Commands: `pnpm exec vitest run <file>` for a single file, `pnpm test` for everything, `pnpm typecheck`, `pnpm build`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A form `external` field whose `url` uses `javascript:` or `data:`.** It must not become a clickable link, only http(s) is linked. Pinned in Task 6 (`safeUrl`).
2. **opencode's real error bodies differ from the assumed `{ _tag, message }`** (no JSON, or another status). A 404 must still mean "already answered", and a failure we don't recognise must stay a 500 rather than be swallowed. Pinned in Task 3 (non-JSON error body) and Task 4 (bare 404). Task 9 checks it against a real server.
3. **The pending item belongs to a subagent.** The reply must use the asking session's id, not the root's, along with the root's directory. Pinned in Task 4.
4. **`when` conditions against values the user hasn't touched, or numbers typed as strings** (`when: { key: "n", op: "eq", value: 3 }` while the input holds `"3"`). Pinned in Task 6.
5. **A double click, or Enter pressed twice.** The second reply comes back 409, and the card must drop quietly rather than show an error. An invalid agent-supplied `pattern` must not crash the form either. Pinned in Task 7 (409 → `"gone"`) and Task 6 (invalid regex is ignored).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` (modify) | `FormField`, `FormAnswer`, `PermissionDecision`, `PendingPermission`, `PendingForm`, `PendingItems`, plus `SessionSummary.pending` |
| `src/server/opencode/client.ts` (modify) | Raw item fields; `replyPermission`, `replyForm`, `cancelForm`; error tags; `isGone`, `isInvalidAnswer` |
| `src/server/status.ts` (modify) | `deriveSessions` collects the pending items for each root session |
| `src/server/monitor.ts` (modify) | Tracks when each pending item was first seen |
| `src/server/state.ts` (modify) | `sessionsOf(id)` accessor |
| `src/server/orchestrator.ts` (modify) | `replyPermission`, `replyForm`, `cancelForm`; `AlreadyAnsweredError`; `NotFoundError(id, what)` |
| `src/server/dashboard-api.ts` (modify) | Three routes; 409 mapping |
| `test/helpers/fake-opencode.ts` (modify) | Reply and cancel endpoints with opencode-style errors |
| `src/web/forms.ts` (create) | Pure form logic: field options, visibility, initial values, answer building, safe URLs |
| `src/web/api.ts` (modify) | `replyPermission`, `replyForm`, `dismissForm`, which return `"done" \| "gone"` |
| `src/web/derive.ts` (modify) | `pendingSummary`; notification text says what is being asked |
| `src/web/components/PendingCards.tsx` (create) | `PendingStack`, permission card, form card, field controls, diff view, keyboard handling |
| `src/web/components/SessionList.tsx` (modify) | Renders a `PendingStack` under the rows of waiting sessions |
| `src/web/pages/ProjectPage.tsx` (modify) | A highlighted session (from a notification click) also focuses its card |
| `src/web/styles.css` (modify) | Card styles |
| `test/e2e/opendevhub.e2e.ts` (modify) | Real opencode: create, answer and cancel |

---

### Task 1: Pending items in the session summary

**Files:**

- Modify: `src/shared/types.ts` (after `SessionSummary`)
- Modify: `src/server/opencode/client.ts` (`RawPermissionRequest`, `RawForm`)
- Modify: `src/server/status.ts`
- Test: `test/server/status.test.ts`

**Interfaces:**

- Produces (shared types, used by every later task):
  ```ts
  export interface FormField {
    key: string;
    type: string;
    title?: string;
    description?: string;
    required?: boolean;
    hidden?: boolean;
    when?: { key: string; op: "eq" | "neq"; value: unknown }[];
    default?: unknown;
    options?: (string | { value: string; label?: string })[];
    custom?: boolean;
    format?: string;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
    url?: string;
  }
  export type FormAnswer = Record<string, string | number | boolean | string[]>;
  export type PermissionDecision = "once" | "always" | "reject";
  export interface PendingPermission {
    id: string;
    sessionId: string;
    action: string;
    resources: string[];
    save?: string[];
    message?: string;
    diff?: string;
    createdAt?: number;
  }
  export interface PendingForm {
    id: string;
    sessionId: string;
    title: string;
    fields: FormField[];
    createdAt?: number;
  }
  export interface PendingItems {
    permissions: PendingPermission[];
    forms: PendingForm[];
  }
  // SessionSummary gains: pending?: PendingItems   (omitted when nothing is pending)
  ```
- Produces: `StatusInput.firstSeen?: Map<string, number>`, which Task 2 fills.
- Note: the spec's `PendingPermission` has no `diff`. It's added here because the spec's UI section needs a string `metadata.diff`/`metadata.patch`, and passing all of `metadata` through would bloat the snapshot. `PendingForm.createdAt` is added so that permissions and forms can be ordered together.

- [ ] **Step 1: Add the shared types**

In `src/shared/types.ts`, replace the `SessionSummary` interface with:

```ts
/** A field of an opencode form, passed through unchanged. `type` stays open so new field types still reach the UI. */
export interface FormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: { key: string; op: "eq" | "neq"; value: unknown }[];
  default?: unknown;
  options?: (string | { value: string; label?: string })[];
  custom?: boolean;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  url?: string;
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

export type PermissionDecision = "once" | "always" | "reject";

export interface PendingPermission {
  id: string;
  /** The session that asked (may be a subagent); used in the reply path. */
  sessionId: string;
  action: string;
  resources: string[];
  /** Patterns "always" would persist. */
  save?: string[];
  message?: string;
  /** A unified diff from the request's metadata (`diff` or `patch`), when it carries one. */
  diff?: string;
  /** First time the monitor saw it; for ordering. */
  createdAt?: number;
}

export interface PendingForm {
  id: string;
  sessionId: string;
  title: string;
  fields: FormField[];
  createdAt?: number;
}

export interface PendingItems {
  permissions: PendingPermission[];
  forms: PendingForm[];
}

export interface SessionSummary {
  id: string;
  projectId: ProjectId;
  title: string;
  directory: string;
  updatedAt: number;
  status: SessionStatus;
  /** What the session (or one of its subagents) is waiting on, oldest first. Omitted when nothing is. */
  pending?: PendingItems;
}
```

In `src/server/opencode/client.ts`, add `import type { FormField } from "../../shared/types";` at the top, then extend the raw types:

```ts
export interface RawPermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
  save?: string[];
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface RawForm {
  id: string;
  sessionID: string;
  title: string;
  fields?: FormField[];
}
```

- [ ] **Step 2: Write the failing tests**

Append inside `describe("deriveSessions", …)` in `test/server/status.test.ts`:

```ts
it("attaches pending items to the root session, keeping the asking session's id", () => {
  const out = deriveSessions("p", {
    ...base,
    sessions: [rawSession("root"), rawSession("child", { parentID: "root" })],
    permissions: [
      {
        id: "per_1",
        sessionID: "child",
        action: "bash",
        resources: ["npm test"],
        save: ["npm *"],
        message: "run tests",
      },
    ],
    forms: [
      {
        id: "frm_1",
        sessionID: "root",
        title: "Which DB?",
        fields: [{ key: "db", type: "string" }],
      },
    ],
  });
  expect(out[0].pending).toEqual({
    permissions: [
      {
        id: "per_1",
        sessionId: "child",
        action: "bash",
        resources: ["npm test"],
        save: ["npm *"],
        message: "run tests",
      },
    ],
    forms: [
      {
        id: "frm_1",
        sessionId: "root",
        title: "Which DB?",
        fields: [{ key: "db", type: "string" }],
      },
    ],
  });
});

it("omits pending when nothing is waiting and tolerates missing resources and fields", () => {
  const out = deriveSessions("p", {
    ...base,
    sessions: [rawSession("a"), rawSession("b")],
    permissions: [{ id: "per_1", sessionID: "a", action: "edit" }],
    forms: [{ id: "frm_1", sessionID: "a", title: "q" }],
  });
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  expect(byId.b.pending).toBeUndefined();
  expect(byId.a.pending).toEqual({
    permissions: [
      { id: "per_1", sessionId: "a", action: "edit", resources: [] },
    ],
    forms: [{ id: "frm_1", sessionId: "a", title: "q", fields: [] }],
  });
});

it("orders pending items oldest first by when they were first seen", () => {
  const out = deriveSessions("p", {
    ...base,
    sessions: [rawSession("a")],
    permissions: [
      { id: "new", sessionID: "a", action: "bash" },
      { id: "old", sessionID: "a", action: "bash" },
    ],
    firstSeen: new Map([
      ["new", 200],
      ["old", 100],
    ]),
  });
  expect(out[0].pending?.permissions.map((p) => [p.id, p.createdAt])).toEqual([
    ["old", 100],
    ["new", 200],
  ]);
});

it("takes a string diff or patch from the metadata and ignores anything else", () => {
  const out = deriveSessions("p", {
    ...base,
    sessions: [rawSession("a")],
    permissions: [
      {
        id: "p1",
        sessionID: "a",
        action: "edit",
        metadata: { patch: "--- a\n+++ b\n" },
      },
      {
        id: "p2",
        sessionID: "a",
        action: "edit",
        metadata: { diff: { not: "a string" } },
      },
    ],
  });
  expect(out[0].pending?.permissions.map((p) => p.diff)).toEqual([
    "--- a\n+++ b\n",
    undefined,
  ]);
});
```

- [ ] **Step 3: Run the tests and check that they fail**

Run: `pnpm exec vitest run test/server/status.test.ts` Expected: FAIL. The four new tests fail because `pending` is undefined, or the `firstSeen` key is rejected by the type checker in the IDE. The existing tests still pass.

- [ ] **Step 4: Implement**

Replace `src/server/status.ts` with:

```ts
import type {
  PendingForm,
  PendingItems,
  PendingPermission,
  SessionStatus,
  SessionSummary,
} from "../shared/types";
import type {
  RawForm,
  RawPermissionRequest,
  RawSession,
} from "./opencode/client";

export interface StatusInput {
  sessions: RawSession[];
  active: Set<string>;
  permissions: RawPermissionRequest[];
  forms: RawForm[];
  /** When the monitor first saw each pending item, by item id. */
  firstSeen?: Map<string, number>;
}

const RANK: Record<SessionStatus, number> = {
  "needs-permission": 0,
  "needs-answer": 1,
  running: 2,
  idle: 3,
};

export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  return RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt;
}

function rootOf(id: string, parents: Map<string, string | undefined>): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (!parent) return current;
    current = parent;
  }
  return current;
}

function toPermission(
  p: RawPermissionRequest,
  createdAt: number | undefined
): PendingPermission {
  const diff = [p.metadata?.diff, p.metadata?.patch].find(
    (v): v is string => typeof v === "string"
  );
  return {
    id: p.id,
    sessionId: p.sessionID,
    action: p.action,
    resources: Array.isArray(p.resources)
      ? p.resources.filter((r): r is string => typeof r === "string")
      : [],
    ...(p.save?.length ? { save: p.save } : {}),
    ...(p.message ? { message: p.message } : {}),
    ...(diff ? { diff } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function toForm(f: RawForm, createdAt: number | undefined): PendingForm {
  return {
    id: f.id,
    sessionId: f.sessionID,
    title: f.title,
    fields: Array.isArray(f.fields) ? f.fields : [],
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

const byAge = (a: { createdAt?: number }, b: { createdAt?: number }) =>
  (a.createdAt ?? 0) - (b.createdAt ?? 0);

export function deriveSessions(
  projectId: string,
  input: StatusInput
): SessionSummary[] {
  const parents = new Map(input.sessions.map((s) => [s.id, s.parentID]));
  const flags = new Map<string, SessionStatus>();
  const pending = new Map<string, PendingItems>();
  const raise = (sessionId: string, status: SessionStatus) => {
    const root = rootOf(sessionId, parents);
    const current = flags.get(root);
    if (!current || RANK[status] < RANK[current]) flags.set(root, status);
  };
  const itemsOf = (sessionId: string): PendingItems => {
    const root = rootOf(sessionId, parents);
    let items = pending.get(root);
    if (!items) pending.set(root, (items = { permissions: [], forms: [] }));
    return items;
  };
  const seen = (id: string) => input.firstSeen?.get(id);

  for (const id of input.active) raise(id, "running");
  for (const f of input.forms) {
    raise(f.sessionID, "needs-answer");
    itemsOf(f.sessionID).forms.push(toForm(f, seen(f.id)));
  }
  for (const p of input.permissions) {
    raise(p.sessionID, "needs-permission");
    itemsOf(p.sessionID).permissions.push(toPermission(p, seen(p.id)));
  }

  return input.sessions
    .filter((s) => !s.parentID && s.time.archived === undefined)
    .map((s) => {
      const items = pending.get(s.id);
      return {
        id: s.id,
        projectId,
        title: s.title?.trim() || "Untitled session",
        directory: s.location.directory,
        updatedAt: s.time.updated,
        status: flags.get(s.id) ?? "idle",
        ...(items
          ? {
              pending: {
                permissions: items.permissions.sort(byAge),
                forms: items.forms.sort(byAge),
              },
            }
          : {}),
      };
    })
    .sort(compareSessions);
}
```

- [ ] **Step 5: Run the tests and check that they pass**

Run: `pnpm exec vitest run test/server/status.test.ts && pnpm typecheck` Expected: all of `status.test.ts` passes and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/server/opencode/client.ts src/server/status.ts test/server/status.test.ts
git commit -m "feat: keep pending permissions and forms on the root session summary"
```

---

### Task 2: Monitor records when it first saw each pending item

**Files:**

- Modify: `src/server/monitor.ts`
- Test: `test/server/monitor.test.ts`

**Interfaces:**

- Consumes: `StatusInput.firstSeen` (Task 1).
- Produces: `MonitorOptions.now?: () => number` (defaults to `Date.now`; for tests). `SessionSummary.pending.*.createdAt` is set from now on.

- [ ] **Step 1: Write the failing test**

Append inside `describe("Monitor", …)` in `test/server/monitor.test.ts`:

```ts
it("stamps pending items with when they were first seen and forgets answered ones", async () => {
  let clock = 100;
  fake.state.sessions = [rawSession("ses_1")];
  fake.state.permissions["/workspaces/demo"] = [
    {
      id: "per_1",
      sessionID: "ses_1",
      action: "bash",
      resources: ["npm test"],
    },
  ];
  start({ now: () => clock });
  await vi.waitFor(() =>
    expect(latest?.[0].pending?.permissions).toHaveLength(1)
  );
  expect(latest?.[0].pending?.permissions[0]).toMatchObject({
    id: "per_1",
    resources: ["npm test"],
    createdAt: 100,
  });

  clock = 200;
  fake.state.permissions["/workspaces/demo"].push({
    id: "per_2",
    sessionID: "ses_1",
    action: "edit",
  });
  await monitor!.reconcile();
  expect(
    latest?.[0].pending?.permissions.map((p) => [p.id, p.createdAt])
  ).toEqual([
    ["per_1", 100],
    ["per_2", 200],
  ]);

  fake.state.permissions["/workspaces/demo"] = [];
  await monitor!.reconcile();
  expect(latest?.[0].pending).toBeUndefined();

  clock = 300;
  fake.state.permissions["/workspaces/demo"] = [
    { id: "per_1", sessionID: "ses_1", action: "bash" },
  ];
  await monitor!.reconcile();
  expect(latest?.[0].pending?.permissions[0].createdAt).toBe(300);
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `pnpm exec vitest run test/server/monitor.test.ts -t "first seen"` Expected: FAIL, because `createdAt` is undefined.

- [ ] **Step 3: Implement**

In `src/server/monitor.ts`:

Add to `MonitorOptions`:

```ts
  /** Clock for stamping when a pending item was first seen; tests pass their own. */
  now?: () => number;
```

Add a field to `Monitor`:

```ts
  private readonly firstSeen = new Map<string, number>();
```

In `fetchAndDerive`, replace the two lines

```ts
const permissions = uniqueById(perDirectory.flatMap(([p]) => p));
const forms = uniqueById(perDirectory.flatMap(([, f]) => f));
```

with

```ts
const permissions = uniqueById(perDirectory.flatMap(([p]) => p));
const forms = uniqueById(perDirectory.flatMap(([, f]) => f));
this.stamp([...permissions, ...forms].map((i) => i.id));
```

and replace

```ts
this.opts.onSessions(
  deriveSessions(projectId, { sessions: all, active, permissions, forms })
);
```

with

```ts
this.opts.onSessions(
  deriveSessions(projectId, {
    sessions: all,
    active,
    permissions,
    forms,
    firstSeen: this.firstSeen,
  })
);
```

Add the method below `fetchAndDerive`:

```ts
  /** Remembers when each pending item first showed up, so the dashboard can list them oldest first. */
  private stamp(ids: string[]): void {
    const now = (this.opts.now ?? Date.now)();
    const current = new Set(ids);
    for (const id of this.firstSeen.keys()) if (!current.has(id)) this.firstSeen.delete(id);
    for (const id of current) if (!this.firstSeen.has(id)) this.firstSeen.set(id, now);
  }
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm exec vitest run test/server/monitor.test.ts` Expected: PASS (the whole file).

- [ ] **Step 5: Commit**

```bash
git add src/server/monitor.ts test/server/monitor.test.ts
git commit -m "feat: stamp pending items with when the monitor first saw them"
```

---

### Task 3: OpencodeClient replies and the fake opencode endpoints

**Files:**

- Modify: `src/server/opencode/client.ts`
- Modify: `test/helpers/fake-opencode.ts`
- Test: `test/server/opencode-client.test.ts`

**Interfaces:**

- Consumes: `FormAnswer`, `PermissionDecision` (Task 1).
- Produces:
  ```ts
  class OpencodeHttpError { readonly status: number; readonly tag?: string; readonly detail?: string }
  OpencodeClient.replyPermission(sessionId: string, requestId: string, reply: { decision: PermissionDecision; message?: string }, directory?: string): Promise<void>
  OpencodeClient.replyForm(sessionId: string, formId: string, answer: FormAnswer, directory?: string): Promise<void>
  OpencodeClient.cancelForm(sessionId: string, formId: string, message?: string, directory?: string): Promise<void>
  export function isGone(err: unknown): err is OpencodeHttpError          // answered or cancelled elsewhere
  export function isInvalidAnswer(err: unknown): err is OpencodeHttpError // opencode rejected the answer
  ```
- Fake opencode produces: `state.replies: Array<{ method: string; path: string; body?: unknown }>`, `state.invalidAnswer?: string` (next form reply answers 400 FormInvalidAnswer), `state.settledForms?: string[]` (replies for these answer 400 FormAlreadySettled), and `state.plainErrors?: boolean` (errors are sent as non-JSON text).
- The `directory` argument becomes the `x-opencode-directory` header. Pending items are listed per directory, so replies send the asking session's directory too in case opencode resolves the item through that instance.

- [ ] **Step 1: Extend the fake opencode**

In `test/helpers/fake-opencode.ts`, add these fields to `FakeState`:

```ts
  /** Every reply or cancel opendevhub sent. */
  replies: Array<{ method: string; path: string; body?: unknown }>;
  /** When set, form replies answer 400 FormInvalidAnswer with this message. */
  invalidAnswer?: string;
  /** Form ids that answer 400 FormAlreadySettled. */
  settledForms?: string[];
  /** Answer errors with plain text instead of opencode's JSON. */
  plainErrors?: boolean;
```

and `replies: [],` to the defaults in `startFakeOpencode`. After the `json` helper inside the request handler, add:

```ts
const fail = (status: number, tag: string, message?: string) => {
  if (state.plainErrors) {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end("error");
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ _tag: tag, ...(message ? { message } : {}) }));
};
const settle = (
  kind: "permission" | "form",
  sessionId: string,
  itemId: string,
  body: unknown
) => {
  state.replies.push({
    method: req.method ?? "",
    path: `${url.pathname}${url.search}`,
    body,
  });
  if (kind === "form" && state.settledForms?.includes(itemId))
    return fail(400, "FormAlreadySettled");
  const lists: Record<
    string,
    Array<{ id: string; sessionID: string }>
  > = kind === "permission" ? state.permissions : state.forms;
  for (const items of Object.values(lists)) {
    const idx = items.findIndex(
      (i) => i.id === itemId && i.sessionID === sessionId
    );
    if (idx < 0) continue;
    if (kind === "form" && req.method === "POST" && state.invalidAnswer) {
      return fail(400, "FormInvalidAnswer", state.invalidAnswer);
    }
    items.splice(idx, 1);
    return json(true);
  }
  return fail(
    404,
    kind === "permission" ? "PermissionNotFound" : "FormNotFound"
  );
};
```

In the `default:` branch, before the `const one = …` line, add:

```ts
const reply = url.pathname.match(
  /^\/api\/session\/([^/]+)\/(permission|form)\/([^/]+?)(\/reply)?$/
);
if (reply && (req.method === "POST" || req.method === "DELETE")) {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
  req.on("end", () =>
    settle(
      reply[2] as "permission" | "form",
      decodeURIComponent(reply[1]),
      decodeURIComponent(reply[3]),
      raw ? JSON.parse(raw) : undefined
    )
  );
  return;
}
```

- [ ] **Step 2: Write the failing tests**

In `test/server/opencode-client.test.ts`, change the import to:

```ts
import {
  OpencodeClient,
  OpencodeHttpError,
  type OpencodeEvent,
  isGone,
  isInvalidAnswer,
} from "../../src/server/opencode/client";
```

and append inside `describe("OpencodeClient", …)`:

```ts
it("replies to a permission request on behalf of the asking session", async () => {
  fake.state.permissions["/w/x"] = [
    { id: "per_1", sessionID: "ses_child", action: "bash" },
  ];
  await client.replyPermission(
    "ses_child",
    "per_1",
    { decision: "reject", message: "not now" },
    "/w/x"
  );
  expect(fake.state.replies).toEqual([
    {
      method: "POST",
      path: "/api/session/ses_child/permission/per_1/reply",
      body: { decision: "reject", message: "not now" },
    },
  ]);
  expect(fake.state.permissions["/w/x"]).toEqual([]);
});

it("answers and cancels forms", async () => {
  fake.state.forms["/w"] = [
    { id: "frm_1", sessionID: "ses_1", title: "Q" },
    { id: "frm_2", sessionID: "ses_1", title: "Q2" },
  ];
  await client.replyForm("ses_1", "frm_1", { db: "postgres", n: 2 });
  await client.cancelForm("ses_1", "frm_2", "answered in chat");
  expect(fake.state.replies).toEqual([
    {
      method: "POST",
      path: "/api/session/ses_1/form/frm_1/reply",
      body: { answer: { db: "postgres", n: 2 } },
    },
    {
      method: "DELETE",
      path: "/api/session/ses_1/form/frm_2?message=answered+in+chat",
      body: undefined,
    },
  ]);
  expect(fake.state.forms["/w"]).toEqual([]);
});

it("classifies opencode's errors: gone vs invalid answer", async () => {
  const notFound = await client
    .replyPermission("ses_1", "per_x", { decision: "once" })
    .catch((e: unknown) => e);
  expect(notFound).toMatchObject({ status: 404, tag: "PermissionNotFound" });
  expect(isGone(notFound)).toBe(true);

  fake.state.forms["/w"] = [{ id: "frm_1", sessionID: "ses_1", title: "Q" }];
  fake.state.invalidAnswer = "db is required";
  const invalid = await client
    .replyForm("ses_1", "frm_1", {})
    .catch((e: unknown) => e);
  expect(invalid).toMatchObject({
    status: 400,
    tag: "FormInvalidAnswer",
    detail: "db is required",
  });
  expect(isInvalidAnswer(invalid)).toBe(true);
  expect(isGone(invalid)).toBe(false);

  fake.state.settledForms = ["frm_1"];
  const settled = await client
    .replyForm("ses_1", "frm_1", {})
    .catch((e: unknown) => e);
  expect(isGone(settled)).toBe(true);
  expect(isInvalidAnswer(settled)).toBe(false);
});

it("keeps the status when the error body is not JSON", async () => {
  fake.state.plainErrors = true;
  const err = await client
    .cancelForm("ses_1", "frm_missing")
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OpencodeHttpError);
  expect(err).toMatchObject({ status: 404, tag: undefined });
  expect(isGone(err)).toBe(true);
});
```

- [ ] **Step 3: Run the tests and check that they fail**

Run: `pnpm exec vitest run test/server/opencode-client.test.ts` Expected: FAIL, because `replyPermission` is not a function and `isGone` is not exported.

- [ ] **Step 4: Implement**

In `src/server/opencode/client.ts`:

Change the shared-types import to `import type { FormAnswer, FormField, PermissionDecision } from "../../shared/types";`.

Replace the `OpencodeHttpError` class with:

```ts
export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    /** opencode's error `_tag`, e.g. "FormNotFound", when the body was JSON. */
    readonly tag?: string,
    /** opencode's error message, when it sent one. */
    readonly detail?: string
  ) {
    super(
      `opencode ${path} responded ${status}${tag ? ` ${tag}` : ""}${detail ? `: ${detail}` : ""}`
    );
    this.name = "OpencodeHttpError";
  }
}

const GONE_TAGS = new Set([
  "PermissionNotFound",
  "FormNotFound",
  "FormAlreadySettled",
]);

/** opencode no longer has the item: it was answered or cancelled in another client. */
export function isGone(err: unknown): err is OpencodeHttpError {
  return (
    err instanceof OpencodeHttpError &&
    (err.status === 404 || (err.tag !== undefined && GONE_TAGS.has(err.tag)))
  );
}

/** opencode rejected a form answer; `detail` says why. */
export function isInvalidAnswer(err: unknown): err is OpencodeHttpError {
  return (
    err instanceof OpencodeHttpError &&
    !isGone(err) &&
    (err.tag === "FormInvalidAnswer" || err.status === 400)
  );
}
```

Add these methods to `OpencodeClient`, after `createSession`:

```ts
  private async send(method: "POST" | "DELETE", path: string, body?: unknown, directory?: string): Promise<void> {
    const headers: Record<string, string> = { authorization: basicAuth(this.ep.password), accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchImpl(this.ep.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      await res.text().catch(() => "");
      return;
    }
    const err = (await res.json().catch(() => ({}))) as { _tag?: unknown; message?: unknown };
    throw new OpencodeHttpError(
      res.status,
      path,
      typeof err._tag === "string" ? err._tag : undefined,
      typeof err.message === "string" ? err.message : undefined,
    );
  }

  /** Answers a permission request; `sessionId` is the session that asked (may be a subagent). */
  replyPermission(
    sessionId: string,
    requestId: string,
    reply: { decision: PermissionDecision; message?: string },
    directory?: string,
  ): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`;
    return this.send("POST", path, reply, directory);
  }

  replyForm(sessionId: string, formId: string, answer: FormAnswer, directory?: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`;
    return this.send("POST", path, { answer }, directory);
  }

  /** Cancels a form; opencode tells the asking agent `message`. */
  cancelForm(sessionId: string, formId: string, message?: string, directory?: string): Promise<void> {
    const query = message ? `?${new URLSearchParams({ message })}` : "";
    const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}${query}`;
    return this.send("DELETE", path, undefined, directory);
  }
```

- [ ] **Step 5: Run the tests and check that they pass**

Run: `pnpm exec vitest run test/server/opencode-client.test.ts test/server/monitor.test.ts && pnpm typecheck` Expected: PASS, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/opencode/client.ts test/helpers/fake-opencode.ts test/server/opencode-client.test.ts
git commit -m "feat: opencode client replies to permissions and forms"
```

---

### Task 4: Orchestrator answers pending items it has listed

**Files:**

- Modify: `src/server/state.ts` (add `sessionsOf`)
- Modify: `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**

- Consumes: `OpencodeClient.replyPermission/replyForm/cancelForm`, `isGone`, `isInvalidAnswer` (Task 3); `SessionSummary.pending` (Task 1).
- Produces:

  ```ts
  export class AlreadyAnsweredError extends Error {}           // message "already answered"
  export class NotFoundError { constructor(id: string, what = "project") }  // message `unknown ${what} ${id}`
  StateStore.sessionsOf(id: ProjectId): SessionSummary[]
  Orchestrator.replyPermission(id: ProjectId, requestId: string, reply: { decision: string; message?: string }): Promise<void>
  Orchestrator.replyForm(id: ProjectId, formId: string, answer: unknown): Promise<void>
  Orchestrator.cancelForm(id: ProjectId, formId: string, message?: string): Promise<void>
  ```

  Errors: `NotFoundError` (unknown project or item id), `InvalidRequestError` (bad decision or answer shape, or opencode's FormInvalidAnswer, carrying its message), `AlreadyAnsweredError`, `UnavailableError` (opencode not running).

- [ ] **Step 1: Write the failing tests**

In `test/server/orchestrator.test.ts`:

Change the orchestrator import to include `AlreadyAnsweredError`:

```ts
import {
  AlreadyAnsweredError,
  BusyError,
  type NetworkPort,
  NotFoundError,
  Orchestrator,
  UnavailableError,
} from "../../src/server/orchestrator";
```

and add `import { OpencodeHttpError } from "../../src/server/opencode/client";` and `import type { PendingItems, SessionSummary } from "../../src/shared/types";`.

In `setup`, change the `monitors` array type and the `monitorFactory` so that monitors count reconciles:

```ts
const monitors: Array<{
  opts: MonitorOptions;
  started: boolean;
  stopped: boolean;
  reconciled: number;
}> = [];
```

```ts
    monitorFactory: (opts) => {
      const m = {
        opts,
        started: false,
        stopped: false,
        reconciled: 0,
        start() { m.started = true; },
        stop() { m.stopped = true; },
        reconcile() { m.reconciled++; },
      };
      monitors.push(m);
      return m;
    },
```

Replace the `client` line in `setup` with:

```ts
const client = {
  createSession: vi.fn(async (directory: string) => ({
    id: "ses_new",
    location: { directory },
  })),
  replyPermission: vi.fn(
    async (_sid: string, _rid: string, _reply: unknown, _dir?: string) => {}
  ),
  replyForm: vi.fn(
    async (_sid: string, _fid: string, _answer: unknown, _dir?: string) => {}
  ),
  cancelForm: vi.fn(
    async (_sid: string, _fid: string, _message?: string, _dir?: string) => {}
  ),
};
```

Add a helper above `describe("Orchestrator", …)`:

```ts
function waiting(pending: PendingItems): SessionSummary {
  return {
    id: "ses_root",
    projectId: project.id,
    title: "Fix tests",
    directory: "/workspaces/demo.worktrees/x",
    updatedAt: 1,
    status: "needs-permission",
    pending,
  };
}
const permission = {
  id: "per_1",
  sessionId: "ses_child",
  action: "bash",
  resources: ["npm test"],
};
const form = {
  id: "frm_1",
  sessionId: "ses_root",
  title: "Which DB?",
  fields: [],
};
```

Append a new block at the end of `describe("Orchestrator", …)`:

```ts
describe("responding", () => {
  async function running() {
    const s = setup();
    await s.orch.rescan();
    await s.orch.start(project.id);
    s.store.setSessions(project.id, [
      waiting({ permissions: [permission], forms: [form] }),
    ]);
    return s;
  }

  it("replies as the asking subagent session, in the root session's directory, then reconciles", async () => {
    const { orch, client, monitors } = await running();
    await orch.replyPermission(project.id, "per_1", { decision: "always" });
    expect(client.replyPermission).toHaveBeenCalledWith(
      "ses_child",
      "per_1",
      { decision: "always" },
      "/workspaces/demo.worktrees/x"
    );
    expect(monitors.at(-1)!.reconciled).toBe(1);
  });

  it("passes a reject reason through", async () => {
    const { orch, client } = await running();
    await orch.replyPermission(project.id, "per_1", {
      decision: "reject",
      message: "use pnpm",
    });
    expect(client.replyPermission.mock.calls[0][2]).toEqual({
      decision: "reject",
      message: "use pnpm",
    });
  });

  it("answers and cancels forms", async () => {
    const { orch, client } = await running();
    await orch.replyForm(project.id, "frm_1", { db: "postgres" });
    expect(client.replyForm).toHaveBeenCalledWith(
      "ses_root",
      "frm_1",
      { db: "postgres" },
      "/workspaces/demo.worktrees/x"
    );
    await orch.cancelForm(project.id, "frm_1", "not needed");
    expect(client.cancelForm).toHaveBeenCalledWith(
      "ses_root",
      "frm_1",
      "not needed",
      "/workspaces/demo.worktrees/x"
    );
  });

  it("only forwards ids it listed itself", async () => {
    const { orch, client } = await running();
    await expect(
      orch.replyPermission(project.id, "per_other", { decision: "once" })
    ).rejects.toThrow(NotFoundError);
    await expect(orch.replyForm(project.id, "per_1", {})).rejects.toThrow(
      NotFoundError
    );
    await expect(
      orch.replyPermission("nope", "per_1", { decision: "once" })
    ).rejects.toThrow(NotFoundError);
    expect(client.replyPermission).not.toHaveBeenCalled();
    expect(client.replyForm).not.toHaveBeenCalled();
  });

  it("validates the decision and the answer", async () => {
    const { orch } = await running();
    await expect(
      orch.replyPermission(project.id, "per_1", { decision: "yes" })
    ).rejects.toThrow(InvalidRequestError);
    await expect(orch.replyForm(project.id, "frm_1", ["a"])).rejects.toThrow(
      InvalidRequestError
    );
    await expect(orch.replyForm(project.id, "frm_1", null)).rejects.toThrow(
      InvalidRequestError
    );
  });

  it("turns opencode's not-found and already-settled into AlreadyAnsweredError, and still reconciles", async () => {
    const { orch, client, monitors } = await running();
    client.replyPermission.mockRejectedValueOnce(
      new OpencodeHttpError(404, "/x")
    );
    await expect(
      orch.replyPermission(project.id, "per_1", { decision: "once" })
    ).rejects.toThrow(AlreadyAnsweredError);
    client.replyForm.mockRejectedValueOnce(
      new OpencodeHttpError(400, "/x", "FormAlreadySettled")
    );
    await expect(orch.replyForm(project.id, "frm_1", {})).rejects.toThrow(
      AlreadyAnsweredError
    );
    expect(monitors.at(-1)!.reconciled).toBe(2);
  });

  it("surfaces opencode's message for an invalid answer, and keeps other failures as they are", async () => {
    const { orch, client } = await running();
    client.replyForm.mockRejectedValueOnce(
      new OpencodeHttpError(400, "/x", "FormInvalidAnswer", "db is required")
    );
    await expect(orch.replyForm(project.id, "frm_1", {})).rejects.toThrow(
      expect.objectContaining({
        name: "InvalidRequestError",
        message: "db is required",
      })
    );
    client.replyForm.mockRejectedValueOnce(new OpencodeHttpError(500, "/x"));
    await expect(
      orch.replyForm(project.id, "frm_1", {})
    ).rejects.toBeInstanceOf(OpencodeHttpError);
  });

  it("needs opencode running", async () => {
    const { orch, store } = setup();
    await orch.rescan();
    store.setSessions(project.id, [
      waiting({ permissions: [permission], forms: [] }),
    ]);
    await expect(
      orch.replyPermission(project.id, "per_1", { decision: "once" })
    ).rejects.toThrow(UnavailableError);
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `pnpm exec vitest run test/server/orchestrator.test.ts -t responding` Expected: FAIL, because `AlreadyAnsweredError` is not exported and `orch.replyPermission` is not a function.

- [ ] **Step 3: Implement**

In `src/server/state.ts`, add this after `setSessions`:

```ts
  sessionsOf(id: ProjectId): SessionSummary[] {
    return this.sessions.get(id) ?? [];
  }
```

In `src/server/orchestrator.ts`:

Change the client import to

```ts
import {
  type OpencodeClient,
  type OpencodeEndpoint,
  isGone,
  isInvalidAnswer,
} from "./opencode/client";
```

and add `PendingItems` and `PermissionDecision` to the existing `../shared/types` import.

Replace `NotFoundError` and add `AlreadyAnsweredError` next to it:

```ts
export class NotFoundError extends Error {
  constructor(id: string, what = "project") {
    super(`unknown ${what} ${id}`);
    this.name = "NotFoundError";
  }
}

/** The permission request or form was already answered or cancelled, e.g. in the opencode tab. */
export class AlreadyAnsweredError extends Error {
  constructor() {
    super("already answered");
    this.name = "AlreadyAnsweredError";
  }
}

const DECISIONS: readonly string[] = [
  "once",
  "always",
  "reject",
] satisfies PermissionDecision[];
```

Replace the body of `startSession`, from `const rt = …` up to `const client = …`, so that it uses a shared helper:

```ts
  async startSession(id: ProjectId, directory: string, title?: string): Promise<string> {
    this.requireProject(id);
    this.checkDirectory(id, directory);
    const client = this.opencodeClient(id);
    const session = await client.createSession(directory, title);
    this.monitors.get(id)?.reconcile?.();
    return session.id;
  }

  /** Answers a permission request the dashboard listed for this project. */
  async replyPermission(id: ProjectId, requestId: string, reply: { decision: string; message?: string }): Promise<void> {
    if (!DECISIONS.includes(reply.decision)) throw new InvalidRequestError(`invalid decision "${reply.decision}"`);
    const decision = reply.decision as PermissionDecision;
    await this.respond(id, "permission request", requestId, (p) => p.permissions.find((i) => i.id === requestId), (client, item, dir) =>
      client.replyPermission(item.sessionId, requestId, { decision, ...(reply.message ? { message: reply.message } : {}) }, dir),
    );
  }

  /** Submits an answer to a form the dashboard listed for this project. */
  async replyForm(id: ProjectId, formId: string, answer: unknown): Promise<void> {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new InvalidRequestError("answer must be an object");
    await this.respond(id, "form", formId, (p) => p.forms.find((i) => i.id === formId), (client, item, dir) =>
      client.replyForm(item.sessionId, formId, answer as FormAnswer, dir),
    );
  }

  /** Dismisses a form; the agent is told `message`. */
  async cancelForm(id: ProjectId, formId: string, message?: string): Promise<void> {
    await this.respond(id, "form", formId, (p) => p.forms.find((i) => i.id === formId), (client, item, dir) =>
      client.cancelForm(item.sessionId, formId, message, dir),
    );
  }
```

Add `FormAnswer` to the `../shared/types` import as well. Then add the private helpers next to `startMonitor`:

```ts
  private opencodeClient(id: ProjectId): OpencodeClient {
    const rt = this.deps.store.runtime(id);
    const route = this.routes.get(id);
    if (rt.containerState !== "running" || rt.opencode !== "healthy" || !route || !rt.password) {
      throw new UnavailableError("opencode is not running — start the project first");
    }
    return this.deps.clientFor(this.deps.runtime.endpoint(route.opencode, rt.password));
  }

  /**
   * Forwards a reply for a pending item, but only for ids in the latest snapshot: the dashboard never relays
   * ids it didn't list itself. Refreshes the snapshot afterwards, whatever happened.
   */
  private async respond<T extends { sessionId: string }>(
    id: ProjectId,
    what: string,
    itemId: string,
    find: (pending: PendingItems) => T | undefined,
    send: (client: OpencodeClient, item: T, directory: string) => Promise<void>,
  ): Promise<void> {
    this.requireProject(id);
    let found: { item: T; directory: string } | undefined;
    for (const s of this.deps.store.sessionsOf(id)) {
      const item = s.pending && find(s.pending);
      if (item) {
        found = { item, directory: s.directory };
        break;
      }
    }
    if (!found) throw new NotFoundError(itemId, what);
    const client = this.opencodeClient(id);
    try {
      await send(client, found.item, found.directory);
    } catch (err) {
      if (isGone(err)) throw new AlreadyAnsweredError();
      if (isInvalidAnswer(err)) throw new InvalidRequestError(err.detail ?? "opencode rejected the answer");
      throw err;
    } finally {
      this.monitors.get(id)?.reconcile?.();
    }
  }
```

`requireProject` throws `NotFoundError(id)`. Its message stays "unknown project …" through the default argument.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm exec vitest run test/server/orchestrator.test.ts test/server/state.test.ts && pnpm typecheck` Expected: PASS, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.ts src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "feat: orchestrator answers permission requests and forms it listed"
```

---

### Task 5: Dashboard API routes

**Files:**

- Modify: `src/server/dashboard-api.ts`
- Test: `test/server/dashboard-api.test.ts`

**Interfaces:**

- Consumes: `Orchestrator.replyPermission/replyForm/cancelForm`, `AlreadyAnsweredError` (Task 4).
- Produces the HTTP API that Task 7 calls:
  - `POST /api/projects/:id/permissions/:rid` with `{ decision, message? }` → 200 `{ ok: true }`
  - `POST /api/projects/:id/forms/:fid` with `{ answer }` → 200 `{ ok: true }`
  - `DELETE /api/projects/:id/forms/:fid` with `{ message? }` → 200 `{ ok: true }`
  - Errors return `{ error }` with status 404 (unknown), 409 (`already answered`), 400 (invalid) or 412 (not running).

- [ ] **Step 1: Write the failing tests**

In `test/server/dashboard-api.test.ts`:

Change the import to `import { AlreadyAnsweredError, BusyError, NotFoundError, UnavailableError } from "../../src/server/orchestrator";`.

Add these to the `orchestrator` mock in `setup`:

```ts
    replyPermission: vi.fn(async (_id: string, _rid: string, _reply: { decision: string; message?: string }) => {}),
    replyForm: vi.fn(async (_id: string, _fid: string, _answer: unknown) => {}),
    cancelForm: vi.fn(async (_id: string, _fid: string, _message?: string) => {}),
```

Append inside `describe("dashboard API", …)`:

```ts
describe("responding", () => {
  const send = (
    app: ReturnType<typeof setup>["app"],
    method: string,
    route: string,
    body: unknown,
    origin?: string
  ) =>
    app.request(`/api/projects/${project.id}/${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        host: "localhost:7777",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });

  it("forwards permission replies, form answers and dismissals", async () => {
    const { app, orchestrator } = setup();
    expect(
      (
        await send(app, "POST", "permissions/per_1", {
          decision: "reject",
          message: "no",
        })
      ).status
    ).toBe(200);
    expect(orchestrator.replyPermission).toHaveBeenCalledWith(
      project.id,
      "per_1",
      { decision: "reject", message: "no" }
    );
    expect(
      (await send(app, "POST", "forms/frm_1", { answer: { db: "pg" } })).status
    ).toBe(200);
    expect(orchestrator.replyForm).toHaveBeenCalledWith(project.id, "frm_1", {
      db: "pg",
    });
    expect(
      (await send(app, "DELETE", "forms/frm_1", { message: "later" })).status
    ).toBe(200);
    expect(orchestrator.cancelForm).toHaveBeenCalledWith(
      project.id,
      "frm_1",
      "later"
    );
  });

  it("maps unknown ids to 404, already answered to 409 and invalid answers to 400 with the message", async () => {
    const { app, orchestrator } = setup();
    orchestrator.replyPermission.mockRejectedValueOnce(
      new NotFoundError("per_x", "permission request")
    );
    expect(
      (await send(app, "POST", "permissions/per_x", { decision: "once" }))
        .status
    ).toBe(404);

    orchestrator.replyPermission.mockRejectedValueOnce(
      new AlreadyAnsweredError()
    );
    const gone = await send(app, "POST", "permissions/per_1", {
      decision: "once",
    });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: "already answered" });

    orchestrator.replyForm.mockRejectedValueOnce(
      new InvalidRequestError("db is required")
    );
    const invalid = await send(app, "POST", "forms/frm_1", { answer: {} });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "db is required" });
  });

  it("blocks cross-site replies", async () => {
    const { app, orchestrator } = setup();
    const res = await send(
      app,
      "POST",
      "permissions/per_1",
      { decision: "once" },
      "http://evil.example"
    );
    expect(res.status).toBe(403);
    expect(orchestrator.replyPermission).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `pnpm exec vitest run test/server/dashboard-api.test.ts` Expected: FAIL. The new routes answer 503 or 404, and `satisfies DashboardOrchestrator` may complain about the extra keys until the Pick is extended.

- [ ] **Step 3: Implement**

In `src/server/dashboard-api.ts`:

Change the orchestrator import to

```ts
import {
  AlreadyAnsweredError,
  BusyError,
  NotFoundError,
  type Orchestrator,
  UnavailableError,
} from "./orchestrator";
```

Add `| "replyPermission" | "replyForm" | "cancelForm"` to the `DashboardOrchestrator` Pick.

In `errorStatus`, change the 409 line to:

```ts
if (err instanceof BusyError || err instanceof AlreadyAnsweredError) return 409;
```

After the `/api/projects/:id/open` route, add:

```ts
// Answers to what an agent is waiting on. The orchestrator only forwards ids it listed itself.
app.post("/api/projects/:id/permissions/:rid", (c) =>
  json(c, (id, b) =>
    orchestrator.replyPermission(id, c.req.param("rid") ?? "", {
      decision: str(b.decision) ?? "",
      ...(str(b.message) ? { message: str(b.message) } : {}),
    })
  )
);
app.post("/api/projects/:id/forms/:fid", (c) =>
  json(c, (id, b) =>
    orchestrator.replyForm(id, c.req.param("fid") ?? "", b.answer)
  )
);
app.delete("/api/projects/:id/forms/:fid", (c) =>
  json(c, (id, b) =>
    orchestrator.cancelForm(id, c.req.param("fid") ?? "", str(b.message))
  )
);
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm exec vitest run test/server && pnpm typecheck` Expected: all server tests pass and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/dashboard-api.ts test/server/dashboard-api.test.ts
git commit -m "feat: dashboard routes to answer permissions and forms"
```

---

### Task 6: Form logic for the browser

**Files:**

- Create: `src/web/forms.ts`
- Test: `test/web/forms.test.ts`

**Interfaces:**

- Consumes: `FormField`, `FormAnswer` (Task 1).
- Produces (used by Task 8):
  ```ts
  export type FieldValue = string | boolean | string[];
  export type FormValues = Record<string, FieldValue>;
  export interface FieldOption {
    value: string;
    label: string;
  }
  export function formSupported(fields: FormField[]): boolean;
  export function fieldLabel(field: FormField): string;
  export function optionsOf(field: FormField): FieldOption[];
  export function initialValues(fields: FormField[]): FormValues;
  export function isVisible(field: FormField, values: FormValues): boolean;
  export function buildAnswer(
    fields: FormField[],
    values: FormValues,
    custom?: Record<string, string>
  ):
    | { ok: true; answer: FormAnswer }
    | { ok: false; errors: Record<string, string> };
  export function safeUrl(url: string | undefined): string | undefined;
  export function inputType(
    format: string | undefined
  ): "text" | "email" | "url" | "date";
  ```
- Value conventions: `string` fields (including options and `custom`) and `number`/`integer` fields hold strings. `boolean` fields hold booleans. `multiselect` fields hold the picked option values as `string[]`, and their free-text "custom" entries live separately in `custom[key]`, comma-separated.

- [ ] **Step 1: Write the failing tests**

Create `test/web/forms.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { FormField } from "../../src/shared/types";
import {
  buildAnswer,
  fieldLabel,
  formSupported,
  initialValues,
  inputType,
  isVisible,
  optionsOf,
  safeUrl,
} from "../../src/web/forms";

const f = (
  key: string,
  type: string,
  over: Partial<FormField> = {}
): FormField => ({ key, type, ...over });

describe("form fields", () => {
  it("knows which field types it can render", () => {
    expect(
      formSupported([
        f("a", "string"),
        f("b", "number"),
        f("c", "integer"),
        f("d", "boolean"),
        f("e", "multiselect"),
        f("g", "external"),
      ])
    ).toBe(true);
    expect(formSupported([f("a", "string"), f("b", "file")])).toBe(false);
  });

  it("labels with the title, falling back to the key", () => {
    expect(fieldLabel(f("db", "string", { title: "Database" }))).toBe(
      "Database"
    );
    expect(fieldLabel(f("db", "string", { title: "  " }))).toBe("db");
  });

  it("accepts string and object options", () => {
    expect(
      optionsOf(
        f("x", "string", {
          options: ["a", { value: "b", label: "Bee" }, { value: "c" }],
        })
      )
    ).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "Bee" },
      { value: "c", label: "c" },
    ]);
  });

  it("starts from defaults", () => {
    expect(
      initialValues([
        f("s", "string", { default: "x" }),
        f("n", "number", { default: 3 }),
        f("b", "boolean", { default: true }),
        f("m", "multiselect", { default: ["a"] }),
        f("e", "external"),
        f("t", "string"),
      ])
    ).toEqual({ s: "x", n: "3", b: true, m: ["a"], t: "" });
  });
});

describe("isVisible", () => {
  const dependent = f("detail", "string", {
    when: [{ key: "kind", op: "eq", value: "other" }],
  });

  it("honours hidden and when eq/neq", () => {
    expect(isVisible(f("x", "string", { hidden: true }), {})).toBe(false);
    expect(isVisible(dependent, { kind: "other" })).toBe(true);
    expect(isVisible(dependent, { kind: "a" })).toBe(false);
    expect(
      isVisible(
        f("y", "string", { when: [{ key: "kind", op: "neq", value: "a" }] }),
        { kind: "b" }
      )
    ).toBe(true);
  });

  it("treats an untouched field as not equal, and compares typed numbers and booleans by value", () => {
    expect(isVisible(dependent, {})).toBe(false);
    expect(
      isVisible(
        f("y", "string", { when: [{ key: "kind", op: "neq", value: "a" }] }),
        {}
      )
    ).toBe(true);
    expect(
      isVisible(
        f("z", "string", { when: [{ key: "n", op: "eq", value: 3 }] }),
        { n: "3" }
      )
    ).toBe(true);
    expect(
      isVisible(
        f("z", "string", { when: [{ key: "ok", op: "eq", value: true }] }),
        { ok: true }
      )
    ).toBe(true);
    expect(
      isVisible(
        f("z", "string", { when: [{ key: "tags", op: "eq", value: "x" }] }),
        { tags: ["x", "y"] }
      )
    ).toBe(true);
  });
});

describe("buildAnswer", () => {
  it("converts values to opencode's answer types", () => {
    const fields = [
      f("s", "string"),
      f("n", "number"),
      f("i", "integer"),
      f("b", "boolean"),
      f("m", "multiselect", { custom: true }),
      f("e", "external", { url: "https://x" }),
    ];
    expect(
      buildAnswer(
        fields,
        { s: "hi", n: "2.5", i: "4", b: false, m: ["a"] },
        { m: " c, d ,," }
      )
    ).toEqual({
      ok: true,
      answer: { s: "hi", n: 2.5, i: 4, b: false, m: ["a", "c", "d"] },
    });
  });

  it("omits empty optional fields and fields hidden by when, and sends hidden defaults", () => {
    const fields = [
      f("opt", "string"),
      f("kind", "string"),
      f("detail", "string", {
        required: true,
        when: [{ key: "kind", op: "eq", value: "other" }],
      }),
      f("secret", "string", { hidden: true, default: "token" }),
    ];
    expect(buildAnswer(fields, { opt: "  ", kind: "a", detail: "" })).toEqual({
      ok: true,
      answer: { kind: "a", secret: "token" },
    });
  });

  it("reports per-field errors", () => {
    const fields = [
      f("s", "string", { required: true }),
      f("i", "integer"),
      f("n", "number", { minimum: 1, maximum: 5 }),
      f("m", "multiselect", { maxItems: 1 }),
      f("p", "string", { pattern: "[a-z]+" }),
      f("l", "string", { minLength: 3 }),
    ];
    const result = buildAnswer(fields, {
      s: "",
      i: "1.5",
      n: "9",
      m: ["a", "b"],
      p: "abc1",
      l: "ab",
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        s: "Required",
        i: "Enter a whole number",
        n: "At most 5",
        m: "Pick at most 1",
        p: "Doesn't match the expected format",
        l: "At least 3 characters",
      },
    });
  });

  it("ignores a pattern that is not a valid regular expression", () => {
    expect(
      buildAnswer([f("p", "string", { pattern: "([" })], { p: "anything" })
    ).toEqual({ ok: true, answer: { p: "anything" } });
  });

  it("requires at least one pick for a required multiselect", () => {
    expect(
      buildAnswer([f("m", "multiselect", { required: true })], { m: [] })
    ).toEqual({ ok: false, errors: { m: "Pick at least one" } });
  });
});

describe("safeUrl", () => {
  it("only lets http(s) links through", () => {
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,<b>x</b>")).toBeUndefined();
    expect(safeUrl("not a url")).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });
});

describe("inputType", () => {
  it("maps formats the browser can validate", () => {
    expect(inputType("email")).toBe("email");
    expect(inputType("uri")).toBe("url");
    expect(inputType("date")).toBe("date");
    expect(inputType("date-time")).toBe("text");
    expect(inputType(undefined)).toBe("text");
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `pnpm exec vitest run test/web/forms.test.ts` Expected: FAIL, because `src/web/forms` can't be resolved.

- [ ] **Step 3: Implement**

Create `src/web/forms.ts`:

```ts
import type { FormAnswer, FormField } from "../shared/types";

export type FieldValue = string | boolean | string[];
export type FormValues = Record<string, FieldValue>;
export interface FieldOption {
  value: string;
  label: string;
}

const SUPPORTED = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "multiselect",
  "external",
]);

/** False when a field type is new to us; the UI then links to opencode instead of guessing. */
export function formSupported(fields: FormField[]): boolean {
  return fields.every((f) => SUPPORTED.has(f.type));
}

export function fieldLabel(field: FormField): string {
  return field.title?.trim() || field.key;
}

export function optionsOf(field: FormField): FieldOption[] {
  return (field.options ?? []).map((o) =>
    typeof o === "string"
      ? { value: o, label: o }
      : { value: String(o.value), label: o.label ?? String(o.value) }
  );
}

export function initialValues(fields: FormField[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    if (f.type === "external") continue;
    if (f.type === "boolean") values[f.key] = f.default === true;
    else if (f.type === "multiselect")
      values[f.key] = Array.isArray(f.default) ? f.default.map(String) : [];
    else
      values[f.key] =
        f.default === undefined || f.default === null ? "" : String(f.default);
  }
  return values;
}

function equals(actual: FieldValue | undefined, expected: unknown): boolean {
  if (actual === undefined) return false;
  if (Array.isArray(actual)) return actual.includes(String(expected));
  return String(actual) === String(expected);
}

/** `hidden` and `when` decide visibility; inputs hold strings, so typed conditions compare by value. */
export function isVisible(field: FormField, values: FormValues): boolean {
  if (field.hidden) return false;
  return (field.when ?? []).every((c) =>
    c.op === "neq"
      ? !equals(values[c.key], c.value)
      : equals(values[c.key], c.value)
  );
}

function matchesPattern(value: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, "u").test(value);
  } catch {
    return true; // an invalid pattern from the agent must not block the answer
  }
}

function isAnswerValue(v: unknown): v is FormAnswer[string] {
  return (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    (Array.isArray(v) && v.every((x) => typeof x === "string"))
  );
}

export type BuildResult =
  | { ok: true; answer: FormAnswer }
  | { ok: false; errors: Record<string, string> };

/** Turns the form's values into opencode's answer, or per-field errors. Fields hidden by `when` are left out. */
export function buildAnswer(
  fields: FormField[],
  values: FormValues,
  custom: Record<string, string> = {}
): BuildResult {
  const answer: FormAnswer = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === "external") continue;
    if (f.hidden) {
      if (isAnswerValue(f.default)) answer[f.key] = f.default;
      continue;
    }
    if (!isVisible(f, values)) continue;
    const v = values[f.key];
    switch (f.type) {
      case "boolean":
        answer[f.key] = v === true;
        break;
      case "number":
      case "integer": {
        const text = typeof v === "string" ? v.trim() : "";
        if (!text) {
          if (f.required) errors[f.key] = "Required";
          break;
        }
        const n = Number(text);
        if (
          !Number.isFinite(n) ||
          (f.type === "integer" && !Number.isInteger(n))
        ) {
          errors[f.key] =
            f.type === "integer" ? "Enter a whole number" : "Enter a number";
        } else if (f.minimum !== undefined && n < f.minimum)
          errors[f.key] = `At least ${f.minimum}`;
        else if (f.maximum !== undefined && n > f.maximum)
          errors[f.key] = `At most ${f.maximum}`;
        else answer[f.key] = n;
        break;
      }
      case "multiselect": {
        const extra = f.custom
          ? (custom[f.key] ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const items = [...new Set([...(Array.isArray(v) ? v : []), ...extra])];
        if (f.required && items.length === 0)
          errors[f.key] = "Pick at least one";
        else if (f.minItems !== undefined && items.length < f.minItems)
          errors[f.key] = `Pick at least ${f.minItems}`;
        else if (f.maxItems !== undefined && items.length > f.maxItems)
          errors[f.key] = `Pick at most ${f.maxItems}`;
        else answer[f.key] = items;
        break;
      }
      default: {
        const text = typeof v === "string" ? v : "";
        if (!text.trim()) {
          if (f.required) errors[f.key] = "Required";
          break;
        }
        if (f.minLength !== undefined && text.length < f.minLength)
          errors[f.key] = `At least ${f.minLength} characters`;
        else if (f.maxLength !== undefined && text.length > f.maxLength)
          errors[f.key] = `At most ${f.maxLength} characters`;
        else if (f.pattern && !matchesPattern(text, f.pattern))
          errors[f.key] = "Doesn't match the expected format";
        else answer[f.key] = text;
      }
    }
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, answer };
}

/** Agent-supplied links are only followed when they are plain http(s). */
export function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function inputType(
  format: string | undefined
): "text" | "email" | "url" | "date" {
  if (format === "email") return "email";
  if (format === "uri" || format === "url") return "url";
  if (format === "date") return "date";
  return "text";
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm exec vitest run test/web/forms.test.ts && pnpm typecheck` Expected: PASS, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/forms.ts test/web/forms.test.ts
git commit -m "feat: form visibility and answer building for inline responses"
```

---

### Task 7: Web API calls and notifications that say what is asked

**Files:**

- Modify: `src/web/api.ts`
- Modify: `src/web/derive.ts`
- Test: `test/web/api.test.ts` (create)
- Test: `test/web/derive.test.ts`

**Interfaces:**

- Consumes: the routes from Task 5; `SessionSummary.pending` (Task 1).
- Produces (used by Task 8):

  ```ts
  export type ReplyOutcome = "done" | "gone"; // "gone": answered elsewhere (409), drop the card silently
  export function replyPermission(
    projectId: string,
    requestId: string,
    decision: PermissionDecision,
    message?: string
  ): Promise<ReplyOutcome>;
  export function replyForm(
    projectId: string,
    formId: string,
    answer: FormAnswer
  ): Promise<ReplyOutcome>;
  export function dismissForm(
    projectId: string,
    formId: string,
    message?: string
  ): Promise<ReplyOutcome>;
  export function pendingSummary(session: SessionSummary): string | undefined; // "wants bash: npm test" | "asks: Which DB?"
  ```

  The functions throw `Error(serverMessage)` for any other failure.

- [ ] **Step 1: Write the failing tests**

Create `test/web/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissForm, replyForm, replyPermission } from "../../src/web/api";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("reply API", () => {
  it("posts a permission decision", async () => {
    const fetchMock = stubFetch(200, { ok: true });
    expect(await replyPermission("demo-1", "per/1", "reject", "no")).toBe(
      "done"
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/demo-1/permissions/per%2F1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      decision: "reject",
      message: "no",
    });
  });

  it("answers and dismisses forms", async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await replyForm("p", "frm_1", { db: "pg" });
    await dismissForm("p", "frm_1", "later");
    expect(
      fetchMock.mock.calls.map(([u, i]) => [
        u,
        i?.method,
        JSON.parse(String(i?.body)),
      ])
    ).toEqual([
      ["/api/projects/p/forms/frm_1", "POST", { answer: { db: "pg" } }],
      ["/api/projects/p/forms/frm_1", "DELETE", { message: "later" }],
    ]);
  });

  it("reports an item answered elsewhere as gone, not as an error", async () => {
    stubFetch(409, { error: "already answered" });
    expect(await replyPermission("p", "per_1", "once")).toBe("gone");
  });

  it("throws the server's message for other failures", async () => {
    stubFetch(400, { error: "db is required" });
    await expect(replyForm("p", "frm_1", {})).rejects.toThrow("db is required");
  });
});
```

In `test/web/derive.test.ts`, add `pendingSummary` to the import from `../../src/web/derive`, then append:

```ts
describe("pendingSummary and notifications", () => {
  it("says what is being asked", () => {
    const base = snap({ a: "needs-permission" }).projects[0].sessions[0];
    expect(pendingSummary(base)).toBeUndefined();
    expect(
      pendingSummary({
        ...base,
        pending: {
          permissions: [
            {
              id: "p",
              sessionId: "a",
              action: "bash",
              resources: ["npm test", "npm run lint"],
            },
          ],
          forms: [],
        },
      })
    ).toBe("wants bash: npm test (+1 more)");
    expect(
      pendingSummary({
        ...base,
        pending: {
          permissions: [],
          forms: [{ id: "f", sessionId: "a", title: "Which DB?", fields: [] }],
        },
      })
    ).toBe("asks: Which DB?");
  });

  it("puts the ask in the notification title when it is known", () => {
    const next = snap({ a: "needs-permission" });
    next.projects[0].sessions[0].pending = {
      permissions: [
        { id: "p", sessionId: "a", action: "bash", resources: ["npm test"] },
      ],
      forms: [],
    };
    const [notice] = diffForNotifications(snap({ a: "running" }), next);
    expect(notice).toMatchObject({
      title: "demo · wants bash: npm test",
      body: "T a",
    });
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `pnpm exec vitest run test/web/api.test.ts test/web/derive.test.ts` Expected: FAIL, because `replyPermission` and `pendingSummary` are not exported.

- [ ] **Step 3: Implement**

In `src/web/api.ts`, change the first import to

```ts
import type {
  DashboardSnapshot,
  FormAnswer,
  LogEvent,
  PermissionDecision,
  Worktree,
} from "../shared/types";
```

and add after `openInEditor`:

```ts
/** "gone": the item was already answered elsewhere (e.g. in the opencode tab); drop it without an error. */
export type ReplyOutcome = "done" | "gone";

async function reply(
  projectId: string,
  route: string,
  method: "POST" | "DELETE",
  body: unknown,
  what: string
): Promise<ReplyOutcome> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${route}`,
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 409) return "gone";
  if (!res.ok) throw await failure(res, what);
  return "done";
}

export function replyPermission(
  projectId: string,
  requestId: string,
  decision: PermissionDecision,
  message?: string
): Promise<ReplyOutcome> {
  return reply(
    projectId,
    `permissions/${encodeURIComponent(requestId)}`,
    "POST",
    { decision, message },
    "reply"
  );
}

export function replyForm(
  projectId: string,
  formId: string,
  answer: FormAnswer
): Promise<ReplyOutcome> {
  return reply(
    projectId,
    `forms/${encodeURIComponent(formId)}`,
    "POST",
    { answer },
    "answer"
  );
}

export function dismissForm(
  projectId: string,
  formId: string,
  message?: string
): Promise<ReplyOutcome> {
  return reply(
    projectId,
    `forms/${encodeURIComponent(formId)}`,
    "DELETE",
    { message },
    "dismiss"
  );
}
```

In `src/web/derive.ts`, add above `diffForNotifications`:

```ts
/** What a session is waiting on, as plain text: "wants bash: npm test" or "asks: Which DB?". */
export function pendingSummary(session: SessionSummary): string | undefined {
  const p = session.pending?.permissions[0];
  if (p) {
    const first = p.resources[0] ? `: ${p.resources[0]}` : "";
    const more =
      p.resources.length > 1 ? ` (+${p.resources.length - 1} more)` : "";
    return `wants ${p.action}${first}${more}`;
  }
  const f = session.pending?.forms[0];
  return f ? `asks: ${f.title}` : undefined;
}
```

In `diffForNotifications`, replace the `notices.push({ … title: … })` call with:

```ts
const ask = MESSAGES[s.status] ? pendingSummary(s) : undefined;
notices.push({
  key: `${s.id}:${s.status}`,
  title: ask
    ? `${view.project.name} · ${ask}`
    : `${view.project.name}: ${what}`,
  body: s.title,
  projectId: view.project.id,
  sessionId: s.id,
});
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm exec vitest run test/web && pnpm typecheck` Expected: all web tests pass (the existing notification tests keep their `"demo: permission needed"` titles), and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/derive.ts test/web/api.test.ts test/web/derive.test.ts
git commit -m "feat: web calls for inline replies; notifications say what is asked"
```

---

### Task 8: Permission and form cards in the session lists

**Files:**

- Create: `src/web/components/PendingCards.tsx`
- Modify: `src/web/components/SessionList.tsx`
- Modify: `src/web/pages/ProjectPage.tsx:105-107`
- Modify: `src/web/styles.css` (append)

**Interfaces:**

- Consumes: `replyPermission`, `replyForm`, `dismissForm`, `ReplyOutcome` (Task 7); everything from `src/web/forms.ts` (Task 6); `PendingItems` types (Task 1); `sessionUrl` from `src/shared/urls.ts`; `Icon` with the name `"external"`.
- Produces: `PendingStack({ session, view })`. `SessionList` renders it in an `<li className="pending-item" id="pending-<sessionId>">` directly after the row of any session that has `pending`, on the Overview, the project Sessions tab and `/sessions` alike. Each card is focusable and has the class `pending-card`.
- Behaviour from the spec:
  - Only the oldest item in a stack is shown, with "1 of n waiting" above it. Answering it reveals the next one.
  - Keys apply only while the card itself has focus, never while typing in its inputs: `Enter` allows once, `a` always allows, `r` rejects, and `j`/`k` move between cards.
  - A `"gone"` outcome drops the card silently. Other errors show under the card.
  - The always-allow tooltip lists the `save` patterns.
  - The resources list shows the first 5, then "+n more".
  - Fields are re-filtered with `isVisible` on every change.
  - An unsupported field type shows the fields read-only, plus a link to "Answer in opencode".

This task has no unit tests: vitest runs in node without a DOM, and every piece of logic here is already tested in Tasks 6 and 7. The checks are the typecheck, the build and the manual run in Step 6.

- [ ] **Step 1: Create the cards component**

Create `src/web/components/PendingCards.tsx`:

```tsx
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";

import type {
  FormField,
  PendingForm,
  PendingPermission,
  PermissionDecision,
  ProjectView,
  SessionSummary,
} from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import {
  dismissForm,
  type ReplyOutcome,
  replyForm,
  replyPermission,
} from "../api";
import {
  buildAnswer,
  type FieldValue,
  fieldLabel,
  type FormValues,
  formSupported,
  initialValues,
  inputType,
  isVisible,
  optionsOf,
  safeUrl,
} from "../forms";
import { Icon } from "./Icon";

const RESOURCE_LIMIT = 5;
const RADIO_LIMIT = 5;

type Item =
  | { kind: "permission"; item: PendingPermission }
  | { kind: "form"; item: PendingForm };

/** Keys belong to the card only while the card itself has focus, never while typing in one of its fields. */
function ownKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.target === e.currentTarget && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** j/k move between cards on the page. */
function moveBetweenCards(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "j" && e.key !== "k") return;
  e.preventDefault();
  const cards = [...document.querySelectorAll<HTMLElement>(".pending-card")];
  cards[cards.indexOf(e.currentTarget) + (e.key === "j" ? 1 : -1)]?.focus();
}

/** Focuses the card when it mounts, so answering one card by keyboard lands on the next. */
function useAutoFocus(enabled: boolean) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (enabled && el) el.focus();
    },
    [enabled]
  );
}

function useReply(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = (send: () => Promise<ReplyOutcome>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    send().then(onDone, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };
  return { busy, error, run };
}

/** What one session waits on, oldest first. Only the oldest is shown; answering it reveals the next. */
export function PendingStack(props: {
  session: SessionSummary;
  view: ProjectView;
}) {
  const { session, view } = props;
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [focusNext, setFocusNext] = useState(false);
  const stack = useRef<HTMLDivElement>(null);
  const items: Item[] = [
    ...(session.pending?.permissions ?? []).map((item) => ({
      kind: "permission" as const,
      item,
    })),
    ...(session.pending?.forms ?? []).map((item) => ({
      kind: "form" as const,
      item,
    })),
  ]
    .filter((i) => !answered.has(i.item.id))
    .sort((a, b) => (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0));
  if (items.length === 0) return null;

  const current = items[0];
  const done = () => {
    setFocusNext(stack.current?.contains(document.activeElement) ?? false);
    setAnswered((prev) => new Set(prev).add(current.item.id));
  };
  return (
    <div className="pending-stack" ref={stack}>
      {items.length > 1 && (
        <p className="pending-count muted">1 of {items.length} waiting</p>
      )}
      {current.kind === "permission" ? (
        <PermissionCard
          key={current.item.id}
          projectId={view.project.id}
          sessionTitle={session.title}
          permission={current.item}
          autoFocus={focusNext}
          onDone={done}
        />
      ) : (
        <FormCard
          key={current.item.id}
          projectId={view.project.id}
          form={current.item}
          openUrl={sessionUrl(view.openUrl, session.id)}
          autoFocus={focusNext}
          onDone={done}
        />
      )}
    </div>
  );
}

function PermissionCard(props: {
  projectId: string;
  sessionTitle: string;
  permission: PendingPermission;
  autoFocus: boolean;
  onDone: () => void;
}) {
  const { permission: p } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const ref = useAutoFocus(props.autoFocus);
  const reply = (decision: PermissionDecision, message?: string) =>
    run(() => replyPermission(props.projectId, p.id, decision, message));

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!ownKey(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      reply("once");
    } else if (e.key === "a") {
      e.preventDefault();
      reply("always");
    } else if (e.key === "r") {
      e.preventDefault();
      setRejecting(true);
    } else moveBetweenCards(e);
  };

  const shown = p.resources.slice(0, RESOURCE_LIMIT);
  return (
    <section
      ref={ref}
      className="pending-card"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`${props.sessionTitle} wants ${p.action}`}
    >
      <p className="pending-ask">
        <span className="pending-who">{props.sessionTitle}</span> wants{" "}
        <strong>{p.action}</strong>
      </p>
      {shown.length > 0 && (
        <ul className="pending-resources">
          {shown.map((r, i) => (
            <li key={i}>
              <code>{r}</code>
            </li>
          ))}
          {p.resources.length > RESOURCE_LIMIT && (
            <li className="muted">
              +{p.resources.length - RESOURCE_LIMIT} more
            </li>
          )}
        </ul>
      )}
      {p.message && <p className="pending-message">{p.message}</p>}
      {p.diff && <DiffView patch={p.diff} />}
      {rejecting ? (
        <form
          className="pending-actions"
          onSubmit={(e) => {
            e.preventDefault();
            reply("reject", reason.trim() || undefined);
          }}
        >
          <input
            autoFocus
            className="pending-reason"
            placeholder="Reason for the agent (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRejecting(false);
            }}
          />
          <button type="submit" disabled={busy}>
            Reject
          </button>
          <button
            type="button"
            className="link"
            onClick={() => setRejecting(false)}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="pending-actions">
          <button
            className="button primary"
            disabled={busy}
            onClick={() => reply("once")}
          >
            Allow once <kbd>↵</kbd>
          </button>
          <button
            disabled={busy}
            title={
              p.save?.length
                ? `Saves a rule for: ${p.save.join(", ")}`
                : "Allow this and future requests like it"
            }
            onClick={() => reply("always")}
          >
            Always allow <kbd>a</kbd>
          </button>
          <button disabled={busy} onClick={() => setRejecting(true)}>
            Reject… <kbd>r</kbd>
          </button>
        </div>
      )}
      {error && (
        <p className="pending-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function DiffView({ patch }: { patch: string }) {
  const kind = (line: string) =>
    line.startsWith("+++") || line.startsWith("---")
      ? "file"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : line.startsWith("@@")
            ? "hunk"
            : undefined;
  return (
    <pre className="pending-diff">
      {patch.split("\n").map((line, i) => (
        <span key={i} className={kind(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function FormCard(props: {
  projectId: string;
  form: PendingForm;
  openUrl: string;
  autoFocus: boolean;
  onDone: () => void;
}) {
  const { form } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(form.fields)
  );
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const ref = useAutoFocus(props.autoFocus);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (ownKey(e)) moveBetweenCards(e);
  };

  if (!formSupported(form.fields)) {
    return (
      <section
        ref={ref}
        className="pending-card"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={form.title}
      >
        <p className="pending-ask">{form.title}</p>
        <dl className="pending-readonly">
          {form.fields.map((f) => (
            <Fragment key={f.key}>
              <dt>{fieldLabel(f)}</dt>
              <dd className="muted">{f.type}</dd>
            </Fragment>
          ))}
        </dl>
        <div className="pending-actions">
          <a
            className="button primary"
            href={props.openUrl}
            target="_blank"
            rel="noreferrer"
          >
            Answer in opencode <Icon name="external" size={13} />
          </a>
        </div>
      </section>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = buildAnswer(form.fields, values, custom);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    run(() => replyForm(props.projectId, form.id, built.answer));
  };
  const dismiss = () =>
    run(() =>
      dismissForm(props.projectId, form.id, reason.trim() || undefined)
    );

  return (
    <form
      ref={ref}
      className="pending-card"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onSubmit={submit}
      aria-label={form.title}
    >
      <p className="pending-ask">{form.title}</p>
      {form.fields
        .filter((f) => isVisible(f, values))
        .map((f) => (
          <FieldControl
            key={f.key}
            name={`${form.id}-${f.key}`}
            field={f}
            value={values[f.key]}
            custom={custom[f.key] ?? ""}
            error={errors[f.key]}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
            onCustom={(t) => setCustom((prev) => ({ ...prev, [f.key]: t }))}
          />
        ))}
      {dismissing ? (
        <div className="pending-actions">
          <input
            autoFocus
            className="pending-reason"
            placeholder="Why (optional, sent to the agent)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                dismiss();
              } else if (e.key === "Escape") setDismissing(false);
            }}
          />
          <button type="button" disabled={busy} onClick={dismiss}>
            Dismiss
          </button>
          <button
            type="button"
            className="link"
            onClick={() => setDismissing(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="pending-actions">
          <button type="submit" className="button primary" disabled={busy}>
            Submit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDismissing(true)}
          >
            Dismiss…
          </button>
        </div>
      )}
      {error && (
        <p className="pending-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function FieldControl(props: {
  name: string;
  field: FormField;
  value: FieldValue | undefined;
  custom: string;
  error?: string;
  onChange: (v: FieldValue) => void;
  onCustom: (text: string) => void;
}) {
  const { field: f, value, name } = props;
  const label = fieldLabel(f);
  const text = typeof value === "string" ? value : "";
  let control: ReactNode;
  switch (f.type) {
    case "boolean":
      control = (
        <label className="pending-choice">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => props.onChange(e.target.checked)}
          />{" "}
          Yes
        </label>
      );
      break;
    case "number":
    case "integer":
      control = (
        <input
          type="number"
          aria-label={label}
          step={f.type === "integer" ? 1 : "any"}
          min={f.minimum}
          max={f.maximum}
          required={f.required}
          value={text}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
      break;
    case "multiselect": {
      const picked = Array.isArray(value) ? value : [];
      control = (
        <div className="pending-choices">
          {optionsOf(f).map((o) => (
            <label key={o.value} className="pending-choice">
              <input
                type="checkbox"
                checked={picked.includes(o.value)}
                onChange={(e) =>
                  props.onChange(
                    e.target.checked
                      ? [...picked, o.value]
                      : picked.filter((v) => v !== o.value)
                  )
                }
              />{" "}
              {o.label}
            </label>
          ))}
          {f.custom && (
            <input
              aria-label={`${label}: other`}
              placeholder="Other (comma-separated)"
              value={props.custom}
              onChange={(e) => props.onCustom(e.target.value)}
            />
          )}
        </div>
      );
      break;
    }
    case "external": {
      const href = safeUrl(f.url);
      control = href ? (
        <a className="button" href={href} target="_blank" rel="noreferrer">
          Open <Icon name="external" size={13} />
        </a>
      ) : (
        <span className="muted">No usable link{f.url ? `: ${f.url}` : ""}</span>
      );
      break;
    }
    default: {
      const options = optionsOf(f);
      if (options.length === 0) {
        control = (
          <input
            type={inputType(f.format)}
            aria-label={label}
            required={f.required}
            pattern={f.pattern}
            minLength={f.minLength}
            maxLength={f.maxLength}
            value={text}
            onChange={(e) => props.onChange(e.target.value)}
          />
        );
        break;
      }
      const isOption = options.some((o) => o.value === text);
      control = (
        <div className="pending-choices">
          {options.length <= RADIO_LIMIT ? (
            options.map((o) => (
              <label key={o.value} className="pending-choice">
                <input
                  type="radio"
                  name={name}
                  checked={text === o.value}
                  onChange={() => props.onChange(o.value)}
                />{" "}
                {o.label}
              </label>
            ))
          ) : (
            <select
              aria-label={label}
              value={isOption ? text : ""}
              onChange={(e) => props.onChange(e.target.value)}
            >
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {f.custom && (
            <input
              aria-label={`${label}: other`}
              placeholder="Other…"
              value={isOption ? "" : text}
              onChange={(e) => props.onChange(e.target.value)}
            />
          )}
        </div>
      );
    }
  }
  return (
    <div className="pending-field">
      <span className="pending-label">
        {label}
        {f.required && <span className="tone-text-attention"> *</span>}
      </span>
      {f.description && (
        <span className="muted pending-hint">{f.description}</span>
      )}
      {control}
      {props.error && <span className="pending-error">{props.error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Render the stacks in session lists**

In `src/web/components/SessionList.tsx`:

Add `import { Fragment } from "react";` and `import { PendingStack } from "./PendingCards";`.

The "Respond" link label in `SessionRow` only makes sense when the dashboard can't answer inline, so change it to:

```tsx
{
  (session.status === "needs-permission" ||
    session.status === "needs-answer") &&
  !session.pending
    ? "Respond"
    : "Open";
}
{
  (" ");
}
```

Replace the `SessionList` body's `map` with:

```tsx
{
  props.entries.map(({ session, view }) => (
    <Fragment key={session.id}>
      <SessionRow
        session={session}
        openUrl={view.openUrl}
        project={
          props.showProject
            ? { id: view.project.id, name: view.project.name }
            : undefined
        }
        worktree={worktreeLabel(view, session.directory)}
        highlighted={session.id === props.highlight}
        now={now}
      />
      {session.pending && (
        <li className="pending-item" id={`pending-${session.id}`}>
          <PendingStack session={session} view={view} />
        </li>
      )}
    </Fragment>
  ));
}
```

- [ ] **Step 3: Focus the card when a notification is clicked**

In `src/web/pages/ProjectPage.tsx`, replace the highlight effect (lines 105–107) with:

```tsx
useEffect(() => {
  if (!highlight) return;
  document
    .getElementById(`session-${highlight}`)
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
  document
    .querySelector<HTMLElement>(
      `#pending-${CSS.escape(highlight)} .pending-card`
    )
    ?.focus({ preventScroll: true });
}, [highlight]);
```

- [ ] **Step 4: Styles**

Append to `src/web/styles.css`, before the first `@media (max-width…)` block if one follows the rows section, otherwise at the end:

```css
/* Inline responses */
.pending-item {
  list-style: none;
  padding: 0 1rem 0.8rem;
}
.pending-count {
  margin: 0 0 0.35rem;
  font-size: 12.5px;
}
.pending-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid color-mix(in srgb, var(--attention) 35%, var(--border));
  border-radius: 8px;
  background: var(--surface);
}
.pending-card:focus-visible,
.pending-card:focus {
  outline: 2px solid var(--attention);
  outline-offset: 1px;
}
.pending-ask {
  margin: 0;
}
.pending-who {
  color: var(--muted);
}
.pending-resources {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.pending-resources code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pending-message {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pending-diff {
  margin: 0;
  max-height: 18rem;
  overflow: auto;
  padding: 0.5rem 0.75rem;
  font: 12px/1.5 var(--mono);
  background: var(--surface-2);
  border-radius: 6px;
}
.pending-diff .add {
  color: var(--ok);
}
.pending-diff .del {
  color: var(--danger);
}
.pending-diff .hunk,
.pending-diff .file {
  color: var(--muted);
}
.pending-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.pending-actions kbd {
  margin-left: 0.3rem;
}
.pending-reason {
  flex: 1 1 16rem;
}
.pending-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.pending-label {
  font-weight: 500;
}
.pending-hint {
  font-size: 12.5px;
}
.pending-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.9rem;
  align-items: center;
}
.pending-choice {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.pending-error {
  color: var(--danger);
  font-size: 12.5px;
  margin: 0;
}
.pending-readonly {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 0.8rem;
  margin: 0;
}
.pending-readonly dd {
  margin: 0;
}
```

- [ ] **Step 5: Typecheck and build**

Run: `pnpm typecheck && pnpm build && pnpm test` Expected: everything passes and the build writes `dist/`.

- [ ] **Step 6: Check it in the running app**

Use the `run` skill to start the dashboard against a project that has a running container (or `pnpm dev`, then open the printed URL). Create a pending permission and a form with opencode's own fixture endpoints. Use the project's opencode address and password from the dashboard's runtime info, `x-opencode-directory` set to the workspace folder, and an existing session id:

```bash
curl -u opencode:$PW -H 'content-type: application/json' -H "x-opencode-directory: $DIR" \
  -d '{"action":"bash","resources":["npm test"],"save":["npm *"],"message":"run the tests"}' \
  $OC/api/session/$SID/permission
curl -u opencode:$PW -H 'content-type: application/json' -H "x-opencode-directory: $DIR" \
  -d '{"title":"Which database?","fields":[{"key":"db","type":"string","options":["postgres","sqlite"],"custom":true,"required":true},{"key":"why","type":"string","when":[{"key":"db","op":"eq","value":"sqlite"}]}]}' \
  $OC/api/session/$SID/form
```

Check:

- [ ] The Overview "Needs you" shows the card with "1 of 2 waiting".
- [ ] Hovering "Always allow" lists `npm *`.
- [ ] Focusing the card and pressing Enter answers it, the form card appears and takes focus, and the session leaves "Needs you" within a second.
- [ ] Picking `sqlite` reveals "why". Submitting with nothing picked shows "Required".
- [ ] Answering a permission in the opencode tab while its card is open, then clicking "Allow once" in the dashboard, drops the card with no error.
- [ ] Resources containing `<b>x</b>` show the literal text.

If the create endpoints reject these bodies, read the real schema from `$OC/openapi.json` (look for `FormField` and the permission create body) and fix both the curl bodies and, if the field shape differs, `FormField` and `src/web/forms.ts`, with a test.

- [ ] **Step 7: Commit**

```bash
git add src/web/components/PendingCards.tsx src/web/components/SessionList.tsx src/web/pages/ProjectPage.tsx src/web/styles.css
git commit -m "feat: answer permissions and questions inline from the dashboard"
```

---

### Task 9: End-to-end against a real opencode

**Files:**

- Modify: `test/e2e/opendevhub.e2e.ts`

**Interfaces:**

- Consumes: `Orchestrator.replyPermission/replyForm/cancelForm` (Task 4); `OpencodeClient.replyPermission`, `isGone`, `isInvalidAnswer` (Task 3); `SessionSummary.pending` (Task 1).
- This is the only place the assumed opencode error shapes (`_tag`, 404 for an answered item, `FormInvalidAnswer` for a missing required field) meet the real server.

- [ ] **Step 1: Add the e2e steps**

In `test/e2e/opendevhub.e2e.ts`, change the client import to

```ts
import {
  OpencodeClient,
  basicAuth,
  isGone,
  isInvalidAnswer,
} from "../../src/server/opencode/client";
```

After the existing `vi.waitFor` that waits for `"e2e session"` in the snapshot, insert:

```ts
// Respond inline: create real pending items through opencode's own endpoints, answer them through opendevhub.
const sid = store
  .snapshot()
  .projects[0].sessions.find((s) => s.title === "e2e session")!.id;
const ask = (kind: "permission" | "form", body: unknown) =>
  fetch(`${ep.baseUrl}/api/session/${sid}/${kind}`, {
    method: "POST",
    headers: {
      authorization: basicAuth(ep.password),
      "content-type": "application/json",
      "x-opencode-directory": rt.workspaceFolder!,
    },
    body: JSON.stringify(body),
  });
const pendingOf = () =>
  store.snapshot().projects[0].sessions.find((s) => s.id === sid)?.pending;

expect(
  (await ask("permission", { action: "bash", resources: ["echo e2e"] })).ok
).toBe(true);
await vi.waitFor(() => expect(pendingOf()?.permissions).toHaveLength(1), {
  timeout: 15_000,
});
const rid = pendingOf()!.permissions[0].id;
await orch.replyPermission(project.id, rid, { decision: "once" });
await vi.waitFor(() => expect(pendingOf()?.permissions ?? []).toHaveLength(0), {
  timeout: 15_000,
});
// Answering again straight at opencode is how "answered in another client" looks.
const direct = new OpencodeClient(ep);
const again = await direct
  .replyPermission(sid, rid, { decision: "once" })
  .catch((e: unknown) => e);
console.log("[e2e] second permission reply:", again);
expect(isGone(again)).toBe(true);

const fields = [
  { key: "color", type: "string", options: ["red", "blue"], required: true },
];
expect((await ask("form", { title: "e2e question", fields })).ok).toBe(true);
await vi.waitFor(() => expect(pendingOf()?.forms).toHaveLength(1), {
  timeout: 15_000,
});
const fid = pendingOf()!.forms[0].id;
const invalid = await direct.replyForm(sid, fid, {}).catch((e: unknown) => e);
console.log("[e2e] invalid form answer:", invalid);
expect(isInvalidAnswer(invalid)).toBe(true);
await orch.replyForm(project.id, fid, { color: "red" });
await vi.waitFor(() => expect(pendingOf()?.forms ?? []).toHaveLength(0), {
  timeout: 15_000,
});

expect((await ask("form", { title: "e2e dismissed", fields })).ok).toBe(true);
await vi.waitFor(() => expect(pendingOf()?.forms).toHaveLength(1), {
  timeout: 15_000,
});
await orch.cancelForm(project.id, pendingOf()!.forms[0].id, "not needed");
await vi.waitFor(() => expect(pendingOf()).toBeUndefined(), {
  timeout: 15_000,
});
```

- [ ] **Step 2: Run the e2e**

Run: `pnpm test:e2e` Expected: PASS. It needs Docker and the devcontainer CLI, and takes a minute or two.

If a step fails, the `[e2e]` log lines show opencode's actual error, and the fix goes where the assumption lives:

- If the create body is rejected (400 from `ask`), read `openapi.json` and correct the body here and the shape of `FormField` in Task 1.
- If the second reply isn't recognised as gone, adjust `GONE_TAGS` or `isGone` in `client.ts` and add the real tag or status to the client test in Task 3.
- If the invalid answer isn't recognised, adjust `isInvalidAnswer` the same way. If opencode doesn't validate required fields at all, it settles the form here: delete that assertion and its `invalid` lines, and note in the commit message that only the dashboard validates.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/opendevhub.e2e.ts
git commit -m "test: e2e for answering permissions and forms through opendevhub"
```

---

## Spec coverage

| Spec item | Task |
| --- | --- |
| Data: `PendingPermission`/`PendingForm` on the root session, rolled up by `deriveSessions` | 1 |
| `createdAt`: first time the monitor saw it | 2 |
| API: three routes, known ids only (404), already answered (409), invalid (400), reconcile after a reply | 3, 4, 5 |
| Security: Origin check only; agent text as plain text | 5 (Origin test), 8 (React text only, `safeUrl`) |
| Permission card: title/action, 5 resources + "+n more", message, Allow once / Always (tooltip with `save`) / Reject with a reason | 8 |
| Diff from `metadata.diff`/`patch` | 1, 8 |
| Form card: every field type, `when`/`hidden`, Submit, Dismiss with a message, unsupported → read-only + "Answer in opencode" | 6, 8 |
| Stacked oldest first, the next one shown after answering | 1, 2, 8 |
| Keys Enter/a/r/j/k | 8 |
| Notifications say what is asked; a click focuses the card | 7, 8 |
| Testing: unit (`deriveSessions`, form logic), integration (routes, fake opencode), e2e | 1, 3–7, 9 |
