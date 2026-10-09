import type { SessionSummary } from "../shared/types";
import type { OpencodeClient, RawSession } from "./opencode/client";
import { contextOf, deriveSessions } from "./status";

export interface MonitorOptions {
  client: OpencodeClient;
  projectId: string;
  /** Copied onto every session it reports. */
  envId?: string;
  directory: string;
  /** Other checkouts (worktrees) whose permission requests and questions should be watched too. */
  extraDirectories?: () => string[];
  onSessions: (sessions: SessionSummary[]) => void;
  /** Every poll's sessions as opencode lists them, subagents and archived ones included (for usage tracking). */
  onRawSessions?: (sessions: RawSession[]) => void;
  onHealth: (healthy: boolean) => void;
  pollMs?: number;
  debounceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Clock for stamping when a pending item was first seen; tests pass their own. */
  now?: () => number;
}

const RELEVANT_EVENT = /^(?<g1>session|permission|form)\./u;
const FAILURES_BEFORE_UNHEALTHY = 3;
const MAX_SESSION_LOOKUPS = 20;
const MAX_DIRECTORIES = 16;
const MAX_CONTEXT_LOOKUPS = 20;
/** The newest assistant message with usage is nearly always among a session's last few (a streaming one has none yet). */
const CONTEXT_MESSAGES = 5;

