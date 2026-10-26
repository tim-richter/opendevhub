import type { ProjectId, ProjectRuntime } from "../../shared/types";

/** How old a fetch may be before reading a base's position fetches again. Starting a task always fetches. */
export const FETCH_MAX_AGE_MS = 5 * 60_000;

export interface FreshnessDeps {
  store: {
    runtime: (id: ProjectId) => Pick<ProjectRuntime, "lastFetch">;
    updateRuntime: (id: ProjectId, patch: Partial<ProjectRuntime>) => void;
  };
  /** Fetches `remote` in the project's main checkout; throws when it fails. */
  fetch: (id: ProjectId, remote: string) => Promise<void>;
  now?: () => number;
}

/**
 * When each project's main checkout last fetched, and fetching only when that is too old. A project runs at most one
 * fetch at a time: a caller arriving while one of the same remote runs waits for it instead of starting another.
 */
export class BaseFreshness {
  private readonly deps: FreshnessDeps;
  private readonly running = new Map<
    ProjectId,
    { remote: string; done: Promise<void> }
  >();
  constructor(deps: FreshnessDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Records a successful fetch made elsewhere (cleanup's), so it counts towards freshness. */
  record(id: ProjectId, remote: string): void {
    this.deps.store.updateRuntime(id, {
      lastFetch: { at: this.now(), remote },
    });
  }

  /** The last successful fetch of `remote`, when the last fetch was of it. */
  lastFetchAt(id: ProjectId, remote: string): number | undefined {
    const last = this.deps.store.runtime(id).lastFetch;
    return last?.remote === remote ? last.at : undefined;
  }

  /**
   * Fetches `remote` unless it was fetched less than `maxAgeMs` ago (`force` fetches anyway), and resolves to when it
   * was last fetched. Throws the fetch's error.
   */
  async ensureFresh(
    id: ProjectId,
    remote: string,
    opts: { force?: boolean; maxAgeMs?: number } = {}
  ): Promise<number | undefined> {
    const { force = false, maxAgeMs = FETCH_MAX_AGE_MS } = opts;
    const last = this.lastFetchAt(id, remote);
    if (!force && last !== undefined && this.now() - last < maxAgeMs) {
      return last;
    }
    let current = this.running.get(id);
    while (current && current.remote !== remote) {
      await current.done.catch(() => undefined);
      current = this.running.get(id);
    }
    if (current) {
      await current.done;
      return this.lastFetchAt(id, remote);
    }
    const done = this.deps
      .fetch(id, remote)
      .then(() => this.record(id, remote))
      .finally(() => this.running.delete(id));
    this.running.set(id, { done, remote });
    await done;
    return this.lastFetchAt(id, remote);
  }
}
