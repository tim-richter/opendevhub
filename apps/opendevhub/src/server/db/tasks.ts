import type { JiraTaskSource } from "../../shared/jira";
import type {
  EnvId,
  ModelRef,
  NodeId,
  ProjectId,
  SessionTaskRef,
  SpecPhase,
  StartStep,
  TaskKind,
  TaskStartSpec,
  TaskState,
  TaskView,
  VariantSpec,
  VariantView,
} from "../../shared/types";
import { newTaskId } from "../projects/ids";
import { transaction } from "./database";
import type { Db } from "./database";
import { SYSTEM, USER, record } from "./events";
import type { Actor, EventVerb } from "./events";

/** Steps a variant passes through before its session is created. */
const SETUP_STEPS: ReadonlySet<StartStep> = new Set([
  "queued",
  "pushing",
  "worktree",
  "image",
  "container",
]);

export const RESTART_ERROR = "interrupted: opendevhub restarted";

/** A task with what the snapshot leaves out. */
export interface TaskRecord extends TaskView {
  projectId: ProjectId;
  prompt?: string;
  archivedAt?: number;
}

export interface NewTask {
  id: string;
  projectId: ProjectId;
  title: string;
  prompt: string;
  jira?: JiraTaskSource;
  spec?: TaskStartSpec;
  createdAt: number;
  variants: { model?: ModelRef; agent?: string; node?: NodeId }[];
}

/** A session that gets a manual task: one opendevhub started outside a task, or one found in opencode. */
export interface ManualSession {
  projectId: ProjectId;
  sessionId: string;
  title: string;
  directory: string;
  envId: EnvId;
  branch?: string;
  createdAt: number;
}

export type VariantPatch = Partial<{
  step: StartStep;
  error: string;
  branch: string;
  directory: string;
  envId: EnvId;
}>;

interface RawTask {
  id: string;
  project_id: string;
  kind: TaskKind;
  title: string;
  prompt: string | null;
  jira: string | null;
  spec_first: number;
  proposed_in: string | null;
  implemented_in: string | null;
  created_at: number;
  archived_at: number | null;
}

interface RawVariant {
  task_id: string;
  n: number;
  model: string | null;
  agent: string | null;
  node_id: string | null;
  env_id: string | null;
  branch: string | null;
  directory: string | null;
  step: StartStep;
  error: string | null;
  session_id: string | null;
  session_removed_at: number | null;
  picked_at: number | null;
  discarded_at: number | null;
  spec_phase: SpecPhase | null;
  spec_change: string | null;
  spec_archived: string | null;
}

