import type {
  ConfigApprovalChange,
  ConfigApprovalSource,
  PendingConfigApproval,
  ProjectId,
} from "../../shared/types";
import type { Db } from "../db/database";
import { ConflictError } from "../errors";
import { canonicalJson, fingerprint } from "./config-surface";
import type { HostSurface } from "./config-surface";

/** A container start that needs the user to approve its config's host-affecting settings first. */
export class ApprovalRequiredError extends ConflictError {
  readonly fingerprint: string;
  constructor(pending: PendingConfigApproval) {
    super(
      `its devcontainer config changes host-affecting settings (${pending.changes
        .filter((c) => c.kind !== "unchanged")
        .map((c) => c.key)
        .join(", ")}): review and approve them on the project's banner`
    );
    this.name = "ApprovalRequiredError";
    this.fingerprint = pending.fingerprint;
  }
}

/** The user kept a container's config stopped. */
export class NotApprovedError extends Error {
  constructor() {
    super("its container config was not approved");
    this.name = "NotApprovedError";
  }
}

export type WaitOutcome = "approved" | "refused" | "cancelled";

interface Approved {
  surface: HostSurface;
  approvedAt: number;
}

interface Waiter {
  project: ProjectId;
  fingerprint: string;
  cancelled: () => boolean;
  settle: (outcome: WaitOutcome) => void;
}

/** A stable key per checkout, so a checkout that checks again replaces its earlier pending approval. */
const sourceKey = (source: ConfigApprovalSource): string =>
  source.kind === "main" ? "main" : `env:${source.envId}`;

/** Each top-level setting of `next` against `prev`: added, changed, removed or unchanged. */
export const diffSurfaces = (
  prev: HostSurface,
  next: HostSurface
): ConfigApprovalChange[] =>
  [...new Set([...Object.keys(next), ...Object.keys(prev)])]
    .toSorted()
    .map((key): ConfigApprovalChange => {
      const inNext = key in next;
      const inPrev = key in prev;
      if (!inPrev) {
        return { after: next[key], key, kind: "added" };
      }
      if (!inNext) {
        return { before: prev[key], key, kind: "removed" };
      }
      return canonicalJson(prev[key]) === canonicalJson(next[key])
        ? { after: next[key], before: prev[key], key, kind: "unchanged" }
        : { after: next[key], before: prev[key], key, kind: "changed" };
    });

const differing = (changes: ConfigApprovalChange[]): number =>
  changes.filter((c) => c.kind !== "unchanged").length;

/**
 * The host-affecting settings the user approved per project (in the state database), the ones waiting for approval
 * (in memory: a restart fails waiting variants, and a start asks again), and who waits for them.
 */
export class ConfigApprovals {
  private readonly pendings = new Map<
    ProjectId,
    Map<string, PendingConfigApproval>
  >();
  private readonly waiters = new Set<Waiter>();
  /** Starts that failed for want of an approval, run again once it is given; keyed per checkout. */
  private readonly retries = new Map<string, Map<string, () => void>>();
  private readonly listeners = new Set<() => void>();

  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * Re-evaluates every waiter's `cancelled`; called on every task change (`TaskStore.subscribe`), so a pick or
   * dismissal ends a wait at once.
   */
  recheckCancelled(): void {
    for (const w of this.waiters) {
      if (w.cancelled()) {
        this.settle(w, "cancelled");
      }
    }
  }

  /** `ok`, or the pending approval the settings need; recording it replaces the checkout's earlier one. */
  check(
    project: ProjectId,
    surface: HostSurface,
    source: ConfigApprovalSource,
    mergedError?: string
  ): { ok: true } | { ok: false; pending: PendingConfigApproval } {
    const fp = fingerprint(surface);
    if (Object.keys(surface).length === 0 || this.isApproved(project, fp)) {
      this.dropSource(project, sourceKey(source));
      return { ok: true };
    }
    this.dropSource(project, sourceKey(source), fp);
    const list = this.pendingMap(project);
    const existing = list.get(fp);
    if (existing) {
      if (!existing.sources.some((s) => sourceKey(s) === sourceKey(source))) {
        existing.sources = [...existing.sources, source];
        this.emit();
      }
      return { ok: false, pending: existing };
    }
    const approved = this.approved(project);
    let closest: Approved | undefined;
    let closestChanges: ConfigApprovalChange[] | undefined;
    for (const a of approved) {
      const changes = diffSurfaces(a.surface, surface);
      // Fewest differing settings; `approved` is newest first, so the newest wins ties.
      if (!closestChanges || differing(changes) < differing(closestChanges)) {
        closest = a;
        closestChanges = changes;
      }
    }
    const pending: PendingConfigApproval = {
      at: this.now(),
      changes: closestChanges ?? diffSurfaces({}, surface),
      first: !closest,
      fingerprint: fp,
      sources: [source],
      surface,
      ...(mergedError ? { mergedError } : {}),
    };
    list.set(fp, pending);
    this.emit();
    return { ok: false, pending };
  }

