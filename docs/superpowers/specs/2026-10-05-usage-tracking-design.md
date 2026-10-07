# Usage tracking: cost and tokens per session, task, project and day

Date: 2026-10-05 Status: Draft for review Backlog item: "Cost and token tracking" (Medium).

## Problem

opencode reports `cost` (USD) and `tokens` on each session, and `deriveSessions` in `src/server/status.ts` copies them onto `SessionSummary`. The task page shows them per variant. That is all there is:

- **Subagents are missing.** A subagent runs in a child session (`parentID`), with its own cost. `deriveSessions` drops child sessions, so a variant's cost leaves out everything its subagents spent.
- **Nothing adds up.** There is no total for a task, a project or a day.
- **Spend disappears.** Archived sessions, discarded task variants and sessions in a removed task container leave the snapshot, and their cost goes with them.

The goal is glanceable awareness: "what did this task / project cost, and what did today cost?" Not budgets, not reporting.

## Scope

In:

- A variant's cost and tokens include its subagents.
- Totals per task, per project (today and all time), and for today across all projects.
- Totals survive archive, discard, container removal and opendevhub restarts.

Out: budgets and limits, charts and history views, breakdowns by model or provider, export, pricing that opencode doesn't report (opencode's `cost` is the only source of truth).

### Success criteria

- A task page shows the task's total cost and tokens, and each variant card includes subagents.
- A project page shows the project's cost today and all time.
- The overview shows today's cost and tokens across all projects.
- Discarding a variant or removing its container leaves the task, project and daily totals unchanged.
- Restarting opendevhub leaves all totals unchanged and books nothing twice.
- If the usage database can't be opened, the dashboard works and shows no totals; the log says why.

## Approach

opendevhub keeps its own ledger. The monitor already fetches every session of an environment every 5 seconds (and on events). Each time, the ledger compares each root session's cost and tokens with the last values it saw and books the increase to a day. Totals are then sums over the ledger.

Considered and rejected:

- **Live sums only**, with "today" from opencode's `/api/experimental/session/stats`. Spend still vanishes with discarded sessions, and the endpoint is experimental and absent from opencode 1.x.
- **A JSON file** for the ledger. It would be rewritten up to every 5 seconds while sessions run, and totals would need hand-written bookkeeping. SQLite makes each write a row upsert and each total a query.

### Storage: `node:sqlite`

The ledger is `usage.db` in the config directory (`configDir()`, next to `state.json`), opened with Node's built-in `node:sqlite` (`DatabaseSync`). No dependency and no native build, so `npx opendevhub` keeps working. `node:sqlite` is unflagged from Node 22.13, so:

- `engines.node` in `apps/opendevhub/package.json` goes from `>=20` to `>=22.13`.
- The tsup `target` goes from `node20` to `node22`.

Node 20 reached end of life in April 2026. `state.json` is unchanged.

The database runs in WAL mode. Schema (version 1, recorded in `PRAGMA user_version`):

```sql
-- The last values seen per root session, subagents included.
CREATE TABLE seen (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task       TEXT,             -- TaskMeta.task, or NULL
  cost       REAL NOT NULL,
  tokens     INTEGER NOT NULL
);

-- What was booked, per session per local day.
CREATE TABLE usage (
  day        TEXT NOT NULL,    -- YYYY-MM-DD in the server's local time zone
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task       TEXT,
  cost       REAL NOT NULL,
  tokens     INTEGER NOT NULL,
  PRIMARY KEY (day, session_id)
);
CREATE INDEX usage_project ON usage (project_id, day);
CREATE INDEX usage_task ON usage (task) WHERE task IS NOT NULL;
```

Rows are kept forever; at one row per session per day the file stays small.

## Server

### Rolling up subagents (`src/server/status.ts`)

A new exported `rollUp(sessions: RawSession[]): Map<string, { cost: number; tokens: number }>` adds each session's cost and tokens into its root, using the existing `rootOf`. Tokens are input + output + reasoning, as `tokensOf` counts them today (cache reads and writes stay out). `deriveSessions` uses it, so `SessionSummary.cost` and `tokens` include subagents. Archived roots and their children are still rolled up; filtering happens afterwards, as today. A child whose parent is missing from the list is its own root, as `rootOf` already treats it.

### Booking (`src/server/usage.ts`)

