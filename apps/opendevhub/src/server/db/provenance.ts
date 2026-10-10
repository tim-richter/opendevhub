import type {
  ObjectType,
  Provenance,
  ProvenanceStep,
} from "../../shared/activity";
import type { ModelRef } from "../../shared/types";
import { NotFoundError } from "../errors";
import type { Db } from "./database";

interface ProjectRow {
  id: string;
  name: string;
  missing_since: number | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  kind: "task" | "manual" | "review";
  title: string;
  ticket_id: number | null;
  pull_request_id: number | null;
  proposed_in: string | null;
  archived_at: number | null;
}

interface VariantRow {
  task_id: string;
  n: number;
  model: string | null;
  env_id: string | null;
  branch_id: number | null;
  worktree_id: number | null;
  session_id: string | null;
  session_removed_at: number | null;
  discarded_at: number | null;
}

interface BranchRow {
  id: number;
  project_id: string;
  name: string;
  created_by: "variant" | "manual" | "pull" | "unmanaged";
  created_by_task: string | null;
  created_by_variant: number | null;
  pull_request_id: number | null;
  pr_role: "head" | "checkout" | null;
  deleted_at: number | null;
}

interface WorktreeRow {
  id: number;
  project_id: string;
  branch_id: number | null;
  path: string;
  created_by: "variant" | "manual" | "pull" | "unmanaged";
  removed_at: number | null;
}

interface EnvironmentRow {
  id: string;
  project_id: string;
  kind: "main" | "task";
  worktree_id: number | null;
  removed_at: number | null;
}

interface PullRow {
  id: number;
  url: string;
  forge: string;
  owner: string | null;
  repo: string | null;
  number: number | null;
  title: string | null;
}

interface TicketRow {
  id: number;
  key: string;
  url: string;
  title: string | null;
}

interface ReviewRow {
  id: number;
  pull_request_id: number;
  task_id: string | null;
  findings: string;
}

const enc = encodeURIComponent;
const projectPath = (id: string) => `/p/${enc(id)}`;
const folderName = (path: string) => path.split("/").findLast(Boolean) ?? path;
/** The checkout page of a worktree, as the web app addresses it: by its folder name. */
const worktreePath = (w: Pick<WorktreeRow, "project_id" | "path">) =>
  `${projectPath(w.project_id)}/w/${enc(folderName(w.path))}`;

const modelName = (json: string | null): string | undefined => {
  if (!json) {
    return undefined;
  }
  try {
    return (JSON.parse(json) as ModelRef).id;
  } catch {
    return undefined;
  }
};

const findingCount = (json: string): number => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
};

const step = (
  type: ObjectType,
  id: string | number,
  label: string,
  extra: Omit<ProvenanceStep, "type" | "id" | "label"> = {}
): ProvenanceStep => {
  const { href, removed, unmanaged, url } = extra;
  return {
    id: String(id),
    label,
    type,
    // A removed entity has no page to go to.
    ...(href && !removed ? { href } : {}),
    ...(url ? { url } : {}),
    ...(removed ? { removed: true } : {}),
    ...(unmanaged ? { unmanaged: true } : {}),
  };
};

