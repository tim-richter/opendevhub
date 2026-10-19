import type {
  BranchCleanupItem,
  CleanupOutcome,
  EnvId,
  Project,
  ProjectId,
  SessionCleanupItem,
} from "../../shared/types";
import { USER } from "../db/events";
import type { Environments } from "../environments/environments";
import type { HubDeps } from "../environments/ports";
import { rootOf } from "../sessions/status";
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
      this.envs.setWorktrees(id, worktrees);
      const envs = this.deps.store.environments(id);
      return scanBranches(this.deps.git, {
        envOf: (dir) => envs.find((e) => e.worktree.path === dir)?.id,
        inUse: this.inUse(id),
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
      const listed = await this.deps.worktrees.list(p, ws, root);
      this.envs.setWorktrees(id, listed);
      const changed = await branchChanged(
        this.deps.git,
        p,
        ws,
        item,
        listed,
        this.inUse(id)
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
        // Forced: branchChanged just checked the verdict against the branch's base, while -d would check its upstream
        // or the main checkout's HEAD instead, and refuses a squash-merged branch whose upstream is gone.
        await this.deps.git.deleteBranch(p, ws, item.branch, true);
        this.deps.checkouts.deleteBranch(id, item.branch, USER);
      } finally {
        const list = await this.deps.worktrees
          .list(p, ws, root)
          .catch(() => undefined);
        if (list) {
          this.envs.setWorktrees(id, list);
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

  /**
   * Deletes the conversation of an archived chat or task that cleanup is deleting. One whose environment is gone,
   * or that its environment no longer lists, is gone already.
   */
  async cleanupConversation(
    id: ProjectId,
    envId: EnvId | undefined,
    sessionId: string
  ): Promise<CleanupOutcome> {
    const env = envId ?? id;
    if (env !== id) {
      const record = this.deps.store.environment(env);
      if (!record) {
        return { outcome: "removed" };
      }
      if (record.projectId !== id) {
        return { message: "changed since scan", outcome: "skipped" };
      }
    }
    if (this.deps.store.runtime(env).containerState !== "running") {
      return {
        message: `its conversation is in ${env === id ? "the project's" : "a"} stopped container; start it to delete`,
        outcome: "skipped",
      };
    }
    const client = this.envs.opencodeClient(env);
    const [sessions, active] = await Promise.all([
      client.sessions(),
      client.active(),
    ]);
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      this.envs.reconcile(env);
      return { outcome: "removed" };
    }
    const parents = new Map(sessions.map((s) => [s.id, s.parentID]));
    const waiting = this.deps.store
      .sessionsOf(id)
      .some((s) => s.id === sessionId && s.status !== "idle");
    if ([...active].some((a) => rootOf(a, parents) === sessionId) || waiting) {
      return {
        message: "its conversation is still running",
        outcome: "skipped",
      };
    }
    await client.deleteSession(sessionId, session.location.directory);
    this.envs.log(
      id,
      `cleanup: removed session ${session.title?.trim() || sessionId}`
    );
    this.envs.reconcile(env);
    return { outcome: "removed" };
  }

  /**
   * Whether a branch or worktree is in use now: a session there is running or waiting on someone, or a task variant
   * or chat is still being set up on it. Idle sessions don't count, or every finished task would keep its worktree.
   */
  private inUse(
    id: ProjectId
  ): (branch: string, worktreePath: string | undefined) => boolean {
    const dirs = new Set<string>();
    const branches = new Set<string>();
    for (const s of this.deps.store.sessionsOf(id)) {
      if (s.status !== "idle") {
        dirs.add(s.directory);
      }
    }
    const starting = [
      ...this.deps.tasks
        .listForProject(id)
        .flatMap((t) => t.variants.filter((v) => !v.discarded)),
      ...this.deps.chats.listForProject(id),
    ].filter((c) => !c.sessionId && c.step !== "failed");
    for (const c of starting) {
      if (c.branch) {
        branches.add(c.branch);
      }
      if (c.directory) {
        dirs.add(c.directory);
      }
    }
    return (branch, worktreePath) =>
      branches.has(branch) ||
      (worktreePath !== undefined && dirs.has(worktreePath));
  }

  /** Current worktree paths, here and on other nodes, or undefined when git can't list them. */
  private worktreePaths(p: Project, ws: string): Promise<string[] | undefined> {
    const remote = this.deps.store
      .environments(p.id)
      .flatMap((e) => (e.node ? [e.worktree.path] : []));
    return this.deps.worktrees
      .list(p, ws, this.deps.store.runtime(p.id).worktreeRoot)
      .then((list) => {
        this.envs.setWorktrees(p.id, list);
        return [...list.map((w) => w.path), ...remote];
      })
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
      archived: (id) =>
        this.deps.tasks.isSessionArchived(id) ||
        this.deps.tasks.bySession(id)?.task.archivedAt !== undefined ||
        this.deps.chats.bySession(id)?.archivedAt !== undefined,
      now: (this.deps.now ?? Date.now)(),
    });
  }
}
