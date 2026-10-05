# Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show cost and tokens per variant (subagents included), per task, per project (today and all time) and for today, from a ledger that survives archive, discard, container removal and restarts.

**Architecture:** The monitor hands each poll's raw opencode sessions to a `UsageStore` (SQLite via `node:sqlite`, `usage.db` next to `state.json`). It rolls subagents into their root session, books the increase since the last-seen values to the local day of the session's last update, and sums the ledger into `UsageTotals`. `trackUsage` pushes those totals into the `StateStore`, so they ride on the dashboard snapshot. The web shows them on the overview, project and task pages.

**Tech Stack:** TypeScript, Node ≥ 22.13 (`node:sqlite` `DatabaseSync`), Hono server, React + Tailwind + shadcn/ui, vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-usage-tracking-design.md`

All paths below are relative to `apps/opendevhub/` unless they start with `docs/`, `README.md` or `apps/`. Run commands from `apps/opendevhub/`.

## Global Constraints

- No new npm dependency: SQLite comes from Node's built-in `node:sqlite`.
- `engines.node` is `>=22.13`; the tsup `target` is `node22`.
- `usage.db` lives in `configDir()` (next to `state.json`), in WAL mode, with schema version 1 in `PRAGMA user_version`.
- Days are `YYYY-MM-DD` in the server's local time zone.
- Tokens are input + output + reasoning; cache reads and writes are not counted.
- If the ledger can't be opened, the dashboard runs as before and the snapshot has no `usage`; nothing usage-related renders.
- Usage rows are never deleted.
- Format numbers with the existing `formatCost` / `formatTokens` in `src/web/tasks.ts`.
- Commit messages follow the repo style (`feat:`, `test:`, `docs:`), each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work directly on `main`.

## Review Focus

1. **A subagent works for a long time while the root session's `time.updated` stays old.** The spend must land on the day the subagent ran, not on the root's last-update day. (Task 1 adds the latest update across the tree; Task 2 tests the day.)
2. **Midnight with no new spend.** "Today" must reset to $0.00 without waiting for a booking. (Task 4 tests this with a fake clock.)
3. **A corrupt `usage.db`, or one written by a newer opendevhub.** opendevhub must still start, log once, and omit `usage`. (Task 3 tests both.)
4. **A discarded variant or an archived session.** Its spend stays in the task and project totals, and it's never booked twice when it reappears. (Task 3 tests both.)
5. **A session that reports `cost` but no `tokens`, or neither.** It counts as 0 for what's missing, without crashing or producing `NaN`. (Tasks 1 and 2 test this.)

---

### Task 1: Roll subagents into their root session

**Files:**
- Modify: `src/server/status.ts` (add `rollUp`, use it in `deriveSessions`)
- Test: `test/server/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RolledUp { cost?: number; tokens?: number; updatedAt: number }
  export function rollUp(sessions: RawSession[]): Map<string, RolledUp>
  ```
  The map is keyed by root session id. A session whose parent is missing from the list is its own root. `cost` / `tokens` stay `undefined` when no session in the tree reports them. `updatedAt` is the max `time.updated` in the tree.

- [ ] **Step 1: Write the failing tests**

Append to `test/server/status.test.ts` (and change the import to `import { deriveSessions, rollUp } from "../../src/server/status";`):

```ts
const tokens = (input: number, output = 0, reasoning = 0) => ({ input, output, reasoning, cache: { read: 7, write: 7 } });

describe("rollUp", () => {
  it("adds children and grandchildren into the root, without cache tokens", () => {
    const out = rollUp([
      rawSession("root", { cost: 1, tokens: tokens(10, 5, 1), time: { created: 1, updated: 100 } }),
      rawSession("child", { parentID: "root", cost: 0.5, tokens: tokens(4), time: { created: 1, updated: 300 } }),
      rawSession("grand", { parentID: "child", cost: 0.25, tokens: tokens(2), time: { created: 1, updated: 200 } }),
    ]);
    expect([...out.keys()]).toEqual(["root"]);
    expect(out.get("root")).toEqual({ cost: 1.75, tokens: 22, updatedAt: 300 });
  });

  it("leaves cost and tokens undefined when nobody reports them, and counts a missing one as absent", () => {
    const out = rollUp([rawSession("a"), rawSession("b", { cost: 2 })]);
    expect(out.get("a")).toEqual({ updatedAt: 1 });
    expect(out.get("b")).toEqual({ cost: 2, updatedAt: 1 });
  });

  it("treats a child whose parent is missing as its own root", () => {
    const out = rollUp([rawSession("orphan", { parentID: "gone", cost: 1 })]);
    expect(out.get("orphan")).toEqual({ cost: 1, updatedAt: 1 });
  });

  it("survives parent cycles", () => {
    const out = rollUp([rawSession("x", { parentID: "y", cost: 1 }), rawSession("y", { parentID: "x", cost: 1 })]);
    expect([...out.values()].reduce((n, r) => n + (r.cost ?? 0), 0)).toBe(2);
  });
});

