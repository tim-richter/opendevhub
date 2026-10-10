import type {
  BranchCleanupItem,
  CleanupOutcome,
  EnvId,
  Project,
  ProjectId,
  SessionCleanupItem,
} from "../../shared/types";
import type { Environments } from "../environments/environments";
import type { HubDeps } from "../environments/ports";
import type { Checkouts } from "./checkouts";
import { branchChanged, scanBranches, staleSessions } from "./cleanup";

/** The branches and sessions of one project that cleanup may delete, scanned and deleted through its environments. */
export class CleanupTargets {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  private readonly checkouts: Checkouts;
  constructor(deps: HubDeps, envs: Environments, checkouts: Checkouts) {
    this.deps = deps;
    this.envs = envs;
    this.checkouts = checkouts;
  }

  /** Lists the project's merged and upstream-gone branches, after `git fetch --prune`. */
  cleanupScan(
    id: ProjectId
  ): Promise<{ warning?: string; items: BranchCleanupItem[] }> {
    return this.envs.withGit(id, async (p) => {
      const ws = this.envs.workspaceFolder(p);
      const worktrees = await this.deps.worktrees.list(
        p,
        ws,
        this.deps.store.runtime(id).worktreeRoot
      );
      this.deps.store.updateRuntime(id, { worktrees });
      const envs = this.deps.store.environments(id);
      return scanBranches(this.deps.git, {
        envOf: (dir) => envs.find((e) => e.worktree.path === dir)?.id,
        project: p,
        workspace: ws,
        worktrees,
      });
    });
  }

  /** Deletes a scanned branch with its worktree and that worktree's container, if it still qualifies. */
  cleanupBranch(
    id: ProjectId,
    item: BranchCleanupItem
  ): Promise<CleanupOutcome> {
    return this.envs.withGit(id, async (p) => {
      const ws = this.envs.workspaceFolder(p);
      const root = this.deps.store.runtime(id).worktreeRoot;
      const changed = await branchChanged(
        this.deps.git,
        p,
        ws,
        item,
        await this.deps.worktrees.list(p, ws, root)
      );
      if (changed) {
        return { message: changed, outcome: "skipped" };
      }
      try {
        if (item.worktree) {
          await this.checkouts.dropWorktree(
            p,
            item.worktree,
            item.dirty === true
          );
        }
        // -d is git's own check that it's merged; a branch whose upstream is gone may be squash-merged, which -d refuses.
        await this.deps.git.deleteBranch(
          p,
          ws,
          item.branch,
          item.why === "upstream-gone"
        );
      } finally {
        const list = await this.deps.worktrees
          .list(p, ws, root)
          .catch(() => undefined);
        if (list) {
          this.deps.store.updateRuntime(id, { worktrees: list });
        }
      }
      this.envs.log(
        id,
        `cleanup: deleted branch ${item.branch} (${item.reason})${item.worktree ? " and its worktree" : ""}`
      );
      return { outcome: "removed" };
    });
  }

  /**
   * Lists the sessions cleanup may delete, from the main opencode and each running task environment's. The worktree
   * list is read fresh; when it can't be, no session counts as of a removed worktree.
   */
  async cleanupSessionScan(
    id: ProjectId
  ): Promise<{ warning?: string; items: SessionCleanupItem[] }> {
    const p = this.envs.requireProject(id);
    const ws = this.envs.workspaceFolder(p);
    const worktrees = await this.worktreePaths(p, ws);
    const envs = [
      id,
      ...this.deps.store
        .environments(id)
        .filter(
          (e) => this.deps.store.runtime(e.id).containerState === "running"
        )
        .map((e) => e.id),
    ];
    const warnings: string[] = [];
    const items: SessionCleanupItem[] = [];
    for (const envId of envs) {
      try {
        items.push(...(await this.staleSessionsIn(p, envId, ws, worktrees)));
      } catch (error) {
        warnings.push(
          `could not list ${envId === id ? "" : `${envId}'s `}sessions: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return {
      ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
      items,
    };
  }

  /** Deletes a scanned session, if a fresh scan of its environment still lists it. */
  async cleanupSession(
    id: ProjectId,
    item: SessionCleanupItem
  ): Promise<CleanupOutcome> {
    const p = this.envs.requireProject(id);
    const envId = item.envId ?? id;
    if (
      item.envId &&
      this.deps.store.environment(item.envId)?.projectId !== id
    ) {
      return { message: "changed since scan", outcome: "skipped" };
    }
    const ws = this.envs.workspaceFolder(p);
    const worktrees = await this.worktreePaths(p, ws);
    const result2 = await this.staleSessionsIn(p, envId, ws, worktrees);
    const current = result2.find((i) => i.id === item.id);
    if (!current) {
      return { message: "changed since scan", outcome: "skipped" };
    }
    await this.envs
      .opencodeClient(envId)
      .deleteSession(current.sessionId, current.directory);
    this.envs.log(
      id,
      `cleanup: removed session ${current.title} (${current.reason})`
    );
    this.envs.reconcile(envId);
    return { outcome: "removed" };
  }

  /** Current worktree paths, here and on other nodes, or undefined when git can't list them. */
  private worktreePaths(p: Project, ws: string): Promise<string[] | undefined> {
    const remote = this.deps.store
      .environments(p.id)
      .flatMap((e) => (e.node ? [e.worktree.path] : []));
    return this.deps.worktrees
      .list(p, ws, this.deps.store.runtime(p.id).worktreeRoot)
      .then((list) => [...list.map((w) => w.path), ...remote])
      .catch(() => undefined);
  }

  private async staleSessionsIn(
    p: Project,
    envId: EnvId,
    workspace: string,
    worktrees: string[] | undefined
  ): Promise<SessionCleanupItem[]> {
    const client = this.envs.opencodeClient(envId);
    const [sessions, active] = await Promise.all([
      client.sessions(),
      client.active(),
    ]);
    const waiting = this.deps.store
      .sessionsOf(p.id)
      .filter((s) => s.status !== "idle")
      .map((s) => s.id);
    return staleSessions({
      projectId: p.id,
      ...(envId === p.id ? {} : { envId }),
      sessions,
      busy: new Set([...active, ...waiting]),
      workspace,
      ...(worktrees ? { worktrees } : {}),
      discarded: (id) =>
        this.deps.tasks.bySession(id)?.variant.discarded === true,
      now: (this.deps.now ?? Date.now)(),
    });
  }
}
