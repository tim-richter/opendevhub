import { baseSkipText } from "../../shared/base-position";
import { DEFAULT_PREFERENCES } from "../../shared/types";
import type { BasePosition, Project, ProjectId } from "../../shared/types";
import type { Environments } from "../environments/environments";
import type { HubDeps } from "../environments/ports";
import { UnavailableError } from "../errors";
import { BaseFreshness } from "./freshness";
import { InvalidRequestError, validateBranch } from "./worktrees";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ago = (at: number | undefined, now: number): string => {
  if (at === undefined) {
    return "never";
  }
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  return minutes < 60
    ? `${minutes} min ago`
    : `${Math.round(minutes / 60)} h ago`;
};

interface ReadOptions {
  /** Fetch even when the last fetch is recent. */
  force?: boolean;
  /** Fast-forward the base when that's safe, rather than only saying whether it would. */
  apply?: boolean;
  /** Apply even with the setting off (an explicit Pull). */
  ignoreSetting?: boolean;
  branch?: string;
}

/**
 * The main checkout's base branch next to its upstream: reading where it stands for the new task dialog and the
 * task page, the rail's Pull, and bringing it up to date before a task's worktrees are made from it.
 */
export class BasePositions {
  readonly freshness: BaseFreshness;
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  constructor(deps: HubDeps, envs: Environments, freshness?: BaseFreshness) {
    this.deps = deps;
    this.envs = envs;
    this.freshness =
      freshness ??
      new BaseFreshness({
        fetch: (id, remote) => {
          const p = envs.requireProject(id);
          return deps.git.fetchPrune(p, envs.workspaceFolder(p), remote);
        },
        store: deps.store,
        ...(deps.now ? { now: deps.now } : {}),
      });
  }