/** Each step once, the first time it appears; the walk can reach the same entity by two links. */
const unique = (steps: ProvenanceStep[]): ProvenanceStep[] => {
  const seen = new Set<string>();
  return steps.filter((s) => {
    const key = `${s.type}:${s.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * Where an entity came from and what it led to, walked from the stored links on each request: session → variant →
 * task → ticket; worktree → branch → variant → task; environment → worktree → …; pull request → head branch → …;
 * review → review task → pull request. Removed entities stay in the trail, flagged.
 */
export class ProvenanceStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Throws NotFoundError when there is no such entity. */
  of(type: ObjectType, id: string): Provenance {
    const trail = unique(this.trail(type, id, new Set()));
    return { ledTo: unique(this.ledTo(type, id, trail)), trail };
  }

  private trail(
    type: ObjectType,
    id: string,
    seen: Set<string>
  ): ProvenanceStep[] {
    const key = `${type}:${id}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    switch (type) {
      case "project": {
        return [this.projectStep(this.project(id))];
      }
      case "task": {
        return this.taskTrail(this.task(id), seen);
      }
      case "variant": {
        const slash = id.lastIndexOf("/");
        return this.variantTrail(
          this.variant(id.slice(0, slash), Number(id.slice(slash + 1))),
          seen
        );
      }
      case "branch": {
        return this.branchTrail(this.branch(Number(id)), seen);
      }
      case "worktree": {
        return this.worktreeTrail(this.worktree(Number(id)), seen);
      }
      case "environment": {
        return this.environmentTrail(this.environment(id), seen);
      }
      case "session": {
        return this.sessionTrail(id, seen);
      }
      case "pull_request": {
        return this.pullTrail(this.pull(Number(id)), seen);
      }
      case "ticket": {
        return [this.ticketStep(this.ticket(Number(id)))];
      }
      case "review": {
        return this.reviewTrail(this.review(Number(id)), seen);
      }
      default: {
        throw new NotFoundError(id, type);
      }
    }
  }

  /** A spec's implementing task comes from the task that proposed it; else from its ticket, its PR, or its project. */
  private taskTrail(t: TaskRow, seen: Set<string>): ProvenanceStep[] {
    const self = this.taskStep(t);
    if (t.proposed_in && this.has("tasks", "id", t.proposed_in)) {
      const parent = this.trail("task", t.proposed_in, seen);
      if (parent.length > 0) {
        return [...parent, self];
      }
    }
    if (t.ticket_id !== null) {
      return [this.ticketStep(this.ticket(t.ticket_id)), self];
    }
    if (t.pull_request_id !== null) {
      return [
        ...this.trail("pull_request", String(t.pull_request_id), seen),
        self,
      ];
    }
    return [this.projectStep(this.project(t.project_id)), self];
  }

  /** A manual or review task has one implicit variant, which the trail leaves out. */
  private variantTrail(v: VariantRow, seen: Set<string>): ProvenanceStep[] {
    const task = this.task(v.task_id);
    const trail = this.taskTrail(task, seen);
    return task.kind === "task" ? [...trail, this.variantStep(v, task)] : trail;
  }

  /** The variant that made or runs on a branch or worktree, by its link or by the branch's creator. */
  private variantOn(
    column: "branch_id" | "worktree_id",
    id: number
  ): VariantRow | undefined {
    return this.db
      .prepare(`SELECT * FROM variants WHERE ${column} = ? ORDER BY n LIMIT 1`)
      .get(id) as VariantRow | undefined;
  }

  private branchTrail(b: BranchRow, seen: Set<string>): ProvenanceStep[] {
    const self = this.branchStep(b);
    if (
      b.created_by === "variant" &&
      b.created_by_task !== null &&
      b.created_by_variant !== null
    ) {
      const v = this.variantOrUndefined(
        b.created_by_task,
        b.created_by_variant
      );
      if (v) {
        return [...this.variantTrail(v, seen), self];
      }
    }
    const v =
      b.created_by === "unmanaged"
        ? undefined
        : this.variantOn("branch_id", b.id);
    if (v) {
      return [...this.variantTrail(v, seen), self];
    }
    if (b.created_by === "pull" && b.pull_request_id !== null) {
      return [
        ...this.trail("pull_request", String(b.pull_request_id), seen),
        self,
      ];
    }
    return [this.projectStep(this.project(b.project_id)), self];
  }

  private worktreeTrail(w: WorktreeRow, seen: Set<string>): ProvenanceStep[] {
    const self = this.worktreeStep(w);
    if (w.created_by === "unmanaged") {
      return [this.projectStep(this.project(w.project_id)), self];
    }
    const v = this.variantOn("worktree_id", w.id);
    if (v) {
      const branch = v.branch_id ?? w.branch_id;
      return [
        ...this.variantTrail(v, seen),
        ...(branch === null ? [] : [this.branchStep(this.branch(branch))]),
        self,
      ];
    }
    if (w.branch_id !== null) {
      return [...this.branchTrail(this.branch(w.branch_id), seen), self];
    }
    return [this.projectStep(this.project(w.project_id)), self];
  }

  private environmentTrail(
    e: EnvironmentRow,
    seen: Set<string>
  ): ProvenanceStep[] {
    const self = this.environmentStep(e);
    if (e.kind === "task" && e.worktree_id !== null) {
      return [...this.worktreeTrail(this.worktree(e.worktree_id), seen), self];
    }
    return [this.projectStep(this.project(e.project_id)), self];
  }

  /** The full chain: ticket › task › variant › branch › worktree › environment › session. */
  private sessionTrail(sessionId: string, seen: Set<string>): ProvenanceStep[] {
    const v = this.db
      .prepare("SELECT * FROM variants WHERE session_id = ?")
      .get(sessionId) as VariantRow | undefined;
    if (!v) {
      throw new NotFoundError(sessionId, "session");
    }
    const task = this.task(v.task_id);
    const worktree =
      v.worktree_id === null ? undefined : this.worktree(v.worktree_id);
    const env =
      v.env_id === null ? undefined : this.environmentOrUndefined(v.env_id);
    const branch = v.branch_id ?? worktree?.branch_id ?? null;
    return [
      ...this.variantTrail(v, seen),
      ...(branch === null ? [] : [this.branchStep(this.branch(branch))]),
      ...(worktree ? [this.worktreeStep(worktree)] : []),
      ...(env?.kind === "task" ? [this.environmentStep(env)] : []),
      this.sessionStep(v, task, worktree),
    ];
  }

  /** A pull request comes from the branch published as its head, newest first. */
  private pullTrail(p: PullRow, seen: Set<string>): ProvenanceStep[] {
    const head = this.db
      .prepare(
        "SELECT * FROM branches WHERE pull_request_id = ? AND pr_role = 'head' ORDER BY created_at DESC, id DESC LIMIT 1"
      )
      .get(p.id) as BranchRow | undefined;
    const self = this.pullStep(p);
    return head ? [...this.branchTrail(head, seen), self] : [self];
  }

  private reviewTrail(r: ReviewRow, seen: Set<string>): ProvenanceStep[] {
    const self = this.reviewStep(r);
    if (r.task_id !== null && this.has("tasks", "id", r.task_id)) {
      return [...this.trail("task", r.task_id, seen), self];
    }
    return [
      ...this.trail("pull_request", String(r.pull_request_id), seen),
      self,
    ];
  }

  /** Pull requests (with their reviews) the entity's branch or task led to; a ticket's tasks; a PR's reviews. */
  private ledTo(
    type: ObjectType,
    id: string,
    trail: ProvenanceStep[]
  ): ProvenanceStep[] {
    if (type === "ticket") {
      const tasks = this.db
        .prepare(
          "SELECT * FROM tasks WHERE ticket_id = ? ORDER BY created_at, id"
        )
        .all(Number(id)) as unknown as TaskRow[];
      return tasks.flatMap((t) => [
        this.taskStep(t),
        ...this.pullsOfTask(t.id),
      ]);
    }
    if (type === "pull_request") {
      return this.reviewsOfPulls([Number(id)]);
    }
    if (type === "review" || type === "project") {
      return [];
    }
    const branch = trail.findLast((s) => s.type === "branch");
    if (branch && type !== "task") {
      const pulls = this.db
        .prepare(
          "SELECT p.* FROM pull_requests p JOIN branches b ON b.pull_request_id = p.id WHERE b.id = ? AND b.pr_role = 'head'"
        )
        .all(Number(branch.id)) as unknown as PullRow[];
      return [
        ...pulls.map((p) => this.pullStep(p)),
        ...this.reviewsOfPulls(pulls.map((p) => p.id)),
      ];
    }
    const task = trail.findLast((s) => s.type === "task");
    return task ? this.pullsOfTask(task.id) : [];
  }

  /** The pull requests a task's variants were published as, their reviews, and a review task's own reviews. */
  private pullsOfTask(taskId: string): ProvenanceStep[] {
    const pulls = this.db
      .prepare(
        `SELECT DISTINCT p.* FROM variants v JOIN branches b ON b.id = v.branch_id
         JOIN pull_requests p ON p.id = b.pull_request_id
         WHERE v.task_id = ? AND b.pr_role = 'head' ORDER BY p.id`
      )
      .all(taskId) as unknown as PullRow[];
    const own = this.db
      .prepare(
        "SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at, id"
      )
      .all(taskId) as unknown as ReviewRow[];
    return [
      ...pulls.map((p) => this.pullStep(p)),
      ...this.reviewsOfPulls(pulls.map((p) => p.id)),
      ...own.map((r) => this.reviewStep(r)),
    ];
  }

  private reviewsOfPulls(ids: number[]): ProvenanceStep[] {
    if (ids.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews WHERE pull_request_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY created_at, id`
      )
      .all(...ids) as unknown as ReviewRow[];
    return rows.map((r) => this.reviewStep(r));
  }

  private projectStep(p: ProjectRow): ProvenanceStep {
    return step("project", p.id, p.name, {
      href: projectPath(p.id),
      removed: p.missing_since !== null,
    });
  }

  private taskStep(t: TaskRow): ProvenanceStep {
    return step(
      "task",
      t.id,
      t.title || (t.kind === "review" ? "Review" : "Task"),
      {
        href: `${projectPath(t.project_id)}/t/${enc(t.id)}`,
        removed: t.archived_at !== null,
      }
    );
  }

  private variantStep(v: VariantRow, t: TaskRow): ProvenanceStep {
    const model = modelName(v.model);
    return step(
      "variant",
      `${v.task_id}/${v.n}`,
      `Variant ${v.n}${model ? ` (${model})` : ""}`,
      {
        href: `${projectPath(t.project_id)}/t/${enc(t.id)}`,
        removed: v.discarded_at !== null,
      }
    );
  }

  private branchStep(b: BranchRow): ProvenanceStep {
    const live = this.db
      .prepare(
        "SELECT * FROM worktrees WHERE branch_id = ? AND removed_at IS NULL ORDER BY id DESC LIMIT 1"
      )
      .get(b.id) as WorktreeRow | undefined;
    return step("branch", b.id, b.name, {
      ...(live ? { href: worktreePath(live) } : {}),
      removed: b.deleted_at !== null,
      unmanaged: b.created_by === "unmanaged",
    });
  }

  private worktreeStep(w: WorktreeRow): ProvenanceStep {
    return step("worktree", w.id, folderName(w.path), {
      href: worktreePath(w),
      removed: w.removed_at !== null,
      unmanaged: w.created_by === "unmanaged",
    });
  }

  private environmentStep(e: EnvironmentRow): ProvenanceStep {
    const worktree =
      e.worktree_id === null ? undefined : this.worktree(e.worktree_id);
    return step(
      "environment",
      e.id,
      e.kind === "main" ? "Main container" : "Container",
      {
        href: worktree
          ? `${worktreePath(worktree)}/runtime`
          : `${projectPath(e.project_id)}/main/runtime`,
        removed: e.removed_at !== null,
      }
    );
  }

  private sessionStep(
    v: VariantRow,
    t: TaskRow,
    worktree: WorktreeRow | undefined
  ): ProvenanceStep {
    const checkout =
      worktree && worktree.removed_at === null
        ? worktreePath(worktree)
        : `${projectPath(t.project_id)}/main`;
    const id = v.session_id ?? "";
    return step(
      "session",
      id,
      t.kind === "task" ? "Session" : t.title || "Session",
      {
        href: `${checkout}/s/${enc(id)}`,
        removed: v.session_removed_at !== null,
      }
    );
  }

  private pullStep(p: PullRow): ProvenanceStep {
    const internal =
      p.forge === "forgejo" && p.owner && p.repo && p.number !== null
        ? `/forgejo/${enc(p.owner)}/${enc(p.repo)}/${p.number}`
        : undefined;
    return step(
      "pull_request",
      p.id,
      p.number === null ? "Pull request" : `PR #${p.number}`,
      {
        ...(internal ? { href: internal } : {}),
        url: p.url,
      }
    );
  }

  private ticketStep(t: TicketRow): ProvenanceStep {
    return step("ticket", t.id, t.key, {
      href: `/jira/${enc(t.key)}`,
      url: t.url,
    });
  }

  private reviewStep(r: ReviewRow): ProvenanceStep {
    const pull = this.pull(r.pull_request_id);
    const n = findingCount(r.findings);
    const { href, url } = this.pullStep(pull);
    return step(
      "review",
      r.id,
      `AI review · ${n} finding${n === 1 ? "" : "s"}`,
      {
        ...(href ? { href } : {}),
        ...(url ? { url } : {}),
      }
    );
  }

  private has(table: "tasks", column: "id", value: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`)
        .get(value) !== undefined
    );
  }

  private row<T>(sql: string, value: string | number, what: string): T {
    const r = this.db.prepare(sql).get(value) as T | undefined;
    if (!r) {
      throw new NotFoundError(String(value), what);
    }
    return r;
  }

  private project(id: string): ProjectRow {
    return this.row("SELECT * FROM projects WHERE id = ?", id, "project");
  }

  private task(id: string): TaskRow {
    return this.row("SELECT * FROM tasks WHERE id = ?", id, "task");
  }

  private variant(taskId: string, n: number): VariantRow {
    const v = this.variantOrUndefined(taskId, n);
    if (!v) {
      throw new NotFoundError(`${taskId}/${n}`, "variant");
    }
    return v;
  }

  private variantOrUndefined(
    taskId: string,
    n: number
  ): VariantRow | undefined {
    return this.db
      .prepare("SELECT * FROM variants WHERE task_id = ? AND n = ?")
      .get(taskId, n) as VariantRow | undefined;
  }

  private branch(id: number): BranchRow {
    return this.row("SELECT * FROM branches WHERE id = ?", id, "branch");
  }

  private worktree(id: number): WorktreeRow {
    return this.row("SELECT * FROM worktrees WHERE id = ?", id, "worktree");
  }

  private environment(id: string): EnvironmentRow {
    return this.row(
      "SELECT * FROM environments WHERE id = ?",
      id,
      "environment"
    );
  }

  private environmentOrUndefined(id: string): EnvironmentRow | undefined {
    return this.db
      .prepare("SELECT * FROM environments WHERE id = ?")
      .get(id) as EnvironmentRow | undefined;
  }

  private pull(id: number): PullRow {
    return this.row(
      "SELECT * FROM pull_requests WHERE id = ?",
      id,
      "pull request"
    );
  }

  private ticket(id: number): TicketRow {
    return this.row("SELECT * FROM tickets WHERE id = ?", id, "ticket");
  }

  private review(id: number): ReviewRow {
    return this.row("SELECT * FROM reviews WHERE id = ?", id, "review");
  }
}