A pure function does the arithmetic:

```ts
interface Observed {
  sessionId: string;
  projectId: ProjectId;
  task?: string;
  cost: number;
  tokens: number;
  updatedAt: number;
}
interface Seen {
  cost: number;
  tokens: number;
}
interface Booking {
  day: string;
  sessionId: string;
  projectId: ProjectId;
  task?: string;
  cost: number;
  tokens: number;
}

function book(observed: Observed[], seen: Map<string, Seen>): Booking[];
```

For each observed root session:

- **Increase:** book `observed − seen` (each of cost and tokens, floored at 0).
- **First sight** (not in `seen`): book its whole cost and tokens. This covers sessions that existed before this feature, and sessions created while opendevhub was stopped.
- **Decrease** (opencode can revert messages): book nothing; the spend happened. `seen` takes the lower value, so later growth is booked from there.
- **No change:** no booking.

The day is the local date of the session's `time.updated`, not of "now". So spend from while opendevhub was stopped lands on the day the session last ran. During normal running the two are the same.

`UsageStore` wraps the database:

- `record(projectId, sessions: RawSession[])`: roll up, build `Observed` for each root (task from `parseTaskMeta`), run `book` against the `seen` rows for those sessions, then in one transaction upsert `seen` and add each booking to its `usage` row (`INSERT ... ON CONFLICT DO UPDATE SET cost = cost + excluded.cost, ...`).
- `totals(today: string): UsageTotals`: three `SUM ... GROUP BY` queries.
- `UsageStore.open(dir)` returns `undefined` and logs once if the database can't be opened or migrated. Callers treat a missing store as "no usage". Tests open `:memory:`.

A session that disappears (archived, discarded, container removed) keeps its `seen` and `usage` rows. If it comes back it is compared with `seen`, so nothing is booked twice.

### Wiring

- `MonitorOptions` gets `onRawSessions?: (sessions: RawSession[]) => void`, called in `fetchAndDerive` with the same list it passes to `deriveSessions`. The orchestrator connects it to `usage.record(env.project.id, sessions)`.
- `record` runs synchronously (it's a few small statements). When it books anything, it tells the `StateStore`, which recomputes totals and notifies listeners, as `setSessions` does.
- `DashboardSnapshot` gets an optional `usage?: UsageTotals` (absent when the store is missing):

```ts
interface Usage {
  cost: number;
  tokens: number;
}
interface UsageTotals {
  today: Usage;
  projects: Record<ProjectId, { today: Usage; total: Usage }>;
  tasks: Record<string, Usage>; // by TaskMeta.task
}
```

"Today" is the server's local date when the snapshot is built. The `StateStore` also recomputes totals when the date changes, so "today" resets at midnight without waiting for new spend.

## Web

All numbers use the existing `formatCost` and `formatTokens` from `src/web/tasks.ts`. When `usage` is absent, nothing below renders.

- **Overview:** a small "Today $1.24 · 380k tokens" line in the page header.
- **Project overview:** "Today $0.40 · All time $12.80" in the project header, with tokens in a tooltip.
- **Task page:** a "Total $2.10 · 610k tokens" line above the variant cards, from `usage.tasks[task]`. It includes discarded variants. The variant cards keep their Cost and Tokens rows, which now include subagents.

## Errors

- The database can't be opened (permissions, a corrupt file, a schema version newer than this build): log once, run without usage, omit `usage` from snapshots.
- A write fails: log and drop that booking. `seen` and `usage` are updated in one transaction, so the next poll retries the same increase.
- A session without `cost` or `tokens` counts as 0.

## Testing

Unit (`test/server/usage.test.ts`, `test/server/status.test.ts`):

- `rollUp` adds children and grandchildren into the root, and ignores a parent cycle.
- `book`: first sight, an increase, no change, a decrease followed by growth, the day taken from `updatedAt` in local time, missing cost or tokens.
- `UsageStore` on `:memory:`: two `record` calls book only the increase; a session missing from the second call keeps its totals; `totals` sums per project, per task and for today; reopening a file-backed store books nothing twice.
- `deriveSessions`: a variant's cost includes its subagents.

E2E (`test/e2e/opendevhub.e2e.ts`): the fake opencode reports a session with a subagent; the overview shows today's total, and the task page shows the task total.