  private enabled(): boolean {
    return (this.deps.preferences?.() ?? DEFAULT_PREFERENCES)
      .updateBaseBeforeTask;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The base asked for, else the main checkout's branch; undefined on a detached main checkout. */
  private async baseOf(
    p: Project,
    ws: string,
    requested: string | undefined
  ): Promise<string | undefined> {
    const base =
      requested?.trim() || (await this.deps.git.currentBranch(p, ws));
    return base ? validateBranch(base) : undefined;
  }

  /** Fetches the base's remote (unless that was recent), then says what bringing the base up to date does, or does it. */
  private async read(
    p: Project,
    ws: string,
    base: string,
    opts: ReadOptions
  ): Promise<BasePosition> {
    const { git } = this.deps;
    const upstream = await git.baseUpstream(p, ws, base);
    const remotes = upstream?.remote ? [] : await git.remotes(p, ws);
    const remote =
      upstream?.remote ?? (remotes.includes("origin") ? "origin" : remotes[0]);
    let fetchError: string | undefined;
    if (remote) {
      try {
        await this.freshness.ensureFresh(p.id, remote, {
          force: opts.force === true,
        });
      } catch (error) {
        fetchError = message(error);
      }
    }
    const enabled = opts.ignoreSetting === true || this.enabled();
    const state = await git.updateBase(p, ws, base, {
      dryRun: opts.apply !== true || !enabled || fetchError !== undefined,
    });
    let { update } = state;
    if (fetchError !== undefined && update.kind !== "skip") {
      update = { kind: "skip", reason: "fetch-failed" };
    } else if (!enabled && update.kind === "ff") {
      update = { kind: "skip", reason: "disabled" };
    }
    const lastFetchAt = remote
      ? this.freshness.lastFetchAt(p.id, remote)
      : undefined;
    const branch =
      opts.branch && state.upstream
        ? await git
            .branchVsUpstream(
              p,
              ws,
              opts.branch,
              `refs/remotes/${state.upstream}`
            )
            .catch(() => undefined)
        : undefined;
    return {
      ...state,
      base,
      ...(state.remote || !remote ? {} : { remote }),
      update,
      ...(lastFetchAt === undefined ? {} : { lastFetchAt }),
      ...(fetchError === undefined ? {} : { fetchError }),
      ...(branch
        ? { branchAhead: branch.ahead, sinceBranch: branch.behind }
        : {}),
    };
  }

  private running(id: ProjectId): Project {
    const p = this.envs.requireProject(id);
    if (this.deps.store.runtime(id).containerState !== "running") {
      throw new UnavailableError(
        "the container is not running — start the project first"
      );
    }
    return p;
  }

  /**
   * Where `base` (or the main checkout's branch) stands against its upstream, fetching first when the last fetch is
   * older than five minutes or `fetch` asks for one; with `branch`, also how far the upstream moved since it was made.
   */
  async position(
    id: ProjectId,
    requested: string | undefined,
    opts: { branch?: string; fetch?: boolean } = {}
  ): Promise<BasePosition> {
    const p = this.running(id);
    const ws = this.envs.workspaceFolder(p);
    const base = await this.baseOf(p, ws, requested);
    if (!base) {
      throw new InvalidRequestError(
        "the main checkout is on a detached HEAD; name a base branch"
      );
    }
    return this.read(p, ws, base, {
      force: opts.fetch === true,
      ...(opts.branch ? { branch: validateBranch(opts.branch) } : {}),
    });
  }

  /** Fast-forwards the base to its upstream when that's safe, whatever the setting, and says where it stands now. */
  pull(
    id: ProjectId,
    requested: string | undefined,
    opts: { branch?: string } = {}
  ): Promise<BasePosition> {
    return this.envs.withGit(id, async (p) => {
      const ws = this.envs.workspaceFolder(p);
      const base = await this.baseOf(p, ws, requested);
      if (!base) {
        throw new InvalidRequestError(
          "the main checkout is on a detached HEAD; name a base branch"
        );
      }
      const done = await this.read(p, ws, base, {
        apply: true,
        ignoreSetting: true,
      });
      if (done.update.kind === "ff") {
        this.envs.log(
          id,
          `pull: fast-forwarded ${base} to ${done.upstream} (${done.update.commits} commit${done.update.commits === 1 ? "" : "s"})`
        );
      }
      return this.read(
        p,
        ws,
        base,
        opts.branch ? { branch: validateBranch(opts.branch) } : {}
      );
    });
  }

  /**
   * Before a task's worktrees are made: always fetches, then fast-forwards the base when the setting is on and that's
   * safe. Never fails; says why the task starts from the local base as it is, if it does. Runs under the git lock.
   */
  async beforeTask(
    p: Project,
    ws: string,
    requested: string | undefined,
    label: string
  ): Promise<{ notice?: string }> {
    let base: string | undefined;
    try {
      base = await this.baseOf(p, ws, requested);
      if (!base) {
        return {};
      }
      const done = await this.read(p, ws, base, { apply: true, force: true });
      const { update, upstream } = done;
      if (update.kind === "ff") {
        this.envs.log(
          p.id,
          `${label}: fast-forwarded ${base} to ${upstream} (${update.commits} commit${update.commits === 1 ? "" : "s"})`
        );
        return {};
      }
      if (update.kind === "up-to-date") {
        return {};
      }
      const why = baseSkipText(update.reason, base, done.remote);
      const detail =
        update.reason === "fetch-failed"
          ? ` (${done.fetchError}); last fetched ${ago(done.lastFetchAt, this.now())}`
          : "";
      this.envs.log(p.id, `${label}: ${base} wasn't updated: ${why}${detail}`);
      if (update.reason === "disabled") {
        return {};
      }
      return {
        notice: `started from local ${base}, which wasn't updated: ${why}`,
      };
    } catch (error) {
      const name = base ?? requested ?? "the base";
      this.envs.log(
        p.id,
        `${label}: ${name} wasn't updated: ${message(error)}`
      );
      return {
        notice: `started from local ${name}, which wasn't updated: ${message(error)}`,
      };
    }
  }
}
