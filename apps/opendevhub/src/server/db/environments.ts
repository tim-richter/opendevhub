import type { EnvId, EnvWorktree, NodeId, ProjectId } from "../../shared/types";
import { transaction } from "./database";
import type { Db } from "./database";
import { SYSTEM, record } from "./events";
import type { Actor, EventVerb } from "./events";

/** The runtime fields that survive a restart; the rest of a runtime lives in memory. */
export interface DurableRuntime {
  containerId?: string;
  password?: string;
  workspaceFolder?: string;
  relayToken?: string;
  remoteUser?: string;
}

export type DurablePatch = Partial<{
  [K in keyof DurableRuntime]: DurableRuntime[K] | undefined;
}> & { image?: { key: string; ref: string } };

/** A project's main environment (its id is the project id) or a task environment on a worktree. */
export interface EnvironmentRecord {
  id: EnvId;
  projectId: ProjectId;
  kind: "main" | "task";
  /** Task environments only, with the worktree's path and branch. */
  worktreeId?: number;
  worktree?: EnvWorktree;
  /** Absent for this machine. */
  node?: NodeId;
  image?: { key: string; ref: string };
  /** Includes the container password and relay token: never hand it to a view as is. */
  runtime: DurableRuntime;
  createdAt: number;
  removedAt?: number;
}

export interface NewTaskEnvironment {
  id: EnvId;
  projectId: ProjectId;
  worktreeId: number;
  node?: NodeId;
}

interface RawEnvironment {
  id: string;
  project_id: string;
  kind: "main" | "task";
  worktree_id: number | null;
  node_id: string | null;
  container_id: string | null;
  workspace_folder: string | null;
  remote_user: string | null;
  image_key: string | null;
  image_ref: string | null;
  password: string | null;
  relay_token: string | null;
  created_at: number;
  removed_at: number | null;
  worktree_path: string | null;
  worktree_host_path: string | null;
  branch_name: string | null;
}

const SELECT = `SELECT e.*, w.path AS worktree_path, w.host_path AS worktree_host_path, b.name AS branch_name
  FROM environments e
  LEFT JOIN worktrees w ON w.id = e.worktree_id
  LEFT JOIN branches b ON b.id = w.branch_id`;

const DURABLE_COLUMNS = {
  containerId: "container_id",
  password: "password",
  relayToken: "relay_token",
  remoteUser: "remote_user",
  workspaceFolder: "workspace_folder",
} as const satisfies Record<keyof DurableRuntime, string>;

const lastSegment = (p: string): string =>
  p.split("/").findLast((part) => part !== "") ?? p;

const toEnvironment = (r: RawEnvironment): EnvironmentRecord => {
  const runtime: DurableRuntime = {};
  for (const [key, column] of Object.entries(DURABLE_COLUMNS) as [
    keyof DurableRuntime,
    keyof RawEnvironment,
  ][]) {
    const value = r[column];
    if (typeof value === "string") {
      runtime[key] = value;
    }
  }
  return {
    createdAt: r.created_at,
    id: r.id,
    kind: r.kind,
    projectId: r.project_id,
    runtime,
    ...(r.worktree_id === null ? {} : { worktreeId: r.worktree_id }),
    ...(r.worktree_path === null
      ? {}
      : {
          worktree: {
            branch: r.branch_name ?? lastSegment(r.worktree_path),
            hostPath: r.worktree_host_path ?? "",
            path: r.worktree_path,
          },
        }),
    ...(r.node_id === null ? {} : { node: r.node_id }),
    ...(r.image_key !== null && r.image_ref !== null
      ? { image: { key: r.image_key, ref: r.image_ref } }
      : {}),
    ...(r.removed_at === null ? {} : { removedAt: r.removed_at }),
  };
};

const environmentEvent = (
  db: Db,
  at: number,
  actor: Actor,
  verb: EventVerb,
  env: Pick<EnvironmentRecord, "id" | "projectId" | "kind" | "node">,
  taskId?: string
): void => {
  record(db, {
    actor,
    at,
    data: { kind: env.kind, ...(env.node ? { node: env.node } : {}) },
    object: { id: env.id, type: "environment" },
    projectId: env.projectId,
    verb,
    ...(taskId ? { taskId } : {}),
  });
};

/**
 * Inserts the project's main environment when it has none. For callers already in a transaction, like project
 * discovery; true when it inserted.
 */
export const insertMainIn = (
  db: Db,
  projectId: ProjectId,
  at: number,
  actor: Actor = SYSTEM
): boolean => {
  const inserted =
    Number(
      db
        .prepare(
          `INSERT INTO environments (id, project_id, kind, created_at) VALUES (?, ?, 'main', ?)
           ON CONFLICT (id) DO NOTHING`
        )
        .run(projectId, projectId, at).changes
    ) > 0;
  if (inserted) {
    environmentEvent(db, at, actor, "environment.created", {
      id: projectId,
      kind: "main",
      projectId,
    });
  }
  return inserted;
};