  /** Takes a checkout off the pending approvals, e.g. once its variant is discarded or its container removed. */
  forget(project: ProjectId, source: ConfigApprovalSource): void {
    this.dropSource(project, sourceKey(source));
  }

  /** The project's pending approvals, oldest first. */
  pending(project: ProjectId): PendingConfigApproval[] {
    return [...(this.pendings.get(project)?.values() ?? [])].toSorted(
      (a, b) => a.at - b.at
    );
  }

  pendingOf(project: ProjectId, fp: string): PendingConfigApproval | undefined {
    return this.pendings.get(project)?.get(fp);
  }

  /**
   * Records exactly the pending settings `fp`, wakes their waiters and runs the starts they blocked. Throws a
   * ConflictError when `fp` is no longer pending (the config changed again, or it was answered).
   */
  approve(project: ProjectId, fp: string): void {
    const pending = this.requirePending(project, fp);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO config_approvals (project_id, fingerprint, surface, approved_at) VALUES (?, ?, ?, ?)"
      )
      .run(project, fp, JSON.stringify(pending.surface), this.now());
    this.pendings.get(project)?.delete(fp);
    const retries = this.retries.get(`${project}\0${fp}`);
    this.retries.delete(`${project}\0${fp}`);
    this.wake(project, fp, "approved");
    this.emit();
    for (const retry of retries?.values() ?? []) {
      retry();
    }
  }

  /** Keep stopped: clears the pending settings without recording them; their waiters fail. */
  refuse(project: ProjectId, fp: string): void {
    this.requirePending(project, fp);
    this.pendings.get(project)?.delete(fp);
    this.retries.delete(`${project}\0${fp}`);
    this.wake(project, fp, "refused");
    this.emit();
  }

  /** Settles once `fp` is approved or refused, or `cancelled()` turns true. */
  wait(
    project: ProjectId,
    fp: string,
    cancelled: () => boolean
  ): Promise<WaitOutcome> {
    if (cancelled()) {
      return Promise.resolve("cancelled");
    }
    if (this.isApproved(project, fp)) {
      return Promise.resolve("approved");
    }
    if (!this.pendingOf(project, fp)) {
      return Promise.resolve("refused");
    }
    return new Promise((resolve) => {
      this.waiters.add({
        cancelled,
        fingerprint: fp,
        project,
        settle: resolve,
      });
    });
  }

  /** Runs `retry` once `fp` is approved; a later failure of the same checkout replaces it. */
  retryOnApprove(
    project: ProjectId,
    fp: string,
    source: ConfigApprovalSource,
    retry: () => void
  ): void {
    const key = `${project}\0${fp}`;
    const map = this.retries.get(key) ?? new Map<string, () => void>();
    map.set(sourceKey(source), retry);
    this.retries.set(key, map);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The project's approved settings, newest first. */
  approved(project: ProjectId): Approved[] {
    return (
      this.db
        .prepare(
          "SELECT surface, approved_at FROM config_approvals WHERE project_id = ? ORDER BY approved_at DESC, id DESC"
        )
        .all(project) as { surface: string; approved_at: number }[]
    ).map((r) => ({
      approvedAt: r.approved_at,
      surface: JSON.parse(r.surface) as HostSurface,
    }));
  }

  private isApproved(project: ProjectId, fp: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM config_approvals WHERE project_id = ? AND fingerprint = ?"
        )
        .get(project, fp) !== undefined
    );
  }

  private requirePending(
    project: ProjectId,
    fp: string
  ): PendingConfigApproval {
    const pending = this.pendingOf(project, fp);
    if (!pending) {
      throw new ConflictError(
        "these settings are no longer pending: the config changed or was answered; review it again"
      );
    }
    return pending;
  }

  private pendingMap(project: ProjectId): Map<string, PendingConfigApproval> {
    let map = this.pendings.get(project);
    if (!map) {
      map = new Map();
      this.pendings.set(project, map);
    }
    return map;
  }

  /** Removes a checkout from the project's pending approvals other than `keep`; one left without checkouts goes. */
  private dropSource(project: ProjectId, key: string, keep?: string): void {
    const map = this.pendings.get(project);
    let changed = false;
    for (const [fp, p] of map ?? []) {
      if (fp === keep || !p.sources.some((s) => sourceKey(s) === key)) {
        continue;
      }
      p.sources = p.sources.filter((s) => sourceKey(s) !== key);
      changed = true;
      if (p.sources.length === 0 && !this.hasWaiters(project, fp)) {
        map?.delete(fp);
      }
    }
    if (changed) {
      this.emit();
    }
  }

  private hasWaiters(project: ProjectId, fp: string): boolean {
    return [...this.waiters].some(
      (w) => w.project === project && w.fingerprint === fp
    );
  }

  private wake(project: ProjectId, fp: string, outcome: WaitOutcome): void {
    for (const w of this.waiters) {
      if (w.project === project && w.fingerprint === fp) {
        this.settle(w, outcome);
      }
    }
  }

  private settle(w: Waiter, outcome: WaitOutcome): void {
    this.waiters.delete(w);
    w.settle(outcome);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }
}
