import type { SessionSummary } from "../shared/types";
import type { OpencodeClient } from "./opencode/client";
import { deriveSessions } from "./status";

export interface MonitorOptions {
  client: OpencodeClient;
  projectId: string;
  directory: string;
  onSessions: (sessions: SessionSummary[]) => void;
  onHealth: (healthy: boolean) => void;
  pollMs?: number;
  debounceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const RELEVANT_EVENT = /^(session|permission|form)\./;
const FAILURES_BEFORE_UNHEALTHY = 3;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class Monitor {
  private readonly abort = new AbortController();
  private pollTimer?: ReturnType<typeof setInterval>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private stopped = false;
  private inFlight?: Promise<void>;
  private rerun = false;

  constructor(private readonly opts: MonitorOptions) {}

  start(): void {
    void this.reconcile();
    this.pollTimer = setInterval(() => void this.reconcile(), this.opts.pollMs ?? 5000);
    void this.streamLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
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
    const { client, directory, projectId } = this.opts;
    try {
      const [sessions, active, permissions, forms] = await Promise.all([
        client.sessions(),
        client.active(),
        client.permissionRequests(directory),
        client.forms(directory),
      ]);
      if (this.stopped) return;
      this.failures = 0;
      this.opts.onHealth(true);
      this.opts.onSessions(deriveSessions(projectId, { sessions, active, permissions, forms }));
    } catch {
      if (this.stopped) return;
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_UNHEALTHY) this.opts.onHealth(false);
    }
  }

  private schedule(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.reconcile(), this.opts.debounceMs ?? 250);
  }

  private async streamLoop(): Promise<void> {
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    let backoff = min;
    while (!this.stopped) {
      try {
        await this.opts.client.subscribe((event) => {
          backoff = min;
          if (RELEVANT_EVENT.test(event.type)) this.schedule();
        }, this.abort.signal);
      } catch {
        // connection failed or dropped; retry below
      }
      if (this.stopped) return;
      await sleep(backoff, this.abort.signal);
      backoff = Math.min(backoff * 2, max);
    }
  }
}
