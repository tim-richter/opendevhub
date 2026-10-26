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
import { MAX_SESSION_LOOKUPS } from "../environments/monitor";
import type { HubDeps } from "../environments/ports";
import { OpencodeHttpError } from "../opencode/client";
import type { OpencodeClient, RawSession } from "../opencode/client";
import type { Checkouts } from "./checkouts";
import { branchChanged, scanBranches, staleSessions } from "./cleanup";
import type { BaseFreshness } from "./freshness";

/** One session by id; undefined only when opencode answers 404. Any other failure throws. */
const lookUp = async (
  client: OpencodeClient,
  id: string
): Promise<RawSession | undefined> => {
  try {
    return await client.session(id);
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Whether `root` or one of its subagent sessions is among the `active` ones: walks `parentID` up from each active
 * session with cached single lookups, so a root outside the newest page is found too. Past the lookup cap it can't
 * tell, and answers true so the conversation is kept.
 */
const runsUnder = async (
  client: OpencodeClient,
  active: Set<string>,
  root: RawSession
): Promise<boolean> => {
  const known = new Map<string, RawSession | undefined>([[root.id, root]]);
  let lookups = 0;
  for (const start of active) {
    const seen = new Set<string>();
    let id: string | undefined = start;
    while (id && !seen.has(id)) {
      if (id === root.id) {
        return true;
      }
      seen.add(id);
      if (!known.has(id)) {
        if (lookups >= MAX_SESSION_LOOKUPS) {
          return true;
        }
        lookups += 1;
        known.set(id, await lookUp(client, id));
      }
      id = known.get(id)?.parentID;
    }
  }
  return false;
};

/** The branches and sessions of one project that cleanup may delete, scanned and deleted through its environments. */
export class CleanupTargets {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  private readonly checkouts: Checkouts;
  private readonly freshness?: Pick<BaseFreshness, "record">;
  constructor(
    deps: HubDeps,
    envs: Environments,
    checkouts: Checkouts,
    freshness?: Pick<BaseFreshness, "record">
  ) {
    this.deps = deps;
    this.envs = envs;
    this.checkouts = checkouts;
    this.freshness = freshness;
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
        onFetched: (remote) => this.freshness?.record(id, remote),
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
    let session: RawSession | undefined;
    let running: boolean;
    try {
      const [found, active] = await Promise.all([
        lookUp(client, sessionId),
        client.active(),
      ]);
      session = found;
      running = found ? await runsUnder(client, active, found) : false;
    } catch (error) {
      // Unknown is not gone: keep the record and say why.
      return {
        message: `could not check its conversation: ${error instanceof Error ? error.message : String(error)}`,
        outcome: "skipped",
      };
    }
    if (!session) {
      this.envs.reconcile(env);
      return { outcome: "removed" };
    }
    const waiting = this.deps.store
      .sessionsOf(id)
      .some((s) => s.id === sessionId && s.status !== "idle");
    if (waiting || running) {
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
      client.allSessions({
        onCapped: (cap) =>
          this.envs.log(
            p.id,
            `cleanup: ${envId === p.id ? "" : `${envId}: `}read only the newest ${cap} sessions`
          ),
      }),
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