/**
 * Environments and the runtime fields that survive a restart, secrets included. Creating and removing one writes
 * an event in the same transaction; runtime updates don't.
 */
export class EnvironmentStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** Records the project's main environment unless it has one. The project row must exist. */
  putMain(projectId: ProjectId, actor: Actor = SYSTEM): void {
    transaction(this.db, () =>
      insertMainIn(this.db, projectId, this.now(), actor)
    );
  }

  /**
   * Records a task environment on a worktree row, for the variant of `taskId` when one asked for it. A live row with
   * that id is returned as is; a removed one is made anew, since environment ids follow from the worktree path.
   */
  putTask(
    env: NewTaskEnvironment,
    actor: Actor,
    taskId?: string
  ): EnvironmentRecord {
    const at = this.now();
    return transaction(this.db, () => {
      const existing = this.get(env.id);
      if (existing && existing.removedAt === undefined) {
        return existing;
      }
      if (existing) {
        this.db
          .prepare(
            `UPDATE environments SET project_id = ?, kind = 'task', worktree_id = ?, node_id = ?, container_id = NULL,
             workspace_folder = NULL, remote_user = NULL, image_key = NULL, image_ref = NULL, password = NULL,
             relay_token = NULL, created_at = ?, removed_at = NULL WHERE id = ?`
          )
          .run(env.projectId, env.worktreeId, env.node ?? null, at, env.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO environments (id, project_id, kind, worktree_id, node_id, created_at)
             VALUES (?, ?, 'task', ?, ?, ?)`
          )
          .run(env.id, env.projectId, env.worktreeId, env.node ?? null, at);
      }
      const row = this.get(env.id);
      if (!row) {
        throw new Error(`environment ${env.id} vanished after insert`);
      }
      environmentEvent(this.db, at, actor, "environment.created", row, taskId);
      return row;
    });
  }

  /** Writes the durable runtime fields and image in `patch`; `undefined` clears a field. No event. */
  updateDurable(id: EnvId, patch: DurablePatch): void {
    const columns: [string, string | null][] = [];
    for (const [key, column] of Object.entries(DURABLE_COLUMNS) as [
      keyof DurableRuntime,
      string,
    ][]) {
      if (key in patch) {
        columns.push([column, patch[key] ?? null]);
      }
    }
    if (patch.image) {
      columns.push(
        ["image_key", patch.image.key],
        ["image_ref", patch.image.ref]
      );
    }
    if (columns.length === 0) {
      return;
    }
    this.db
      .prepare(
        `UPDATE environments SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ? AND removed_at IS NULL`
      )
      .run(...columns.map(([, v]) => v), id);
  }

  /** Records that the environment's container is gone. False when it has no live row. */
  markRemoved(id: EnvId, actor: Actor): boolean {
    const at = this.now();
    return transaction(this.db, () => {
      const row = this.get(id);
      if (!row || row.removedAt !== undefined) {
        return false;
      }
      this.db
        .prepare(
          "UPDATE environments SET removed_at = ?, password = NULL, relay_token = NULL WHERE id = ?"
        )
        .run(at, id);
      environmentEvent(
        this.db,
        at,
        actor,
        "environment.removed",
        row,
        this.taskOf(row)
      );
      return true;
    });
  }

  /** The environment row, removed or not. */
  get(id: EnvId): EnvironmentRecord | undefined {
    const r = this.db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as
      | RawEnvironment
      | undefined;
    return r ? toEnvironment(r) : undefined;
  }

  /** Every environment not marked removed, main and task, oldest first. */
  listLive(): EnvironmentRecord[] {
    return (
      this.db
        .prepare(
          `${SELECT} WHERE e.removed_at IS NULL ORDER BY e.created_at, e.id`
        )
        .all() as unknown as RawEnvironment[]
    ).map(toEnvironment);
  }

  /** How many environments not marked removed run on `node`. */
  countOnNode(node: NodeId): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM environments WHERE node_id = ? AND removed_at IS NULL"
        )
        .get(node) as { n: number }
    ).n;
  }

  /** The task of a variant that runs in the environment or on its worktree. */
  private taskOf(row: EnvironmentRecord): string | undefined {
    const r = this.db
      .prepare(
        "SELECT task_id FROM variants WHERE env_id = ? OR worktree_id = ? ORDER BY task_id, n LIMIT 1"
      )
      .get(row.id, row.worktreeId ?? null) as { task_id: string } | undefined;
    return r?.task_id;
  }
}