const uniqueById = <T extends { id: string }>(items: T[]): T[] => [
  ...new Map(items.map((i) => [i.id, i])).values(),
];

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class Monitor {
  private readonly abort = new AbortController();
  private pollTimer?: ReturnType<typeof setInterval>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private stopped = false;
  private inFlight?: Promise<void>;
  private rerun = false;
  private readonly firstSeen = new Map<string, number>();
  /** Each root session's context size, as of the `updatedAt` it was read at. */
  private readonly contexts = new Map<
    string,
    { updatedAt: number; tokens?: number }
  >();

  private readonly opts: MonitorOptions;
  constructor(opts: MonitorOptions) {
    this.opts = opts;
  }

  start(): void {
    void this.reconcile();
    this.pollTimer = setInterval(
      () => void this.reconcile(),
      this.opts.pollMs ?? 5000
    );
    void this.streamLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
  }

  reconcile(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = this.fetchAndDerive().finally(() => {
      this.inFlight = undefined;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        void this.reconcile();
      }
    });
    return this.inFlight;
  }

  private async fetchAndDerive(): Promise<void> {
    const { client, projectId } = this.opts;
    try {
      const [sessions, active] = await Promise.all([
        client.sessions(),
        client.active(),
      ]);
      // Per-directory lookups are best effort: opencode answers 500 for a directory missing in the
      // container (e.g. a stale worktree), and that must not mark the whole server unhealthy.
      const perDirectory = await Promise.all(
        this.directories(sessions).map((d) =>
          Promise.all([
            client.permissionRequests(d).catch(() => []),
            client.forms(d).catch(() => []),
          ])
        )
      );
      const permissions = uniqueById(perDirectory.flatMap(([p]) => p));
      const forms = uniqueById(perDirectory.flatMap(([, f]) => f));
      this.stamp([...permissions, ...forms].map((i) => i.id));
      const flagged = [
        ...active,
        ...permissions.map((p) => p.sessionID),
        ...forms.map((f) => f.sessionID),
      ];
      const all = await this.withMissing(sessions, flagged);
      const contexts = await this.contextsOf(all);
      if (this.stopped) {
        return;
      }
      this.failures = 0;
      this.opts.onHealth(true);
      this.opts.onRawSessions?.(all);
      this.opts.onSessions(
        deriveSessions(projectId, {
          active,
          contexts,
          envId: this.opts.envId,
          firstSeen: this.firstSeen,
          forms,
          permissions,
          sessions: all,
        })
      );
    } catch {
      if (this.stopped) {
        return;
      }
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_UNHEALTHY) {
        this.opts.onHealth(false);
      }
    }
  }

  /** Remembers when each pending item first showed up, so the dashboard can list them oldest first. */
  private stamp(ids: string[]): void {
    const now = (this.opts.now ?? Date.now)();
    const current = new Set(ids);
    for (const id of this.firstSeen.keys()) {
      if (!current.has(id)) {
        this.firstSeen.delete(id);
      }
    }
    for (const id of current) {
      if (!this.firstSeen.has(id)) {
        this.firstSeen.set(id, now);
      }
    }
  }

  /**
   * Each root session's context size. Only sessions updated since they were last read are read again, newest
   * first and at most `MAX_CONTEXT_LOOKUPS` a poll; a failed read is best effort and retried next poll.
   */
  private async contextsOf(
    sessions: RawSession[]
  ): Promise<Map<string, number>> {
    const roots = sessions.filter(
      (s) => !s.parentID && s.time.archived === undefined
    );
    const listed = new Set(roots.map((s) => s.id));
    for (const id of this.contexts.keys()) {
      if (!listed.has(id)) {
        this.contexts.delete(id);
      }
    }
    const stale = roots
      .filter((s) => this.contexts.get(s.id)?.updatedAt !== s.time.updated)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, MAX_CONTEXT_LOOKUPS);
    await Promise.all(
      stale.map(async (s) => {
        const messages = await this.opts.client
          .messages(s.id, CONTEXT_MESSAGES)
          .catch(() => undefined);
        if (messages) {
          this.contexts.set(s.id, {
            tokens: contextOf(messages),
            updatedAt: s.time.updated,
          });
        }
      })
    );
    return new Map(
      [...this.contexts].flatMap(([id, c]) =>
        c.tokens === undefined ? [] : [[id, c.tokens] as const]
      )
    );
  }

  /**
   * Permission requests and questions are listed per directory, so a session working in a worktree is
   * only seen when its directory is asked about. Ask for the workspace, the known worktrees and the
   * directories of the most recently updated sessions.
   */
  private directories(sessions: RawSession[]): string[] {
    const dirs = new Set([
      this.opts.directory,
      ...(this.opts.extraDirectories?.() ?? []),
    ]);
    const recent = sessions
      .filter((s) => s.time.archived === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated);
    for (const s of recent) {
      if (dirs.size >= MAX_DIRECTORIES) {
        break;
      }
      dirs.add(s.location.directory);
    }
    return [...dirs].slice(0, MAX_DIRECTORIES);
  }

  /**
   * `/api/session` returns only the newest 50 sessions, subagents included, so a session waiting on
   * input (or its root) can fall outside it. Fetch those individually so their status isn't dropped.
   */
  private async withMissing(
    sessions: RawSession[],
    flagged: string[]
  ): Promise<RawSession[]> {
    const known = new Map(sessions.map((s) => [s.id, s]));
    let lookups = 0;
    for (const start of new Set(flagged)) {
      const seen = new Set<string>();
      let id: string | undefined = start;
      while (id && !seen.has(id)) {
        seen.add(id);
        let session = known.get(id);
        if (!session) {
          if (lookups++ >= MAX_SESSION_LOOKUPS) {
            break;
          }
          session = await this.opts.client.session(id).catch(() => undefined);
          if (!session) {
            break;
          }
          known.set(id, session);
        }
        id = session.parentID;
      }
    }
    return known.size === sessions.length ? sessions : [...known.values()];
  }

  private schedule(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => void this.reconcile(),
      this.opts.debounceMs ?? 250
    );
  }

  private async streamLoop(): Promise<void> {
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    let backoff = min;
    while (!this.stopped) {
      try {
        await this.opts.client.subscribe((event) => {
          backoff = min;
          if (RELEVANT_EVENT.test(event.type)) {
            this.schedule();
          }
        }, this.abort.signal);
      } catch {
        // connection failed or dropped; retry below
      }
      if (this.stopped) {
        return;
      }
      await sleep(backoff, this.abort.signal);
      backoff = Math.min(backoff * 2, max);
    }
  }
}
