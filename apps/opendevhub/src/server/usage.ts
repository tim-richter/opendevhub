import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ProjectId, Usage, UsageTotals } from "../shared/types";
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
