import type {
  CheckoutCreator,
  NodeId,
  ProjectId,
  PullRole,
} from "../../shared/types";
import { transaction } from "./database";
import type { Db } from "./database";
import { SYSTEM, record } from "./events";
import type { Actor, EventVerb } from "./events";
import { ensurePullIn, linkBranchIn } from "./links";
import type { PullFacts } from "./links";

/** Who made a branch or worktree: a task variant, the checkouts page, a pull request checkout, or not opendevhub. */
export type Creator =
  | { by: "variant"; task: string; n: number }
  | { by: "manual" }
  | { by: "pull" }
  | { by: "unmanaged" };

export interface BranchRecord {
  id: number;
  projectId: ProjectId;
  name: string;
  /** Mirror of `branch.<name>.opendevhubBase`, which stays the source for readers in containers and on nodes. */
  base?: string;
  createdBy: Creator;
  /** The pull request it is linked to: published as its head, or made to check it out. */
  pullRequest?: { id: number; url: string; role: PullRole };
  /** The pull request it checks out, or the ticket its creating task started from. */
  originUrl?: string;
  publishedRemote?: string;
  publishedAt?: number;
  agitTopic?: string;
  /** The pull request it was published as (role `head`). */
  prUrl?: string;
  createdAt: number;
  deletedAt?: number;
}

export interface WorktreeRecord {
  id: number;
  projectId: ProjectId;
  branchId?: number;
  branch?: string;
  path: string;
  hostPath?: string;
  node?: NodeId;
  createdBy: Creator;
  createdAt: number;
  removedAt?: number;
}

/** One worktree as a listing found it. */
export interface ListedWorktree {
  path: string;
  hostPath?: string;
  branch?: string;
}

/** A pull request by its web URL, with what else is known about it. */
export type PullRef = PullFacts & { url: string };

export type BranchPatch = Partial<{
  base: string;
  publishedRemote: string;
  publishedAt: number;
  agitTopic: string;
  /** The pull request the forge printed on publishing: linked with role `head`. */
  pull: PullRef;
}>;

interface RawBranch {
  id: number;
  project_id: string;
  name: string;
  base: string | null;
  created_by: Creator["by"];
  created_by_task: string | null;
  created_by_variant: number | null;
  published_remote: string | null;
  published_at: number | null;
  agit_topic: string | null;
  pull_request_id: number | null;
  pr_role: PullRole | null;
  created_at: number;
  /** Joined: the linked pull request's URL, and the ticket of the task that created the branch. */
  pull_url: string | null;
  ticket_url: string | null;
  deleted_at: number | null;
}

interface RawWorktree {
  id: number;
  project_id: string;
  branch_id: number | null;
  branch_name: string | null;
  path: string;
  host_path: string | null;
  node_id: string | null;
  created_by: Creator["by"];
  created_at: number;
  removed_at: number | null;
  /** The variant that points at this worktree, when one does. */
  task_id: string | null;
  n: number | null;
}

const creatorOf = (
  by: Creator["by"],
  task: string | null,
  n: number | null
): Creator =>
  by === "variant" && task !== null && n !== null
    ? { by, n, task }
    : { by: by === "variant" ? "unmanaged" : by };

const toBranch = (r: RawBranch): BranchRecord => {
  const pull =
    r.pull_request_id !== null && r.pr_role !== null && r.pull_url !== null
      ? { id: r.pull_request_id, role: r.pr_role, url: r.pull_url }
      : undefined;
  const origin = pull?.role === "checkout" ? pull.url : r.ticket_url;
  return {
    createdAt: r.created_at,
    createdBy: creatorOf(r.created_by, r.created_by_task, r.created_by_variant),
    id: r.id,
    name: r.name,
    projectId: r.project_id,
    ...(r.base === null ? {} : { base: r.base }),
    ...(pull ? { pullRequest: pull } : {}),
    ...(origin ? { originUrl: origin } : {}),
    ...(r.published_remote === null
      ? {}
      : { publishedRemote: r.published_remote }),
    ...(r.published_at === null ? {} : { publishedAt: r.published_at }),
    ...(r.agit_topic === null ? {} : { agitTopic: r.agit_topic }),
    ...(pull?.role === "head" ? { prUrl: pull.url } : {}),
    ...(r.deleted_at === null ? {} : { deletedAt: r.deleted_at }),
  };
};