const parseJson = <T>(text: string | null): T | undefined => {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

const toVariant = (r: RawVariant): VariantView => {
  const model = parseJson<ModelRef>(r.model);
  const spec: VariantSpec | undefined = r.spec_phase
    ? {
        phase: r.spec_phase,
        ...(r.spec_change ? { change: r.spec_change } : {}),
        ...(r.spec_archived ? { archived: r.spec_archived } : {}),
      }
    : undefined;
  return {
    n: r.n,
    step: r.step,
    ...(model ? { model } : {}),
    ...(r.agent ? { agent: r.agent } : {}),
    ...(r.node_id ? { node: r.node_id } : {}),
    ...(r.env_id ? { envId: r.env_id } : {}),
    ...(r.branch ? { branch: r.branch } : {}),
    ...(r.directory ? { directory: r.directory } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.session_removed_at === null ? {} : { sessionRemoved: true }),
    ...(r.picked_at === null ? {} : { picked: true }),
    ...(r.discarded_at === null ? {} : { discarded: true }),
    ...(spec ? { spec } : {}),
  };
};

/** Being set up: its job hasn't created its session yet. */
const settingUp = (v: RawVariant): boolean =>
  SETUP_STEPS.has(v.step) || (v.step === "session" && v.session_id === null);

const live = (v: RawVariant): boolean =>
  v.session_id !== null &&
  v.session_removed_at === null &&
  v.discarded_at === null;

export const taskState = (variants: RawVariant[]): TaskState => {
  if (
    variants.some(
      (v) => settingUp(v) || (v.step === "failed" && v.discarded_at === null)
    )
  ) {
    return "starting";
  }
  return variants.some(live) ? "running" : "ended";
};

const toTask = (t: RawTask, variants: RawVariant[]): TaskRecord => {
  const jira = parseJson<JiraTaskSource>(t.jira);
  const spec =
    t.spec_first || t.proposed_in || t.implemented_in
      ? {
          first: t.spec_first === 1,
          ...(t.proposed_in ? { proposedIn: t.proposed_in } : {}),
          ...(t.implemented_in ? { implementedIn: t.implemented_in } : {}),
        }
      : undefined;
  return {
    createdAt: t.created_at,
    id: t.id,
    kind: t.kind,
    projectId: t.project_id,
    state: taskState(variants),
    title: t.title,
    variants: variants.map(toVariant),
    ...(jira ? { jira } : {}),
    ...(spec ? { spec } : {}),
    ...(t.prompt === null ? {} : { prompt: t.prompt }),
    ...(t.archived_at === null ? {} : { archivedAt: t.archived_at }),
  };
};

const claimKey = (env: EnvId, directory: string) => `${env}\0${directory}`;

/**
 * Tasks and their variants: the only record of which sessions belong to which task. Every change writes its events
 * in the same transaction; `subscribe` hears about each change.
 */
export class TaskStore {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly claims = new Map<string, number>();
  private refs?: Map<string, SessionTaskRef>;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** Records a task and its variants, all `queued`, before any is set up. */
  createTask(task: NewTask, actor: Actor = USER): void {
    const at = this.now();
    this.write(() => {
      const proposedIn =
        task.spec?.phase === "implement" && this.raw(task.spec.proposedIn)
          ? task.spec.proposedIn
          : undefined;
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, kind, title, prompt, jira, spec_first, proposed_in, created_at)
           VALUES (?, ?, 'task', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          task.id,
          task.projectId,
          task.title,
          task.prompt,
          task.jira ? JSON.stringify(task.jira) : null,
          task.spec?.phase === "propose" ? 1 : 0,
          proposedIn ?? null,
          task.createdAt
        );
      if (proposedIn) {
        this.db
          .prepare("UPDATE tasks SET implemented_in = ? WHERE id = ?")
          .run(task.id, proposedIn);
      }
      const insert = this.db.prepare(
        `INSERT INTO variants (task_id, n, model, agent, node_id, step, spec_phase, spec_change)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
      );
      for (const [i, v] of task.variants.entries()) {
        insert.run(
          task.id,
          i + 1,
          v.model ? JSON.stringify(v.model) : null,
          v.agent ?? null,
          v.node ?? null,
          task.spec?.phase ?? null,
          task.spec?.phase === "implement" ? task.spec.change : null
        );
      }
      this.event(
        at,
        actor,
        "task.started",
        task.projectId,
        task.id,
        {
          id: task.id,
          type: "task",
        },
        { kind: "task", title: task.title, variants: task.variants.length }
      );
    });
  }

  /** Records a variant's progress; moving to `failed` records why. */
  updateVariant(
    taskId: string,
    n: number,
    patch: VariantPatch,
    actor: Actor
  ): void {
    const at = this.now();
    this.write(() => {
      const task = this.raw(taskId);
      const before = this.variant(taskId, n);
      if (!task || !before) {
        return false;
      }
      const columns: [string, unknown][] = [];
      if (patch.step !== undefined) {
        columns.push(["step", patch.step]);
      }
      if (patch.error !== undefined) {
        columns.push(["error", patch.error]);
      }
      if (patch.branch !== undefined) {
        columns.push(["branch", patch.branch]);
      }
      if (patch.directory !== undefined) {
        columns.push(["directory", patch.directory]);
      }
      if (patch.envId !== undefined) {
        columns.push(["env_id", patch.envId]);
      }
      if (columns.length === 0) {
        return false;
      }
      const stateBefore = this.state(taskId);
      this.db
        .prepare(
          `UPDATE variants SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE task_id = ? AND n = ?`
        )
        .run(...(columns.map(([, v]) => v) as (string | number)[]), taskId, n);
      if (patch.step === "failed" && before.step !== "failed") {
        this.event(
          at,
          actor,
          "variant.failed",
          task.project_id,
          taskId,
          {
            id: `${taskId}/${n}`,
            type: "variant",
          },
          patch.error ? { error: patch.error } : undefined
        );
      }
      this.endedCheck(at, actor, task, stateBefore);
      return true;
    });
  }

  /** Links a variant to the session its job just created. */
  attachSession(
    taskId: string,
    n: number,
    session: { sessionId: string; envId: EnvId; directory: string },
    actor: Actor
  ): void {
    const at = this.now();
    this.write(() => {
      const task = this.raw(taskId);
      if (!task) {
        return false;
      }
      // A session reconcile adopted before this ran (a claim can't cover a crash) gives up its manual task.
      this.db
        .prepare(
          "DELETE FROM tasks WHERE kind = 'manual' AND id IN (SELECT task_id FROM variants WHERE session_id = ?)"
        )
        .run(session.sessionId);
      this.db
        .prepare(
          `UPDATE variants SET session_id = ?, env_id = ?, directory = ?, step = 'session', error = NULL,
           session_removed_at = NULL WHERE task_id = ? AND n = ?`
        )
        .run(session.sessionId, session.envId, session.directory, taskId, n);
      this.event(
        at,
        actor,
        "session.started",
        task.project_id,
        taskId,
        {
          id: session.sessionId,
          type: "session",
        },
        { variant: n }
      );
      return true;
    });
  }

  /** A manual task for a session opendevhub just started outside a task. Returns the session's task id. */
  startManual(session: ManualSession, actor: Actor = USER): string {
    return this.manual(session, actor, "session.started");
  }

  /** A manual task for a session found in opencode with no task; the existing one when it already has one. */
  adoptSession(session: ManualSession, actor: Actor = SYSTEM): string {
    return this.manual(session, actor, "session.adopted");
  }

  private manual(s: ManualSession, actor: Actor, verb: EventVerb): string {
    const existing = this.bySession(s.sessionId);
    if (existing) {
      return existing.task.id;
    }
    const at = this.now();
    // Ordered by when its session was created, as a task is by when it started.
    const id = newTaskId(s.createdAt);
    this.write(() => {
      this.db
        .prepare(
          "INSERT INTO tasks (id, project_id, kind, title, created_at) VALUES (?, ?, 'manual', ?, ?)"
        )
        .run(id, s.projectId, s.title, s.createdAt);
      this.db
        .prepare(
          `INSERT INTO variants (task_id, n, env_id, branch, directory, step, session_id)
           VALUES (?, 1, ?, ?, ?, 'session', ?)`
        )
        .run(id, s.envId, s.branch ?? null, s.directory, s.sessionId);
      this.event(
        at,
        actor,
        "task.started",
        s.projectId,
        id,
        {
          id,
          type: "task",
        },
        { kind: "manual", title: s.title }
      );
      this.event(
        at,
        actor,
        verb,
        s.projectId,
        id,
        {
          id: s.sessionId,
          type: "session",
        },
        { variant: 1 }
      );
    });
    return id;
  }

  /** A manual task's title follows its session's. */
  setManualTitle(sessionId: string, title: string): void {
    this.write(
      () =>
        Number(
          this.db
            .prepare(
              `UPDATE tasks SET title = ? WHERE kind = 'manual' AND title <> ?
               AND id = (SELECT task_id FROM variants WHERE session_id = ?)`
            )
            .run(title, title, sessionId).changes
        ) > 0
    );
  }

  /**
   * After a successful listing of `envId`'s sessions: marks its variants' sessions that aren't `listed` removed,
   * and clears the mark on those listed again.
   */
  markSessionsGone(
    envId: EnvId,
    listed: ReadonlySet<string>,
    actor: Actor = SYSTEM
  ): void {
    const at = this.now();
    const rows = this.db
      .prepare(
        "SELECT * FROM variants WHERE env_id = ? AND session_id IS NOT NULL"
      )
      .all(envId) as unknown as RawVariant[];
    const gone = rows.filter(
      (v) => v.session_removed_at === null && !listed.has(v.session_id ?? "")
    );
    const back = rows.filter(
      (v) => v.session_removed_at !== null && listed.has(v.session_id ?? "")
    );
    if (gone.length === 0 && back.length === 0) {
      return;
    }
    this.write(() => {
      const before = new Map(
        [...new Set(gone.map((v) => v.task_id))].map((t) => [t, this.state(t)])
      );
      for (const v of back) {
        this.db
          .prepare(
            "UPDATE variants SET session_removed_at = NULL WHERE task_id = ? AND n = ?"
          )
          .run(v.task_id, v.n);
      }
      for (const v of gone) {
        const task = this.raw(v.task_id);
        this.db
          .prepare(
            "UPDATE variants SET session_removed_at = ? WHERE task_id = ? AND n = ?"
          )
          .run(at, v.task_id, v.n);
        this.event(
          at,
          actor,
          "session.removed",
          task?.project_id,
          v.task_id,
          {
            id: v.session_id ?? "",
            type: "session",
          },
          { variant: v.n }
        );
      }
      for (const [taskId, stateBefore] of before) {
        const task = this.raw(taskId);
        if (task) {
          this.endedCheck(at, actor, task, stateBefore);
        }
      }
    });
  }

  /** The sessions of `envId`'s variants not marked removed. */
  liveSessionsIn(envId: EnvId): string[] {
    return (
      this.db
        .prepare(
          "SELECT session_id FROM variants WHERE env_id = ? AND session_id IS NOT NULL AND session_removed_at IS NULL"
        )
        .all(envId) as { session_id: string }[]
    ).map((r) => r.session_id);
  }

  /** Keeps variant `keep`: records the pick on it and the discard on every other variant not yet discarded. */
  pick(taskId: string, keep: number, actor: Actor = USER): void {
    const at = this.now();
    this.write(() => {
      const task = this.raw(taskId);
      if (!task) {
        return false;
      }
      const stateBefore = this.state(taskId);
      for (const v of this.variants(taskId)) {
        const object = { id: `${taskId}/${v.n}`, type: "variant" as const };
        if (v.n === keep) {
          if (v.picked_at === null) {
            this.db
              .prepare(
                "UPDATE variants SET picked_at = ? WHERE task_id = ? AND n = ?"
              )
              .run(at, taskId, v.n);
            this.event(
              at,
              actor,
              "variant.picked",
              task.project_id,
              taskId,
              object
            );
          }
        } else if (v.discarded_at === null) {
          this.discard(at, actor, task, v.n);
        }
      }
      this.endedCheck(at, actor, task, stateBefore);
      return true;
    });
  }

  /** Records a spec-first variant's phase, change or archive folder. */
  setSpec(taskId: string, n: number, spec: Partial<VariantSpec>): void {
    const columns: [string, string][] = [];
    if (spec.phase !== undefined) {
      columns.push(["spec_phase", spec.phase]);
    }
    if (spec.change !== undefined) {
      columns.push(["spec_change", spec.change]);
    }
    if (spec.archived !== undefined) {
      columns.push(["spec_archived", spec.archived]);
    }
    if (columns.length === 0) {
      return;
    }
    this.write(
      () =>
        Number(
          this.db
            .prepare(
              `UPDATE variants SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE task_id = ? AND n = ?`
            )
            .run(...columns.map(([, v]) => v), taskId, n).changes
        ) > 0
    );
  }

  /** Stops listing the task's failed variants as starting. False when there is no such task. */
  dismissStarting(taskId: string, actor: Actor = USER): boolean {
    const at = this.now();
    return this.write(() => {
      const task = this.raw(taskId);
      if (!task) {
        return false;
      }
      const stateBefore = this.state(taskId);
      for (const v of this.variants(taskId)) {
        if (v.step === "failed" && v.discarded_at === null) {
          this.discard(at, actor, task, v.n);
        }
      }
      this.endedCheck(at, actor, task, stateBefore);
      return true;
    });
  }

  /** Hides the task from the dashboard; its rows are kept. False when there is no such task. */
  archive(taskId: string, actor: Actor = USER): boolean {
    const at = this.now();
    return this.write(() => {
      const task = this.raw(taskId);
      if (!task) {
        return false;
      }
      if (task.archived_at !== null) {
        return true;
      }
      this.db
        .prepare("UPDATE tasks SET archived_at = ? WHERE id = ?")
        .run(at, taskId);
      this.event(at, actor, "task.archived", task.project_id, taskId, {
        id: taskId,
        type: "task",
      });
      return true;
    });
  }

  /**
   * On start: a variant still being set up lost the job that was setting it up. Marks each failed, and returns
   * how many.
   */
  failInterrupted(): number {
    const at = this.now();
    const stuck = (
      this.db
        .prepare(
          "SELECT * FROM variants WHERE session_id IS NULL AND step NOT IN ('failed')"
        )
        .all() as unknown as RawVariant[]
    ).filter(settingUp);
    if (stuck.length === 0) {
      return 0;
    }
    this.write(() => {
      for (const v of stuck) {
        const task = this.raw(v.task_id);
        this.db
          .prepare(
            "UPDATE variants SET step = 'failed', error = ? WHERE task_id = ? AND n = ?"
          )
          .run(RESTART_ERROR, v.task_id, v.n);
        this.event(
          at,
          SYSTEM,
          "variant.failed",
          task?.project_id,
          v.task_id,
          {
            id: `${v.task_id}/${v.n}`,
            type: "variant",
          },
          { error: RESTART_ERROR }
        );
      }
    });
    return stuck.length;
  }

  /** The project's tasks that are not archived, oldest first. */
  listForProject(projectId: ProjectId): TaskRecord[] {
    const tasks = this.db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at, id"
      )
      .all(projectId) as unknown as RawTask[];
    if (tasks.length === 0) {
      return [];
    }
    const variants = this.db
      .prepare(
        `SELECT v.* FROM variants v JOIN tasks t ON t.id = v.task_id
         WHERE t.project_id = ? AND t.archived_at IS NULL ORDER BY v.task_id, v.n`
      )
      .all(projectId) as unknown as RawVariant[];
    const byTask = new Map<string, RawVariant[]>();
    for (const v of variants) {
      byTask.set(v.task_id, [...(byTask.get(v.task_id) ?? []), v]);
    }
    return tasks.map((t) => toTask(t, byTask.get(t.id) ?? []));
  }

  /** When anything last happened to a task: its newest event, else its creation. */
  lastActivity(taskId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE((SELECT MAX(at) FROM events WHERE task_id = t.id), 0), t.created_at) AS at
         FROM tasks t WHERE t.id = ?`
      )
      .get(taskId) as { at: number | null } | undefined;
    return row?.at ?? undefined;
  }

  /** A task, archived or not. */
  get(taskId: string): TaskRecord | undefined {
    const t = this.raw(taskId);
    return t ? toTask(t, this.variants(taskId)) : undefined;
  }

  /** The task and variant a session belongs to. */
  bySession(
    sessionId: string
  ): { task: TaskRecord; variant: VariantView } | undefined {
    const v = this.db
      .prepare("SELECT * FROM variants WHERE session_id = ?")
      .get(sessionId) as RawVariant | undefined;
    const task = v && this.get(v.task_id);
    const variant = task?.variants.find((x) => x.n === v?.n);
    return task && variant ? { task, variant } : undefined;
  }

  /** What a session in the snapshot says about its task; cached until the next change. */
  sessionRef(sessionId: string): SessionTaskRef | undefined {
    if (!this.refs) {
      const rows = this.db
        .prepare(
          `SELECT v.session_id AS session, v.task_id AS id, t.kind AS kind, v.n AS n, v.discarded_at AS discarded
           FROM variants v JOIN tasks t ON t.id = v.task_id WHERE v.session_id IS NOT NULL`
        )
        .all() as unknown as {
        session: string;
        id: string;
        kind: TaskKind;
        n: number;
        discarded: number | null;
      }[];
      this.refs = new Map(
        rows.map((r) => [
          r.session,
          { discarded: r.discarded !== null, id: r.id, kind: r.kind, n: r.n },
        ])
      );
    }
    return this.refs.get(sessionId);
  }

  /**
   * Marks `directory` in `env` as getting a session from opendevhub, until the returned release is called: reconcile
   * leaves unknown sessions there alone, since the creator is about to attach them.
   */
  claim(env: EnvId, directory: string): () => void {
    const key = claimKey(env, directory);
    this.claims.set(key, (this.claims.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const left = (this.claims.get(key) ?? 1) - 1;
      if (left > 0) {
        this.claims.set(key, left);
      } else {
        this.claims.delete(key);
      }
    };
  }

  isClaimed(env: EnvId, directory: string): boolean {
    return this.claims.has(claimKey(env, directory));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Runs `fn` in a transaction and tells the listeners, unless it returned false (nothing changed). */
  private write<T>(fn: () => T): T {
    const result = transaction(this.db, fn);
    if (result !== false) {
      this.refs = undefined;
      for (const listener of this.listeners) {
        listener();
      }
    }
    return result;
  }

  private discard(at: number, actor: Actor, task: RawTask, n: number): void {
    this.db
      .prepare(
        "UPDATE variants SET discarded_at = ? WHERE task_id = ? AND n = ?"
      )
      .run(at, task.id, n);
    this.event(at, actor, "variant.discarded", task.project_id, task.id, {
      id: `${task.id}/${n}`,
      type: "variant",
    });
  }

  private endedCheck(
    at: number,
    actor: Actor,
    task: RawTask,
    before: TaskState
  ): void {
    if (before !== "ended" && this.state(task.id) === "ended") {
      this.event(at, actor, "task.ended", task.project_id, task.id, {
        id: task.id,
        type: "task",
      });
    }
  }

  private event(
    at: number,
    actor: Actor,
    verb: EventVerb,
    projectId: string | undefined,
    taskId: string,
    object: { id: string; type: "task" | "variant" | "session" },
    data?: Record<string, unknown>
  ): void {
    record(this.db, {
      actor,
      at,
      object,
      taskId,
      verb,
      ...(projectId ? { projectId } : {}),
      ...(data ? { data } : {}),
    });
  }

  private state(taskId: string): TaskState {
    return taskState(this.variants(taskId));
  }

  private raw(taskId: string): RawTask | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | RawTask
      | undefined;
  }

  private variant(taskId: string, n: number): RawVariant | undefined {
    return this.db
      .prepare("SELECT * FROM variants WHERE task_id = ? AND n = ?")
      .get(taskId, n) as RawVariant | undefined;
  }

  private variants(taskId: string): RawVariant[] {
    return this.db
      .prepare("SELECT * FROM variants WHERE task_id = ? ORDER BY n")
      .all(taskId) as unknown as RawVariant[];
  }
}