describe("deriveSessions cost", () => {
  it("includes the subagents' cost and tokens in the root's summary", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("root", { cost: 1, tokens: tokens(10) }),
        rawSession("child", { parentID: "root", cost: 0.5, tokens: tokens(5) }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "root", cost: 1.5, tokens: 15 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/status.test.ts`
Expected: FAIL. `rollUp` is not exported, and the root's cost is 1, not 1.5.

- [ ] **Step 3: Implement `rollUp` and use it**

In `src/server/status.ts`, after `tokensOf`, add:

```ts
export interface RolledUp {
  /** USD; undefined when no session in the tree reports it. */
  cost?: number;
  /** Input, output and reasoning tokens; undefined when no session in the tree reports them. */
  tokens?: number;
  /** The latest `time.updated` in the tree. */
  updatedAt: number;
}

const plus = (a: number | undefined, b: number | undefined) => (b === undefined ? a : (a ?? 0) + b);

/** Each root session with its subagents' (child sessions') cost and tokens added in, by root id. */
export function rollUp(sessions: RawSession[]): Map<string, RolledUp> {
  const parents = new Map(sessions.map((s) => [s.id, s.parentID]));
  const out = new Map<string, RolledUp>();
  for (const s of sessions) {
    const root = rootOf(s.id, parents);
    const acc = out.get(root) ?? { updatedAt: 0 };
    const cost = plus(acc.cost, typeof s.cost === "number" ? s.cost : undefined);
    const tokens = plus(acc.tokens, tokensOf(s));
    out.set(root, {
      ...(cost !== undefined ? { cost } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      updatedAt: Math.max(acc.updatedAt, s.time.updated),
    });
  }
  return out;
}
```

In `deriveSessions`, add `const totals = rollUp(input.sessions);` next to `const parents = ...`. In the final `.map(({ s, task }) => { ... })`, replace `const tokens = tokensOf(s);` with:

```ts
      const { cost, tokens } = totals.get(s.id) ?? {};
```

Then replace the two spread lines:

```ts
        ...(typeof s.cost === "number" ? { cost: s.cost } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
```

with:

```ts
        ...(cost !== undefined ? { cost } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
```

Update the `SessionSummary` doc comments in `src/shared/types.ts`:

```ts
  /** USD so far, its subagents included. */
  cost?: number;
  /** Input, output and reasoning tokens so far, its subagents included. */
  tokens?: number;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server/status.test.ts`
Expected: PASS, with the existing `deriveSessions` tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/server/status.ts src/shared/types.ts test/server/status.test.ts
git commit -m "feat: a session's cost and tokens include its subagents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Booking arithmetic

**Files:**
- Create: `src/server/usage.ts`
- Test: `test/server/usage.test.ts`

**Interfaces:**
- Consumes: `rollUp(sessions): Map<string, RolledUp>` from `src/server/status.ts` (Task 1); `parseTaskMeta(metadata: unknown): TaskMeta | undefined` from `src/server/tasks.ts`.
- Produces (all exported from `src/server/usage.ts`):
  ```ts
  export interface Observed { sessionId: string; projectId: ProjectId; task?: string; cost: number; tokens: number; updatedAt: number }
  export interface Seen { cost: number; tokens: number }
  export interface Booking { day: string; sessionId: string; projectId: ProjectId; task?: string; cost: number; tokens: number }
  export function localDay(ms: number): string               // "YYYY-MM-DD", local time
  export function observe(projectId: ProjectId, sessions: RawSession[]): Observed[]
  export function book(observed: Observed[], seen: Map<string, Seen>): Booking[]
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/server/usage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type Observed, book, localDay, observe } from "../../src/server/usage";
import { rawSession } from "../helpers/fake-opencode";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const obs = (over: Partial<Observed> = {}): Observed => ({ sessionId: "s", projectId: "p", cost: 1, tokens: 100, updatedAt: at(2026, 10, 5), ...over });
const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
const taskMeta = (task: string, discarded = false) => ({ opendevhub: { task, variant: 1, of: 2, title: "t", ...(discarded ? { discarded } : {}) } });

describe("localDay", () => {
  it("formats the local date with zero padding", () => {
    expect(localDay(at(2026, 3, 7))).toBe("2026-03-07");
  });

  it("uses local time, not UTC, around midnight", () => {
    expect(localDay(new Date(2026, 9, 5, 23, 59).getTime())).toBe("2026-10-05");
    expect(localDay(new Date(2026, 9, 6, 0, 1).getTime())).toBe("2026-10-06");
  });
});

describe("observe", () => {
  it("rolls subagents up and dates the session by the latest update in its tree", () => {
    const out = observe("p", [
      rawSession("root", { cost: 1, tokens: tokens(10), time: { created: 1, updated: at(2026, 10, 4) } }),
      rawSession("sub", { parentID: "root", cost: 2, tokens: tokens(5), time: { created: 1, updated: at(2026, 10, 5) } }),
    ]);
    expect(out).toEqual([{ sessionId: "root", projectId: "p", cost: 3, tokens: 15, updatedAt: at(2026, 10, 5) }]);
  });

  it("tags a task's sessions, discarded ones included", () => {
    const out = observe("p", [rawSession("a", { metadata: taskMeta("tsk_1") }), rawSession("b", { metadata: taskMeta("tsk_1", true) })]);
    expect(out.map((o) => o.task)).toEqual(["tsk_1", "tsk_1"]);
  });

  it("counts a missing cost or tokens as 0", () => {
    const out = observe("p", [rawSession("a", { cost: 2 }), rawSession("b", { tokens: tokens(3) })]);
    expect(out.map(({ cost, tokens }) => ({ cost, tokens }))).toEqual([{ cost: 2, tokens: 0 }, { cost: 0, tokens: 3 }]);
  });
});

describe("book", () => {
  it("books everything on first sight, to the day of the last update", () => {
    expect(book([obs({ task: "tsk_1" })], new Map())).toEqual([
      { day: "2026-10-05", sessionId: "s", projectId: "p", task: "tsk_1", cost: 1, tokens: 100 },
    ]);
  });

  it("books only the increase", () => {
    const out = book([obs({ cost: 1.5, tokens: 150 })], new Map([["s", { cost: 1, tokens: 100 }]]));
    expect(out).toEqual([{ day: "2026-10-05", sessionId: "s", projectId: "p", cost: 0.5, tokens: 50 }]);
  });

  it("books nothing when nothing changed", () => {
    expect(book([obs()], new Map([["s", { cost: 1, tokens: 100 }]]))).toEqual([]);
  });

  it("books nothing for a decrease, and a later increase from the lower value", () => {
    expect(book([obs({ cost: 0.4, tokens: 40 })], new Map([["s", { cost: 1, tokens: 100 }]]))).toEqual([]);
    const later = book([obs({ cost: 0.6, tokens: 60 })], new Map([["s", { cost: 0.4, tokens: 40 }]]));
    expect(later[0]).toMatchObject({ cost: 0.6 - 0.4, tokens: 20 });
  });

  it("books a session that used tokens without a reported cost", () => {
    expect(book([obs({ cost: 0, tokens: 10 })], new Map())).toEqual([
      { day: "2026-10-05", sessionId: "s", projectId: "p", cost: 0, tokens: 10 },
    ]);
  });

  it("books nothing for a session that hasn't spent anything", () => {
    expect(book([obs({ cost: 0, tokens: 0 })], new Map())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/usage.test.ts`
Expected: FAIL with "Failed to load url ../../src/server/usage" (or a similar missing-module error).

- [ ] **Step 3: Implement**

Create `src/server/usage.ts`:

```ts
import type { ProjectId } from "../shared/types";
import type { RawSession } from "./opencode/client";
import { rollUp } from "./status";
import { parseTaskMeta } from "./tasks";

/** A root session's spend so far, its subagents included. */
export interface Observed {
  sessionId: string;
  projectId: ProjectId;
  task?: string;
  cost: number;
  tokens: number;
  /** The latest update in the session's tree; decides the day spend is booked to. */
  updatedAt: number;
}

export interface Seen {
  cost: number;
  tokens: number;
}

export interface Booking {
  /** YYYY-MM-DD, local time. */
  day: string;
  sessionId: string;
  projectId: ProjectId;
  task?: string;
  cost: number;
  tokens: number;
}

/** YYYY-MM-DD in the local time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Each root session among `sessions`, with its subagents rolled in and its task, if any. */
export function observe(projectId: ProjectId, sessions: RawSession[]): Observed[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return [...rollUp(sessions)].map(([sessionId, t]) => {
    const task = parseTaskMeta(byId.get(sessionId)?.metadata)?.task;
    return { sessionId, projectId, ...(task ? { task } : {}), cost: t.cost ?? 0, tokens: t.tokens ?? 0, updatedAt: t.updatedAt };
  });
}

/**
 * What each session spent since it was last seen, booked to the day it was last updated. A session never seen
 * books everything; a decrease (opencode reverting messages) books nothing, since the spend happened.
 */
export function book(observed: Observed[], seen: Map<string, Seen>): Booking[] {
  return observed.flatMap((o) => {
    const before = seen.get(o.sessionId) ?? { cost: 0, tokens: 0 };
    const cost = Math.max(0, o.cost - before.cost);
    const tokens = Math.max(0, o.tokens - before.tokens);
    if (cost === 0 && tokens === 0) return [];
    return [{ day: localDay(o.updatedAt), sessionId: o.sessionId, projectId: o.projectId, ...(o.task ? { task: o.task } : {}), cost, tokens }];
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/usage.ts test/server/usage.test.ts
git commit -m "feat: book what each session spent since it was last seen, by day

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The SQLite ledger (`UsageStore`) and the Node 22.13 floor

**Files:**
- Modify: `src/server/usage.ts` (add `UsageStore`)
- Modify: `src/shared/types.ts` (add `Usage`, `UsageTotals`)
- Modify: `package.json` (`engines.node`), `tsup.config.ts` (`target`)
- Modify: `README.md` (from the repo root), `apps/docs/content/docs/getting-started.mdx` (Requirements: Node version)
- Test: `test/server/usage.test.ts`

**Interfaces:**
- Consumes: `observe`, `book`, `Seen` from Task 2.
- Produces:
  ```ts
  // src/shared/types.ts
  export interface Usage { /** USD. */ cost: number; tokens: number }
  export interface UsageTotals {
    today: Usage;
    projects: Record<ProjectId, { today: Usage; total: Usage }>;
    /** By TaskMeta.task. */
    tasks: Record<string, Usage>;
  }
  // src/server/usage.ts
  export class UsageStore {
    static open(file: string, log?: (message: string) => void): UsageStore | undefined; // ":memory:" in tests
    record(projectId: ProjectId, sessions: RawSession[]): boolean; // true when anything was booked
    totals(today: string): UsageTotals;
    close(): void;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/server/usage.test.ts` and extend the imports:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Observed, UsageStore, book, localDay, observe } from "../../src/server/usage";
```

(Replace the earlier `vitest` and `usage` import lines with these.)

```ts
describe("UsageStore", () => {
  const today = localDay(at(2026, 10, 5));
  const s = (id: string, cost: number, over: Parameters<typeof rawSession>[1] = {}) =>
    rawSession(id, { cost, tokens: tokens(cost * 100), time: { created: 1, updated: at(2026, 10, 5) }, ...over });
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "odh-usage-"));
    dirs.push(d);
    return path.join(d, "usage.db");
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("books only the increase across two records, and says whether it booked", () => {
    const u = UsageStore.open(":memory:")!;
    expect(u.record("p", [s("a", 1)])).toBe(true);
    expect(u.record("p", [s("a", 1)])).toBe(false);
    expect(u.record("p", [s("a", 1.5)])).toBe(true);
    expect(u.totals(today).today).toEqual({ cost: 1.5, tokens: 150 });
  });

  it("sums per project (today and all time), per task and for today", () => {
    const u = UsageStore.open(":memory:")!;
    u.record("p", [
      s("old", 2, { time: { created: 1, updated: at(2026, 10, 1) } }),
      s("v1", 1, { metadata: { opendevhub: { task: "tsk_1", variant: 1, of: 2, title: "t" } } }),
      s("v2", 0.5, { metadata: { opendevhub: { task: "tsk_1", variant: 2, of: 2, title: "t", discarded: true } } }),
    ]);
    u.record("q", [s("other", 4)]);
    expect(u.totals(today)).toEqual({
      today: { cost: 5.5, tokens: 550 },
      projects: {
        p: { today: { cost: 1.5, tokens: 150 }, total: { cost: 3.5, tokens: 350 } },
        q: { today: { cost: 4, tokens: 400 }, total: { cost: 4, tokens: 400 } },
      },
      tasks: { tsk_1: { cost: 1.5, tokens: 150 } },
    });
  });

  it("keeps a session's spend after it disappears, and books nothing twice when it comes back", () => {
    const u = UsageStore.open(":memory:")!;
    u.record("p", [s("a", 1), s("b", 2)]);
    u.record("p", [s("b", 2)]);
    expect(u.totals(today).today.cost).toBe(3);
    expect(u.record("p", [s("a", 1), s("b", 2)])).toBe(false);
    expect(u.totals(today).today.cost).toBe(3);
  });

  it("reports zeros when nothing was booked", () => {
    expect(UsageStore.open(":memory:")!.totals(today)).toEqual({ today: { cost: 0, tokens: 0 }, projects: {}, tasks: {} });
  });

  it("books nothing twice after reopening the file", () => {
    const file = tmp();
    const first = UsageStore.open(file)!;
    first.record("p", [s("a", 1)]);
    first.close();
    const second = UsageStore.open(file)!;
    expect(second.record("p", [s("a", 1)])).toBe(false);
    expect(second.totals(today).today.cost).toBe(1);
    second.close();
  });

  it("returns undefined and logs once for a file that isn't a database", () => {
    const file = tmp();
    fs.writeFileSync(file, "not a database, just text that is long enough to be read as a header".repeat(10));
    const log = vi.fn();
    expect(UsageStore.open(file, log)).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/usage tracking is off/);
  });

  it("returns undefined for a database written by a newer opendevhub", () => {
    const file = tmp();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 2");
    db.close();
    const log = vi.fn();
    expect(UsageStore.open(file, log)).toBeUndefined();
    expect(log.mock.calls[0][0]).toMatch(/newer opendevhub/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/usage.test.ts`
Expected: FAIL with "UsageStore is not exported" / `UsageStore` undefined.

- [ ] **Step 3: Add the shared types**

In `src/shared/types.ts`, before `export interface DashboardSnapshot`, add:

```ts
export interface Usage {
  /** USD. */
  cost: number;
  /** Input, output and reasoning tokens. */
  tokens: number;
}

/** Spend from opendevhub's ledger; "today" is the server's local date. */
export interface UsageTotals {
  today: Usage;
  projects: Record<ProjectId, { today: Usage; total: Usage }>;
  /** By TaskMeta.task, discarded variants included. */
  tasks: Record<string, Usage>;
}
```

- [ ] **Step 4: Implement `UsageStore`**

In `src/server/usage.ts`, add `import { DatabaseSync, type StatementSync } from "node:sqlite";` at the top. Change the shared types import to `import type { ProjectId, Usage, UsageTotals } from "../shared/types";`. Then append:

```ts
const VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task       TEXT,
  cost       REAL NOT NULL,
  tokens     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  day        TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task       TEXT,
  cost       REAL NOT NULL,
  tokens     INTEGER NOT NULL,
  PRIMARY KEY (day, session_id)
);
CREATE INDEX IF NOT EXISTS usage_project ON usage (project_id, day);
CREATE INDEX IF NOT EXISTS usage_task ON usage (task) WHERE task IS NOT NULL;
`;

interface SumRow {
  cost: number | null;
  tokens: number | null;
}

const usageOf = (r: SumRow | undefined): Usage => ({ cost: r?.cost ?? 0, tokens: r?.tokens ?? 0 });

/** The ledger of what sessions spent, in `usage.db`. */
export class UsageStore {
  private readonly getSeen: StatementSync;
  private readonly putSeen: StatementSync;
  private readonly addUsage: StatementSync;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly log: (message: string) => void,
  ) {
    this.getSeen = db.prepare("SELECT cost, tokens FROM seen WHERE session_id = ?");
    this.putSeen = db.prepare(
      `INSERT INTO seen (session_id, project_id, task, cost, tokens) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET project_id = excluded.project_id, task = excluded.task, cost = excluded.cost, tokens = excluded.tokens`,
    );
    this.addUsage = db.prepare(
      `INSERT INTO usage (day, session_id, project_id, task, cost, tokens) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, session_id) DO UPDATE SET cost = cost + excluded.cost, tokens = tokens + excluded.tokens`,
    );
  }

  /** Opens or creates the ledger. Undefined, after logging why, when it can't; callers then run without usage. */
  static open(file: string, log: (message: string) => void = console.warn): UsageStore | undefined {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file);
      const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version > VERSION) throw new Error(`it was written by a newer opendevhub (schema ${version})`);
      if (version < VERSION) {
        db.exec("BEGIN");
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${VERSION}`);
        db.exec("COMMIT");
      }
      db.exec("PRAGMA journal_mode = WAL");
      return new UsageStore(db, log);
    } catch (err) {
      try {
        db?.close();
      } catch {
        // already closed or never opened
      }
      log(`usage tracking is off: can't open ${file}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Books what `sessions` (one poll of a project's opencode, subagents included) spent since they were last seen.
   * True when anything was booked. A failed write is logged and rolled back, so the next poll retries it.
   */
  record(projectId: ProjectId, sessions: RawSession[]): boolean {
    const observed = observe(projectId, sessions);
    try {
      const seen = new Map<string, Seen>();
      for (const o of observed) {
        const row = this.getSeen.get(o.sessionId) as Seen | undefined;
        if (row) seen.set(o.sessionId, { cost: row.cost, tokens: row.tokens });
      }
      const changed = observed.filter((o) => {
        const before = seen.get(o.sessionId);
        return !before || before.cost !== o.cost || before.tokens !== o.tokens;
      });
      if (changed.length === 0) return false;
      const bookings = book(changed, seen);
      this.db.exec("BEGIN");
      try {
        for (const o of changed) this.putSeen.run(o.sessionId, o.projectId, o.task ?? null, o.cost, o.tokens);
        for (const b of bookings) this.addUsage.run(b.day, b.sessionId, b.projectId, b.task ?? null, b.cost, b.tokens);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      return bookings.length > 0;
    } catch (err) {
      this.log(`usage: couldn't record ${projectId}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Today's total, each project's today and all-time totals, and each task's total. */
  totals(today: string): UsageTotals {
    const day = this.db.prepare("SELECT SUM(cost) AS cost, SUM(tokens) AS tokens FROM usage WHERE day = ?").get(today) as SumRow | undefined;
    const projectRows = this.db
      .prepare(
        `SELECT project_id AS id, SUM(cost) AS cost, SUM(tokens) AS tokens,
                SUM(CASE WHEN day = ? THEN cost ELSE 0 END) AS todayCost,
                SUM(CASE WHEN day = ? THEN tokens ELSE 0 END) AS todayTokens
         FROM usage GROUP BY project_id`,
      )
      .all(today, today) as unknown as (SumRow & { id: string; todayCost: number; todayTokens: number })[];
    const taskRows = this.db
      .prepare("SELECT task AS id, SUM(cost) AS cost, SUM(tokens) AS tokens FROM usage WHERE task IS NOT NULL GROUP BY task")
      .all() as unknown as (SumRow & { id: string })[];
    return {
      today: usageOf(day),
      projects: Object.fromEntries(
        projectRows.map((r) => [r.id, { today: { cost: r.todayCost, tokens: r.todayTokens }, total: usageOf(r) }]),
      ),
      tasks: Object.fromEntries(taskRows.map((r) => [r.id, usageOf(r)])),
    };
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/server/usage.test.ts`
Expected: PASS. If the "isn't a database" test passes `open` because SQLite accepts the text file lazily, check that the `PRAGMA user_version` read is what throws ("file is not a database"). The read is inside the `try`, so `open` must return `undefined`.

- [ ] **Step 6: Raise the Node floor**

- `package.json`: `"node": ">=20"` → `"node": ">=22.13"`.
- `tsup.config.ts`: `target: "node20"` → `target: "node22"`.
- `README.md` (repo root) and `apps/docs/content/docs/getting-started.mdx`: `- Node.js 20 or newer` → `- Node.js 22.13 or newer`.

Run: `pnpm build && grep -c 'from "node:sqlite"' dist/bin.js`
Expected: the build succeeds and the count is 0, because nothing imports usage.ts from `bin.ts` yet. (Task 5 wires it in and re-checks with a count of at least 1.)

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add src/server/usage.ts src/shared/types.ts test/server/usage.test.ts package.json tsup.config.ts ../../README.md ../docs/content/docs/getting-started.mdx
git commit -m "feat: a SQLite ledger of session spend in usage.db; Node 22.13 or newer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Totals in the snapshot, refreshed after bookings and at midnight

**Files:**
- Modify: `src/shared/types.ts` (`DashboardSnapshot.usage`)
- Modify: `src/server/state.ts` (`setUsage`, snapshot)
- Modify: `src/server/usage.ts` (add `trackUsage`)
- Test: `test/server/state.test.ts`, `test/server/usage.test.ts`

**Interfaces:**
- Consumes: `UsageStore`, `localDay`, `UsageTotals` (Tasks 2–3).
- Produces:
  ```ts
  // StateStore
  setUsage(totals: UsageTotals | undefined): void   // no-op (no emit) when unchanged
  // DashboardSnapshot
  usage?: UsageTotals
  // src/server/usage.ts
  export interface UsageTracker { record(projectId: ProjectId, sessions: RawSession[]): void; stop(): void }
  export function trackUsage(usage: Pick<UsageStore, "record" | "totals">, store: Pick<StateStore, "setUsage">, now?: () => number): UsageTracker
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/server/state.test.ts`:

```ts
describe("usage", () => {
  const totals = { today: { cost: 1, tokens: 10 }, projects: {}, tasks: {} };

  it("puts usage in the snapshot only once set", () => {
    const { store } = make();
    expect(store.snapshot()).not.toHaveProperty("usage");
    store.setUsage(totals);
    expect(store.snapshot().usage).toEqual(totals);
  });

  it("notifies only when the totals change", () => {
    const { store } = make();
    const fn = vi.fn();
    store.subscribe(fn);
    store.setUsage(totals);
    store.setUsage(structuredClone(totals));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

Append to `test/server/usage.test.ts` (add `beforeEach` to the `vitest` import, and `trackUsage` to the `usage` import):

```ts
describe("trackUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets totals at once, after each booking, and when the day changes without new spend", () => {
    let clock = new Date(2026, 9, 5, 23, 59, 30).getTime();
    const u = UsageStore.open(":memory:")!;
    const store = { setUsage: vi.fn() };
    const tracker = trackUsage(u, store, () => clock);
    expect(store.setUsage).toHaveBeenLastCalledWith({ today: { cost: 0, tokens: 0 }, projects: {}, tasks: {} });

    tracker.record("p", [rawSession("a", { cost: 1, tokens: tokens(10), time: { created: 1, updated: clock } })]);
    expect(store.setUsage.mock.lastCall![0].today).toEqual({ cost: 1, tokens: 10 });

    const calls = store.setUsage.mock.calls.length;
    tracker.record("p", [rawSession("a", { cost: 1, tokens: tokens(10), time: { created: 1, updated: clock } })]);
    expect(store.setUsage.mock.calls.length).toBe(calls);

    clock = new Date(2026, 9, 6, 0, 0, 30).getTime();
    vi.advanceTimersByTime(60_000);
    expect(store.setUsage.mock.lastCall![0].today).toEqual({ cost: 0, tokens: 0 });
    expect(store.setUsage.mock.lastCall![0].projects.p.total).toEqual({ cost: 1, tokens: 10 });
    tracker.stop();
  });

  it("logs and keeps the old totals when reading them fails", () => {
    const store = { setUsage: vi.fn() };
    const log = vi.fn();
    const broken = { record: () => true, totals: () => { throw new Error("disk I/O error"); } };
    const tracker = trackUsage(broken, store, Date.now, log);
    tracker.record("p", []);
    expect(store.setUsage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/disk I\/O error/));
    tracker.stop();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/state.test.ts test/server/usage.test.ts`
Expected: FAIL. `setUsage` isn't a function, and `trackUsage` isn't exported.

- [ ] **Step 3: Implement**

`src/shared/types.ts`, in `DashboardSnapshot`:

```ts
export interface DashboardSnapshot {
  roots: string[];
  preflight: Preflight;
  editors: EditorInfo[];
  projects: ProjectView[];
  /** Absent when the usage ledger couldn't be opened. */
  usage?: UsageTotals;
}
```

`src/server/state.ts`: add `UsageTotals` to the type import from `../shared/types`. Add a field next to `isolationInfo`:

```ts
  private usageTotals?: UsageTotals;
```

Add a method after `setEditors`:

```ts
  setUsage(totals: UsageTotals | undefined): void {
    if (JSON.stringify(this.usageTotals) === JSON.stringify(totals)) return;
    this.usageTotals = totals;
    this.emit();
  }
```

In `snapshot()`, after `projects: ...map(...)`, add:

```ts
      ...(this.usageTotals ? { usage: this.usageTotals } : {}),
```

`src/server/usage.ts`: append:

```ts
export interface UsageTracker {
  record(projectId: ProjectId, sessions: RawSession[]): void;
  stop(): void;
}

const DAY_CHECK_MS = 60_000;

/** Keeps the dashboard's usage totals current: after each booking, and every minute so "today" resets at midnight. */
export function trackUsage(
  usage: Pick<UsageStore, "record" | "totals">,
  store: { setUsage(totals: UsageTotals | undefined): void },
  now: () => number = Date.now,
  log: (message: string) => void = console.warn,
): UsageTracker {
  const refresh = () => {
    try {
      store.setUsage(usage.totals(localDay(now())));
    } catch (err) {
      log(`usage: couldn't read totals: ${(err as Error).message}`);
    }
  };
  refresh();
  const timer = setInterval(refresh, DAY_CHECK_MS);
  timer.unref?.();
  return {
    record: (projectId, sessions) => {
      if (usage.record(projectId, sessions)) refresh();
    },
    stop: () => clearInterval(timer),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server/state.test.ts test/server/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/server/state.ts src/server/usage.ts test/server/state.test.ts test/server/usage.test.ts
git commit -m "feat: usage totals in the dashboard snapshot, refreshed after bookings and at midnight

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Feed the monitor's sessions into the ledger

**Files:**
- Modify: `src/server/monitor.ts` (`onRawSessions`)
- Modify: `src/server/orchestrator.ts` (`recordUsage` dependency, `startMonitor`)
- Modify: `src/server/cli.ts` (open `usage.db`, `trackUsage`, shutdown)
- Test: `test/server/monitor.test.ts`, `test/server/orchestrator.test.ts`

**Interfaces:**
- Consumes: `UsageStore.open`, `trackUsage`, `UsageTracker` (Tasks 3–4).
- Produces:
  ```ts
  // MonitorOptions
  onRawSessions?: (sessions: RawSession[]) => void  // every successful poll, subagents and archived sessions included
  // OrchestratorDeps
  recordUsage?: (projectId: ProjectId, sessions: RawSession[]) => void  // projectId is the project's id, also for task environments
  ```

- [ ] **Step 1: Write the failing tests**

Append inside `describe("Monitor", ...)` in `test/server/monitor.test.ts`:

```ts
  it("hands every poll's raw sessions, subagents included, to onRawSessions", async () => {
    fake.state.sessions = [rawSession("ses_1", { cost: 1 }), rawSession("ses_2", { parentID: "ses_1", cost: 2 })];
    const raw: string[][] = [];
    start({ onRawSessions: (s) => raw.push(s.map((x) => x.id)) });
    await vi.waitFor(() => expect(raw.at(-1)).toEqual(["ses_1", "ses_2"]));
  });
```

In `test/server/orchestrator.test.ts`, inside `setup()`, add `const recordUsage = vi.fn();` before `const orch = new Orchestrator({`. Pass `recordUsage,` in the options object (after `agentTunnel,`), and add `recordUsage` to the returned object. Then append next to the "monitor health updates opencode state" test:

```ts
  it("records usage from every monitor under the project's id", async () => {
    const s = await withEnv();
    const main = s.monitors.find((m) => m.opts.envId === project.id)!;
    const env = s.monitors.find((m) => m.opts.envId !== project.id)!;
    main.opts.onRawSessions!([rawSession("a")]);
    env.opts.onRawSessions!([rawSession("b")]);
    expect(s.recordUsage.mock.calls.map(([id, sessions]) => [id, sessions.map((x: { id: string }) => x.id)])).toEqual([
      [project.id, ["a"]],
      [project.id, ["b"]],
    ]);
  });
```

If `rawSession` isn't imported in `orchestrator.test.ts` yet, add `import { rawSession } from "../helpers/fake-opencode";`. If the main monitor's `envId` isn't `project.id`, check `startMonitor` and the existing tests that call `withEnv()`, and pick the two monitors the way those tests do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/monitor.test.ts test/server/orchestrator.test.ts`
Expected: FAIL. `onRawSessions` is never called, and `recordUsage` isn't a known option (a type error, since vitest doesn't typecheck). The orchestrator test fails on `onRawSessions!` being undefined.

- [ ] **Step 3: Implement**

`src/server/monitor.ts`, in `MonitorOptions` after `onSessions`:

```ts
  /** Every poll's sessions as opencode lists them, subagents and archived ones included (for usage tracking). */
  onRawSessions?: (sessions: RawSession[]) => void;
```

In `fetchAndDerive`, right after `this.opts.onHealth(true);`:

```ts
      this.opts.onRawSessions?.(all);
```

`src/server/orchestrator.ts`: change the client import to include `type RawSession`:

```ts
import { type OpencodeClient, type OpencodeEndpoint, type RawSession, isGone, isInvalidAnswer } from "./opencode/client";
```

Add a field to `OrchestratorDeps` (after `credentials?`):

```ts
  /** Books what each poll's sessions spent; skipped when absent (no usage ledger). */
  recordUsage?: (projectId: ProjectId, sessions: RawSession[]) => void;
```

(`ProjectId` is already imported in orchestrator.ts. If not, add it to the `../shared/types` import.) In `startMonitor`, add after the `onSessions` option:

```ts
      onRawSessions: (sessions) => this.deps.recordUsage?.(env.project.id, sessions),
```

`src/server/cli.ts`: import `{ UsageStore, trackUsage } from "./usage"`. After `store.setRoots(config.roots);`:

```ts
  const usage = UsageStore.open(path.join(dir, "usage.db"));
  const usageTracker = usage ? trackUsage(usage, store) : undefined;
```

In the `new Orchestrator({ ... })` options, after `credentials: ...`:

```ts
    ...(usageTracker ? { recordUsage: usageTracker.record } : {}),
```

In `shutdown`, after `stopNotifier();`:

```ts
    usageTracker?.stop();
    usage?.close();
```

- [ ] **Step 4: Run the tests, the typecheck and the build**

Run: `npx vitest run test/server/monitor.test.ts test/server/orchestrator.test.ts && pnpm typecheck && pnpm build && grep -c 'node:sqlite' dist/bin.js`
Expected: the tests pass, the typecheck is clean, the build succeeds, and the count is at least 1. That shows `node:sqlite` stays an external import and isn't bundled.

- [ ] **Step 5: Smoke-test the real binary**

Run: `XDG_CONFIG_HOME=$(mktemp -d) node dist/bin.js --root /nonexistent --no-open & sleep 3; kill %1`
Expected: no "usage tracking is off" warning. The temp config dir now holds `opendevhub/usage.db`. (Check with `ls` before deleting the temp dir. Use the `cli.ts` flags as `--help` lists them if `--root`/`--no-open` differ.)

- [ ] **Step 6: Commit**

```bash
git add src/server/monitor.ts src/server/orchestrator.ts src/server/cli.ts test/server/monitor.test.ts test/server/orchestrator.test.ts
git commit -m "feat: monitors book their sessions' spend into usage.db

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Show the totals in the dashboard

**Files:**
- Create: `src/web/usage.ts`
- Modify: `src/web/pages/Overview.tsx`, `src/web/pages/ProjectOverview.tsx`, `src/web/pages/ProjectTask.tsx`
- Modify: `apps/docs/content/docs/tasks.mdx` (one sentence)
- Test: `test/web/usage.test.ts`

**Interfaces:**
- Consumes: `DashboardSnapshot.usage?: UsageTotals` (Task 4); `formatCost`, `formatTokens` from `src/web/tasks.ts`.
- Produces:
  ```ts
  export function formatUsage(u: Usage): string                                    // "$1.24 · 380.0k tokens"
  export function projectUsage(snapshot: DashboardSnapshot | undefined, projectId: string): { today: Usage; total: Usage } | undefined
  export function taskUsage(snapshot: DashboardSnapshot | undefined, task: string): Usage | undefined
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/web/usage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DashboardSnapshot, UsageTotals } from "../../src/shared/types";
import { formatUsage, projectUsage, taskUsage } from "../../src/web/usage";

const usage: UsageTotals = {
  today: { cost: 1.24, tokens: 380_000 },
  projects: { p: { today: { cost: 0.4, tokens: 1000 }, total: { cost: 12.8, tokens: 2_000_000 } } },
  tasks: { tsk_1: { cost: 2.1, tokens: 610_000 } },
};
const snap = (u?: UsageTotals): DashboardSnapshot => ({ roots: [], preflight: { errors: [] }, editors: [], projects: [], ...(u ? { usage: u } : {}) });

describe("formatUsage", () => {
  it("joins cost and tokens", () => {
    expect(formatUsage({ cost: 1.24, tokens: 380_000 })).toBe("$1.24 · 380.0k tokens");
    expect(formatUsage({ cost: 0, tokens: 0 })).toBe("$0.00 · 0 tokens");
  });
});

describe("projectUsage", () => {
  it("is undefined without a ledger, zeros for a project with no spend", () => {
    expect(projectUsage(undefined, "p")).toBeUndefined();
    expect(projectUsage(snap(), "p")).toBeUndefined();
    expect(projectUsage(snap(usage), "q")).toEqual({ today: { cost: 0, tokens: 0 }, total: { cost: 0, tokens: 0 } });
    expect(projectUsage(snap(usage), "p")).toEqual(usage.projects.p);
  });
});

describe("taskUsage", () => {
  it("is the task's total, or undefined when it has none", () => {
    expect(taskUsage(snap(usage), "tsk_1")).toEqual({ cost: 2.1, tokens: 610_000 });
    expect(taskUsage(snap(usage), "tsk_2")).toBeUndefined();
    expect(taskUsage(snap(), "tsk_1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/web/usage.test.ts`
Expected: FAIL with a missing-module error for `src/web/usage`.

- [ ] **Step 3: Implement the helpers**

Create `src/web/usage.ts`:

```ts
import type { DashboardSnapshot, Usage } from "../shared/types";
import { formatCost, formatTokens } from "./tasks";

const NONE: Usage = { cost: 0, tokens: 0 };

export function formatUsage(u: Usage): string {
  return `${formatCost(u.cost)} · ${formatTokens(u.tokens)} tokens`;
}

/** A project's spend today and all time; undefined when there's no ledger, zeros when it spent nothing. */
export function projectUsage(snapshot: DashboardSnapshot | undefined, projectId: string): { today: Usage; total: Usage } | undefined {
  if (!snapshot?.usage) return undefined;
  return snapshot.usage.projects[projectId] ?? { today: NONE, total: NONE };
}

/** A task's spend, discarded variants included; undefined when there's no ledger or nothing was booked. */
export function taskUsage(snapshot: DashboardSnapshot | undefined, task: string): Usage | undefined {
  return snapshot?.usage?.tasks[task];
}
```

Run: `npx vitest run test/web/usage.test.ts`
Expected: PASS.

- [ ] **Step 4: Render on the three pages**

`src/web/pages/Overview.tsx`: import `{ formatUsage } from "../usage"`. Replace the `PageHeader`'s `description` prop with:

```tsx
        description={
          <>
            {snapshot.roots.join(" · ") || "No roots configured"}
            {snapshot.usage && <p className="tabular-nums">Today {formatUsage(snapshot.usage.today)}</p>}
          </>
        }
```

`src/web/pages/ProjectOverview.tsx`: import `{ projectUsage } from "../usage"` and add `formatCost, formatTokens` from `"../tasks"`. Change `const { newTask } = useDash();` to `const { newTask, snapshot } = useDash();`, and add `const usage = projectUsage(snapshot, project.id);` after it. Inside the `description`'s outer `<div className="flex flex-col gap-2">`, after the badges `<div>`, add:

```tsx
            {usage && (
              <p
                className="text-xs tabular-nums"
                title={`Tokens today ${formatTokens(usage.today.tokens)} · all time ${formatTokens(usage.total.tokens)}`}
              >
                Today {formatCost(usage.today.cost)} · All time {formatCost(usage.total.cost)}
              </p>
            )}
```

`src/web/pages/ProjectTask.tsx`: import `{ formatUsage, taskUsage } from "../usage"`. Change `const { report } = useDash();` to `const { report, snapshot } = useDash();`, and add `const total = taskUsage(snapshot, task);` after it. In the heading row, replace the muted span with:

```tsx
        <span className={muted}>
          {sessions.length} variant{sessions.length === 1 ? "" : "s"}
          {total && <span className="tabular-nums"> · Total {formatUsage(total)}</span>}
        </span>
```

`apps/docs/content/docs/tasks.mdx`: after the sentence ending "…with a Review link.", add: `Each variant's cost and tokens include its subagents, and the task's total above the cards includes discarded variants.`

- [ ] **Step 5: Check it in the running dashboard**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

Then use the `run` skill (or `pnpm dev` plus `pnpm dev:web`) and open the overview, a project page and a task page. Check that:
- The overview header shows "Today $… · … tokens".
- The project header shows "Today $… · All time $…", with a token tooltip.
- A task page shows "· Total $… · … tokens" after the variant count.
- All three look right in light and dark themes and at phone width.

Take one screenshot of each.

- [ ] **Step 6: Commit**

```bash
git add src/web/usage.ts src/web/pages/Overview.tsx src/web/pages/ProjectOverview.tsx src/web/pages/ProjectTask.tsx test/web/usage.test.ts ../docs/content/docs/tasks.mdx
git commit -m "feat(web): today's spend on the overview, project totals, and task totals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: E2E against a real opencode v2

**Files:**
- Modify: `test/e2e/opendevhub.e2e.ts`

**Interfaces:**
- Consumes: `UsageStore.open`, `trackUsage` (Tasks 3–4); `OrchestratorDeps.recordUsage` (Task 5).

- [ ] **Step 1: Wire the ledger into the e2e orchestrator**

In `test/e2e/opendevhub.e2e.ts`, import `{ UsageStore, trackUsage } from "../../src/server/usage"`. Before `const orch = new Orchestrator({`, add:

```ts
    const usage = UsageStore.open(":memory:")!;
    const usageTracker = trackUsage(usage, store);
```

Add `recordUsage: usageTracker.record,` to the `Orchestrator` options. Add `usageTracker.stop(); usage.close();` next to the test's other cleanup (where it stops the orchestrator).

- [ ] **Step 2: Assert on the real session**

Right after the existing `vi.waitFor` that sees `"e2e session"` in the snapshot's sessions, add:

```ts
    // Real opencode v2 sessions carry the cost and tokens fields the ledger reads (zero before any prompt).
    const e2eSession = store.snapshot().projects[0].sessions.find((s) => s.title === "e2e session")!;
    expect(typeof (e2eSession.cost ?? 0)).toBe("number");
    expect(store.snapshot().usage).toMatchObject({ today: { cost: expect.any(Number), tokens: expect.any(Number) } });
```

- [ ] **Step 3: Run the e2e suite**

Run: `pnpm test:e2e -- test/e2e/opendevhub.e2e.ts`
Expected: PASS. (It needs Docker and the devcontainer CLI. If the environment can't run it, report that rather than skipping silently.)

- [ ] **Step 4: Commit**

```bash
git add test/e2e/opendevhub.e2e.ts
git commit -m "test: e2e for usage totals against a real opencode v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Update the backlog**

In `docs/superpowers/backlog.md`, remove the "Cost and token tracking" bullet under Medium. Add "usage tracking" to the "Specced so far" list in the intro. Commit:

```bash
git add ../../docs/superpowers/backlog.md
git commit -m "docs: backlog drops cost and token tracking, now shipped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