const toWorktree = (r: RawWorktree): WorktreeRecord => ({
  createdAt: r.created_at,
  createdBy: creatorOf(r.created_by, r.task_id, r.n),
  id: r.id,
  path: r.path,
  projectId: r.project_id,
  ...(r.branch_id === null ? {} : { branchId: r.branch_id }),
  ...(r.branch_name === null ? {} : { branch: r.branch_name }),
  ...(r.host_path === null ? {} : { hostPath: r.host_path }),
  ...(r.node_id === null ? {} : { node: r.node_id }),
  ...(r.removed_at === null ? {} : { removedAt: r.removed_at }),
});

/** A worktree's creator as the snapshot shows it; a variant's task title is looked up by the caller. */
export const creatorView = (
  c: Creator,
  extra: { title?: string; url?: string }
): CheckoutCreator => {
  if (c.by === "variant") {
    return { by: "variant", n: c.n, task: c.task, title: extra.title ?? "" };
  }
  if (c.by === "pull") {
    return { by: "pull", ...(extra.url ? { url: extra.url } : {}) };
  }
  return { by: c.by };
};

const BRANCH_SELECT = `SELECT b.*, p.url AS pull_url, k.url AS ticket_url
  FROM branches b
  LEFT JOIN pull_requests p ON p.id = b.pull_request_id
  LEFT JOIN tasks t ON t.id = b.created_by_task
  LEFT JOIN tickets k ON k.id = t.ticket_id`;

const WORKTREE_SELECT = `SELECT w.*, b.name AS branch_name, v.task_id AS task_id, v.n AS n
  FROM worktrees w
  LEFT JOIN branches b ON b.id = w.branch_id
  LEFT JOIN variants v ON v.rowid = (SELECT rowid FROM variants WHERE worktree_id = w.id ORDER BY task_id, n LIMIT 1)`;

const sameNode = "COALESCE(w.node_id, '') = ?";

/**
 * Branches and worktrees: which branch each checkout is on, who made them, and what a branch was published as.
 * Every change writes its events in the same transaction; `subscribe` hears about each change.
 */
export class CheckoutStore {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * The project's branch row for `name`, inserted with `creator` when it has none. An existing branch keeps its
   * creator; one opendevhub deleted is made anew, since the name now means a different branch.
   */
  ensureBranch(
    projectId: ProjectId,
    name: string,
    creator: Creator,
    actor: Actor,
    facts: { base?: string } = {}
  ): BranchRecord {
    return this.write(() =>
      this.ensureBranchIn(projectId, name, creator, actor, facts)
    );
  }

  /**
   * Records what a branch was published as, or its base. A branch without a row (made outside a worktree) gets one
   * as unmanaged. Recording a published remote writes `branch.published`.
   */
  updateBranch(
    projectId: ProjectId,
    name: string,
    patch: BranchPatch,
    actor: Actor
  ): BranchRecord {
    const at = this.now();
    return this.write(() => {
      const row = this.ensureBranchIn(
        projectId,
        name,
        { by: "unmanaged" },
        actor
      );
      const columns: [string, string | number][] = [];
      if (patch.base !== undefined && patch.base !== row.base) {
        columns.push(["base", patch.base]);
      }
      if (patch.publishedRemote !== undefined) {
        columns.push(["published_remote", patch.publishedRemote]);
      }
      if (patch.publishedAt !== undefined) {
        columns.push(["published_at", patch.publishedAt]);
      }
      if (patch.agitTopic !== undefined) {
        columns.push(["agit_topic", patch.agitTopic]);
      }
      if (columns.length === 0 && !patch.pull) {
        return row;
      }
      if (columns.length > 0) {
        this.db
          .prepare(
            `UPDATE branches SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`
          )
          .run(...columns.map(([, v]) => v), row.id);
      }
      const pull = patch.pull
        ? ensurePullIn(this.db, patch.pull.url, patch.pull)
        : undefined;
      if (patch.publishedRemote !== undefined) {
        this.branchEvent(at, actor, "branch.published", row, {
          remote: patch.publishedRemote,
          ...(patch.agitTopic ? { topic: patch.agitTopic } : {}),
          ...(pull ? { pr: pull.url } : {}),
        });
      }
      if (pull) {
        linkBranchIn(this.db, at, actor, row.id, pull.id, "head");
      }
      return this.branchById(row.id) ?? row;
    });
  }

  /** Records that opendevhub deleted the branch. False when it has no row or was deleted already. */
  deleteBranch(projectId: ProjectId, name: string, actor: Actor): boolean {
    const at = this.now();
    return this.write(() => {
      const row = this.branch(projectId, name);
      if (!row || row.deletedAt !== undefined) {
        return false;
      }
      this.db
        .prepare("UPDATE branches SET deleted_at = ? WHERE id = ?")
        .run(at, row.id);
      this.branchEvent(at, actor, "branch.deleted", row);
      return true;
    });
  }

  /** The project's branch row for `name`, deleted or not. */
  branch(projectId: ProjectId, name: string): BranchRecord | undefined {
    const r = this.db
      .prepare(`${BRANCH_SELECT} WHERE b.project_id = ? AND b.name = ?`)
      .get(projectId, name) as RawBranch | undefined;
    return r ? toBranch(r) : undefined;
  }

  /** Every branch row of the project, deleted ones included, by name. */
  branchesOf(projectId: ProjectId): BranchRecord[] {
    return (
      this.db
        .prepare(`${BRANCH_SELECT} WHERE b.project_id = ? ORDER BY b.name`)
        .all(projectId) as unknown as RawBranch[]
    ).map(toBranch);
  }

  /**
   * Records a worktree opendevhub just created. A live row already at that path is the same checkout: one reconcile
   * adopted first is claimed by `creator`, any other one is marked removed and replaced.
   */
  insertWorktree(
    projectId: ProjectId,
    wt: ListedWorktree & { node?: NodeId; branchId?: number },
    creator: Creator,
    actor: Actor
  ): WorktreeRecord {
    return this.write(() => this.insertIn(projectId, wt, creator, actor));
  }

  private insertIn(
    projectId: ProjectId,
    wt: ListedWorktree & { node?: NodeId; branchId?: number },
    creator: Creator,
    actor: Actor
  ): WorktreeRecord {
    const at = this.now();
    const existing = this.liveAt(projectId, wt.path, wt.node);
    if (existing?.createdBy.by === "unmanaged") {
      this.db
        .prepare(
          "UPDATE worktrees SET created_by = ?, branch_id = ?, host_path = ? WHERE id = ?"
        )
        .run(creator.by, wt.branchId ?? null, wt.hostPath ?? null, existing.id);
      if (creator.by === "variant") {
        this.linkIn(creator.task, creator.n, {
          branchId: wt.branchId,
          worktreeId: existing.id,
        });
      }
      return this.worktreeById(existing.id) ?? existing;
    }
    if (existing) {
      this.markRemoved(at, SYSTEM, existing);
    }
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO worktrees (project_id, branch_id, path, host_path, node_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          projectId,
          wt.branchId ?? null,
          wt.path,
          wt.hostPath ?? null,
          wt.node ?? null,
          creator.by,
          at
        ).lastInsertRowid
    );
    if (creator.by === "variant") {
      this.linkIn(creator.task, creator.n, {
        branchId: wt.branchId,
        worktreeId: id,
      });
    }
    const row = this.worktreeById(id);
    if (!row) {
      throw new Error(`worktree ${id} vanished after insert`);
    }
    this.worktreeEvent(
      at,
      actor,
      "worktree.created",
      row,
      creator.by === "variant" ? creator.task : undefined
    );
    return row;
  }

  /**
   * Records a worktree opendevhub just created on `branch`, in one transaction: the branch row (an existing one keeps
   * its creator, and gets `base` mirrored), the worktree row, for a variant the links to both, and for a pull
   * request checkout the branch's link to `pull` with role `checkout`.
   */
  recordCreated(
    projectId: ProjectId,
    wt: ListedWorktree & {
      branch: string;
      node?: NodeId;
      base?: string;
      pull?: PullRef;
    },
    creator: Creator,
    actor: Actor
  ): { branch: BranchRecord; worktree: WorktreeRecord } {
    return this.write(() => {
      const at = this.now();
      const { base, pull, ...listed } = wt;
      let branch = this.ensureBranchIn(
        projectId,
        wt.branch,
        creator,
        actor,
        base ? { base } : {}
      );
      if (base && branch.base !== base) {
        this.db
          .prepare("UPDATE branches SET base = ? WHERE id = ?")
          .run(base, branch.id);
        branch = { ...branch, base };
      }
      if (pull) {
        const row = ensurePullIn(this.db, pull.url, pull);
        linkBranchIn(this.db, at, actor, branch.id, row.id, "checkout");
        branch = this.branchById(branch.id) ?? branch;
      }
      const worktree = this.insertIn(
        projectId,
        { ...listed, branchId: branch.id },
        creator,
        actor
      );
      return { branch, worktree };
    });
  }

  /** Records that a worktree was removed. False when it has no live row there. */
  removeWorktree(
    projectId: ProjectId,
    worktreePath: string,
    node: NodeId | undefined,
    actor: Actor
  ): boolean {
    const at = this.now();
    return this.write(() => {
      const row = this.liveAt(projectId, worktreePath, node);
      if (!row) {
        return false;
      }
      this.markRemoved(at, actor, row);
      return true;
    });
  }

  /**
   * After a successful listing of this machine's linked worktrees (or a node's, with `node`): adopts the paths
   * without a live row as unmanaged, follows checkouts that switched branches, and marks the rows whose path is
   * gone removed. Only changes write events.
   */
  reconcileWorktrees(
    projectId: ProjectId,
    listing: readonly ListedWorktree[],
    node?: NodeId,
    actor: Actor = SYSTEM
  ): void {
    const at = this.now();
    const live = new Map(this.liveIn(projectId, node).map((w) => [w.path, w]));
    const listed = new Map(listing.map((w) => [w.path, w]));
    const changes =
      [...listed.values()].some((w) => {
        const row = live.get(w.path);
        return (
          !row ||
          row.branch !== w.branch ||
          (w.hostPath !== undefined && row.hostPath !== w.hostPath)
        );
      }) || [...live.keys()].some((p) => !listed.has(p));
    if (!changes) {
      return;
    }
    this.write(() => {
      for (const w of listed.values()) {
        const row = live.get(w.path);
        const branchId = w.branch
          ? this.ensureBranchIn(projectId, w.branch, { by: "unmanaged" }, actor)
              .id
          : undefined;
        if (!row) {
          this.adopt(at, actor, projectId, w, node, branchId);
          continue;
        }
        if (w.hostPath !== undefined && row.hostPath !== w.hostPath) {
          this.db
            .prepare("UPDATE worktrees SET host_path = ? WHERE id = ?")
            .run(w.hostPath, row.id);
        }
        if (row.branch !== w.branch) {
          this.db
            .prepare("UPDATE worktrees SET branch_id = ? WHERE id = ?")
            .run(branchId ?? null, row.id);
          this.worktreeEvent(
            at,
            actor,
            "worktree.switched",
            { ...row, ...(w.branch ? { branch: w.branch } : {}) },
            undefined,
            { from: row.branch ?? null, to: w.branch ?? null }
          );
        }
      }
      for (const row of live.values()) {
        if (!listed.has(row.path)) {
          this.markRemoved(at, actor, row);
        }
      }
    });
  }

  /** Points a variant at the branch and worktree it runs on. */
  linkVariant(
    taskId: string,
    n: number,
    link: { branchId?: number; worktreeId?: number }
  ): void {
    this.write(() => this.linkIn(taskId, n, link));
  }

  private linkIn(
    taskId: string,
    n: number,
    link: { branchId?: number; worktreeId?: number }
  ): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE variants SET branch_id = COALESCE(?, branch_id), worktree_id = COALESCE(?, worktree_id) WHERE task_id = ? AND n = ?"
          )
          .run(link.branchId ?? null, link.worktreeId ?? null, taskId, n)
          .changes
      ) > 0
    );
  }

  /** The variant's branch and worktree rows, when it points at them. */
  variantLinks(
    taskId: string,
    n: number
  ): { branch?: BranchRecord; worktree?: WorktreeRecord } {
    const r = this.db
      .prepare(
        "SELECT branch_id, worktree_id FROM variants WHERE task_id = ? AND n = ?"
      )
      .get(taskId, n) as
      | { branch_id: number | null; worktree_id: number | null }
      | undefined;
    const branch =
      r?.branch_id === null || !r ? undefined : this.branchById(r.branch_id);
    const worktree =
      r?.worktree_id === null || !r
        ? undefined
        : this.worktreeById(r.worktree_id);
    return { ...(branch ? { branch } : {}), ...(worktree ? { worktree } : {}) };
  }

  /** The project's worktrees not marked removed, on every node. */
  worktreesOf(projectId: ProjectId): WorktreeRecord[] {
    return (
      this.db
        .prepare(
          `${WORKTREE_SELECT} WHERE w.project_id = ? AND w.removed_at IS NULL ORDER BY w.id`
        )
        .all(projectId) as unknown as RawWorktree[]
    ).map(toWorktree);
  }

  /** Every worktree row of the project, removed ones included, oldest first. */
  worktreeHistory(projectId: ProjectId): WorktreeRecord[] {
    return (
      this.db
        .prepare(`${WORKTREE_SELECT} WHERE w.project_id = ? ORDER BY w.id`)
        .all(projectId) as unknown as RawWorktree[]
    ).map(toWorktree);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Runs `fn` in a transaction and tells the listeners, unless it returned false (nothing changed). */
  private write<T>(fn: () => T): T {
    const result = transaction(this.db, fn);
    if (result !== false) {
      for (const listener of this.listeners) {
        listener();
      }
    }
    return result;
  }

  private ensureBranchIn(
    projectId: ProjectId,
    name: string,
    creator: Creator,
    actor: Actor,
    facts: { base?: string } = {}
  ): BranchRecord {
    const at = this.now();
    const existing = this.branch(projectId, name);
    if (existing && existing.deletedAt === undefined) {
      return existing;
    }
    const task = creator.by === "variant" ? creator.task : null;
    const n = creator.by === "variant" ? creator.n : null;
    if (existing) {
      this.db
        .prepare(
          `UPDATE branches SET base = ?, created_by = ?, created_by_task = ?, created_by_variant = ?,
           published_remote = NULL, published_at = NULL, agit_topic = NULL, pull_request_id = NULL, pr_role = NULL,
           created_at = ?, deleted_at = NULL WHERE id = ?`
        )
        .run(facts.base ?? null, creator.by, task, n, at, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO branches (project_id, name, base, created_by, created_by_task, created_by_variant, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, name) DO NOTHING`
        )
        .run(projectId, name, facts.base ?? null, creator.by, task, n, at);
    }
    const row = this.branch(projectId, name);
    if (!row) {
      throw new Error(`branch ${name} vanished after insert`);
    }
    this.branchEvent(at, actor, "branch.created", row, {
      createdBy: creator.by,
    });
    return row;
  }

  private adopt(
    at: number,
    actor: Actor,
    projectId: ProjectId,
    w: ListedWorktree,
    node: NodeId | undefined,
    branchId: number | undefined
  ): void {
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO worktrees (project_id, branch_id, path, host_path, node_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'unmanaged', ?)`
        )
        .run(
          projectId,
          branchId ?? null,
          w.path,
          w.hostPath ?? null,
          node ?? null,
          at
        ).lastInsertRowid
    );
    const row = this.worktreeById(id);
    if (row) {
      this.worktreeEvent(at, actor, "worktree.adopted", row);
    }
  }

  private markRemoved(at: number, actor: Actor, row: WorktreeRecord): void {
    this.db
      .prepare("UPDATE worktrees SET removed_at = ? WHERE id = ?")
      .run(at, row.id);
    this.worktreeEvent(at, actor, "worktree.removed", row);
  }

  private liveAt(
    projectId: ProjectId,
    worktreePath: string,
    node: NodeId | undefined
  ): WorktreeRecord | undefined {
    const r = this.db
      .prepare(
        `${WORKTREE_SELECT} WHERE w.project_id = ? AND ${sameNode} AND w.path = ? AND w.removed_at IS NULL`
      )
      .get(projectId, node ?? "", worktreePath) as RawWorktree | undefined;
    return r ? toWorktree(r) : undefined;
  }

  private liveIn(
    projectId: ProjectId,
    node: NodeId | undefined
  ): WorktreeRecord[] {
    return (
      this.db
        .prepare(
          `${WORKTREE_SELECT} WHERE w.project_id = ? AND ${sameNode} AND w.removed_at IS NULL`
        )
        .all(projectId, node ?? "") as unknown as RawWorktree[]
    ).map(toWorktree);
  }

  private branchById(id: number): BranchRecord | undefined {
    const r = this.db.prepare(`${BRANCH_SELECT} WHERE b.id = ?`).get(id) as
      | RawBranch
      | undefined;
    return r ? toBranch(r) : undefined;
  }

  private worktreeById(id: number): WorktreeRecord | undefined {
    const r = this.db.prepare(`${WORKTREE_SELECT} WHERE w.id = ?`).get(id) as
      | RawWorktree
      | undefined;
    return r ? toWorktree(r) : undefined;
  }

  private branchEvent(
    at: number,
    actor: Actor,
    verb: EventVerb,
    row: BranchRecord,
    data: Record<string, unknown> = {}
  ): void {
    record(this.db, {
      actor,
      at,
      data: { name: row.name, ...data },
      object: { id: String(row.id), type: "branch" },
      projectId: row.projectId,
      verb,
      ...(row.createdBy.by === "variant" ? { taskId: row.createdBy.task } : {}),
    });
  }

  private worktreeEvent(
    at: number,
    actor: Actor,
    verb: EventVerb,
    row: WorktreeRecord,
    taskId?: string,
    data: Record<string, unknown> = {}
  ): void {
    const task =
      taskId ?? (row.createdBy.by === "variant" ? row.createdBy.task : null);
    record(this.db, {
      actor,
      at,
      data: {
        path: row.path,
        ...(row.branch ? { branch: row.branch } : {}),
        ...(row.node ? { node: row.node } : {}),
        ...data,
      },
      object: { id: String(row.id), type: "worktree" },
      projectId: row.projectId,
      verb,
      ...(task ? { taskId: task } : {}),
    });
  }
}
