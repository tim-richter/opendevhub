import { jiraTicketUrl } from "../../shared/jira";
import type { JiraTaskSource } from "../../shared/jira";
import type {
  ArchivedTask,
  EnvId,
  ModelRef,
  NodeId,
  ProjectId,
  SessionTaskRef,
  SpecPhase,
  StartStep,
  TaskKind,
  TaskPlan,
  TaskStartSpec,
  TaskState,
  TaskView,
  VariantSpec,
  VariantView,
} from "../../shared/types";
import { newTaskId } from "../projects/ids";
import type { ChatRecord } from "./chats";
import { transaction } from "./database";
import type { Db } from "./database";
import { SYSTEM, USER, record } from "./events";
import type { Actor, EventVerb } from "./events";
import {
  ensurePullIn,
  ensureTicketIn,
  linkBranchIn,
  linkTicketIn,
} from "./links";
import { RESTART_ERROR, settingUp, taskState } from "./task-state";

export { RESTART_ERROR } from "./task-state";

/** A chat a task already adopted, or that has no session to adopt. */
export class ChatTakenError extends Error {
  constructor(chat: string) {
    super(`chat ${chat} already belongs to a task or has no conversation`);
    this.name = "ChatTakenError";
  }
}

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
  /** None for a draft. */
  variants: NewVariant[];
  /** A draft's requested variants and options, kept for Start to prefill its dialog. */
  plan?: TaskPlan;
}

export interface NewVariant {
  model?: ModelRef;
  agent?: string;
  node?: NodeId;
}

export type DraftPatch = Partial<{
  title: string;
  prompt: string;
  plan: TaskPlan;
  /** Whether it starts by proposing an OpenSpec change. */
  specFirst: boolean;
}>;

/** A session opendevhub just started to review a pull request: it gets a review task of its own. */
export interface ReviewSession {
  projectId: ProjectId;
  sessionId: string;
  title: string;
  directory: string;
  envId: EnvId;
  branch?: string;
  createdAt: number;
  /** The pull request row it reviews. */
  reviewOf: number;
}

/** The chat a task adopts as its variant 1, and what the new task records. */
export interface ChatAdoption {
  chat: ChatRecord;
  task: {
    id: string;
    title: string;
    prompt: string;
    createdAt: number;
    jira?: JiraTaskSource;
    /** A pull request the user linked; the chat's branch becomes its head. */
    pullUrl?: string;
    specFirst: boolean;
    model?: ModelRef;
    agent?: string;
  };
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
  ticket_id: number | null;
  pull_request_id: number | null;
  spec_first: number;
  proposed_in: string | null;
  implemented_in: string | null;
  created_at: number;
  archived_at: number | null;
  plan: string | null;
  /** The chat it adopted as variant 1, when it was made from one. */
  from_chat?: string | null;
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

const toTask = (t: RawTask, variants: RawVariant[]): TaskRecord => {
  const jira = parseJson<JiraTaskSource>(t.jira);
  const plan = parseJson<TaskPlan>(t.plan);
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
    ...(plan ? { plan } : {}),
    ...(t.from_chat ? { fromChat: t.from_chat } : {}),
    ...(t.archived_at === null ? {} : { archivedAt: t.archived_at }),
  };
};

const TASK_SELECT = `SELECT t.*, (SELECT c.id FROM chats c WHERE c.adopted_task = t.id LIMIT 1) AS from_chat
  FROM tasks t`;

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
  /** Told after every change, since some change chats too (an adoption, a session taken over from a chat). */
  private readonly chatsChanged?: () => void;

  constructor(db: Db, now: () => number = Date.now, chatsChanged?: () => void) {
    this.db = db;
    this.now = now;
    this.chatsChanged = chatsChanged;
  }

  /**
   * Records a task and its variants, all `queued`, before any is set up. A task with no variants is a draft, and
   * keeps `plan` for when it starts.
   */
  createTask(task: NewTask, actor: Actor = USER): void {
    const at = this.now();
    const draft = task.variants.length === 0;
    this.write(() => {
      const proposedIn =
        task.spec?.phase === "implement" && this.raw(task.spec.proposedIn)
          ? task.spec.proposedIn
          : undefined;
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, kind, title, prompt, jira, spec_first, proposed_in, created_at, plan)
           VALUES (?, ?, 'task', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          task.id,
          task.projectId,
          task.title,
          task.prompt,
          task.jira ? JSON.stringify(task.jira) : null,
          task.spec?.phase === "propose" ? 1 : 0,
          proposedIn ?? null,
          task.createdAt,
          task.plan ? JSON.stringify(task.plan) : null
        );
      if (proposedIn) {
        this.db
          .prepare("UPDATE tasks SET implemented_in = ? WHERE id = ?")
          .run(task.id, proposedIn);
      }
      this.insertVariants(task.id, 1, task.variants, task.spec);
      this.event(
        at,
        actor,
        draft ? "task.drafted" : "task.started",
        task.projectId,
        task.id,
        {
          id: task.id,
          type: "task",
        },
        draft
          ? { kind: "task", title: task.title }
          : { kind: "task", title: task.title, variants: task.variants.length }
      );
      if (task.jira) {
        this.linkJira(at, actor, task.projectId, task.id, task.jira);
      }
    });
  }

  /**
   * Adds variants to a task of kind `task`, numbered after its highest, all `queued`: a draft starts, or a task
   * made from a chat gets more. A draft that starts records `task.started`. Returns the new variants' numbers.
   */
  addVariants(
    taskId: string,
    variants: readonly NewVariant[],
    actor: Actor = USER
  ): number[] {
    const at = this.now();
    let added: number[] = [];
    this.write(() => {
      const task = this.raw(taskId);
      if (!task || task.kind !== "task") {
        throw new Error(`not a task that takes variants: ${taskId}`);
      }
      const max = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(n), 0) AS n FROM variants WHERE task_id = ?"
          )
          .get(taskId) as { n: number }
      ).n;
      const spec: TaskStartSpec | undefined =
        task.spec_first === 1 ? { phase: "propose" } : undefined;
      added = this.insertVariants(taskId, max + 1, variants, spec);
      if (max === 0) {
        this.db
          .prepare("UPDATE tasks SET plan = NULL WHERE id = ?")
          .run(taskId);
        this.event(
          at,
          actor,
          "task.started",
          task.project_id,
          taskId,
          { id: taskId, type: "task" },
          { kind: "task", title: task.title, variants: variants.length }
        );
      }
      for (const n of added) {
        this.event(at, actor, "variant.added", task.project_id, taskId, {
          id: `${taskId}/${n}`,
          type: "variant",
        });
      }
    });
    return added;
  }

  /** Changes a draft's title, brief or plan. False when there is no such draft. */
  updateDraft(taskId: string, patch: DraftPatch): boolean {
    const columns: [string, string][] = [];
    if (patch.title !== undefined) {
      columns.push(["title", patch.title]);
    }
    if (patch.prompt !== undefined) {
      columns.push(["prompt", patch.prompt]);
    }
    if (patch.plan !== undefined) {
      columns.push(["plan", JSON.stringify(patch.plan)]);
    }
    if (patch.specFirst !== undefined) {
      columns.push(["spec_first", patch.specFirst ? "1" : "0"]);
    }
    return this.write(() => {
      if (this.variants(taskId).length > 0 || !this.raw(taskId)) {
        return false;
      }
      if (columns.length > 0) {
        this.db
          .prepare(
            `UPDATE tasks SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`
          )
          .run(...columns.map(([, v]) => v), taskId);
      }
      return true;
    });
  }

  /**
   * Makes a task of the chat: a task of kind `task` whose variant 1 is the chat's session, environment, directory,
   * branch and worktree, with step `session`. In the same transaction the chat records its adopter and the
   * `chat.adopted` event, and the ticket and pull request are linked. Throws when the chat was adopted meanwhile or
   * its session already belongs to a variant.
   */
  adoptChat(adoption: ChatAdoption, actor: Actor = USER): void {
    const { chat, task } = adoption;
    const at = this.now();
    this.write(() => {
      const row = this.db
        .prepare("SELECT adopted_task, session_id FROM chats WHERE id = ?")
        .get(chat.id) as
        | { adopted_task: string | null; session_id: string | null }
        | undefined;
      if (!row?.session_id || row.adopted_task !== null) {
        throw new ChatTakenError(chat.id);
      }
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, kind, title, prompt, jira, spec_first, created_at)
           VALUES (?, ?, 'task', ?, ?, ?, ?, ?)`
        )
        .run(
          task.id,
          chat.projectId,
          task.title,
          task.prompt,
          task.jira ? JSON.stringify(task.jira) : null,
          task.specFirst ? 1 : 0,
          task.createdAt
        );
      const branchId =
        chat.branchId ??
        (chat.branch
          ? (
              this.db
                .prepare(
                  "SELECT id FROM branches WHERE project_id = ? AND name = ?"
                )
                .get(chat.projectId, chat.branch) as { id: number } | undefined
            )?.id
          : undefined);
      this.db
        .prepare(
          `INSERT INTO variants (task_id, n, model, agent, env_id, branch, directory, branch_id, worktree_id, step,
             session_id, session_removed_at, spec_phase)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'session', ?, ?, ?)`
        )
        .run(
          task.id,
          task.model ? JSON.stringify(task.model) : null,
          task.agent ?? null,
          chat.envId ?? null,
          chat.branch ?? null,
          chat.directory ?? null,
          branchId ?? null,
          chat.worktreeId ?? null,
          row.session_id,
          chat.sessionRemoved ? at : null,
          task.specFirst ? "propose" : null
        );
      this.db
        .prepare(
          "UPDATE chats SET adopted_task = ?, adopted_variant = 1 WHERE id = ?"
        )
        .run(task.id, chat.id);
      this.event(
        at,
        actor,
        "task.started",
        chat.projectId,
        task.id,
        { id: task.id, type: "task" },
        { chat: chat.id, kind: "task", title: task.title, variants: 1 }
      );
      record(this.db, {
        actor,
        at,
        data: { session: row.session_id, task: task.id, title: chat.title },
        object: { id: chat.id, type: "chat" },
        projectId: chat.projectId,
        taskId: task.id,
        verb: "chat.adopted",
      });
      if (task.jira) {
        this.linkJira(at, actor, chat.projectId, task.id, task.jira);
      }
      if (task.pullUrl && branchId !== undefined) {
        const pull = ensurePullIn(this.db, task.pullUrl);
        linkBranchIn(this.db, at, actor, branchId, pull.id, "head");
      }
    });
  }

  private insertVariants(
    taskId: string,
    first: number,
    variants: readonly NewVariant[],
    spec: TaskStartSpec | undefined
  ): number[] {
    const insert = this.db.prepare(
      `INSERT INTO variants (task_id, n, model, agent, node_id, step, spec_phase, spec_change)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
    );
    return variants.map((v, i) => {
      insert.run(
        taskId,
        first + i,
        v.model ? JSON.stringify(v.model) : null,
        v.agent ?? null,
        v.node ?? null,
        spec?.phase ?? null,
        spec?.phase === "implement" ? spec.change : null
      );
      return first + i;
    });
  }

  private linkJira(
    at: number,
    actor: Actor,
    projectId: string,
    taskId: string,
    jira: JiraTaskSource
  ): void {
    const ticket = ensureTicketIn(this.db, {
      instanceUrl: jira.instanceUrl,
      key: jira.key,
      title: jira.title,
      url: jiraTicketUrl(jira),
    });
    linkTicketIn(this.db, at, actor, projectId, taskId, ticket);
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
      this.db
        .prepare(
          "INSERT OR IGNORE INTO task_sessions (session_id, task_id, n) SELECT session_id, task_id, n FROM variants WHERE task_id = ? AND n = ? AND session_id IS NOT NULL"
        )
        .run(taskId, n);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO task_sessions (session_id, task_id, n) VALUES (?, ?, ?)"
        )
        .run(session.sessionId, taskId, n);
      // A session reconcile adopted before this ran (a claim can't cover a crash) stops being a chat.
      this.db
        .prepare(
          "DELETE FROM chats WHERE session_id = ? AND adopted_task IS NULL"
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

  /** A review task for a session opendevhub just started to review a pull request. Returns its id. */
  startReview(s: ReviewSession, actor: Actor = USER): string {
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
          "INSERT INTO tasks (id, project_id, kind, title, pull_request_id, created_at) VALUES (?, ?, 'review', ?, ?, ?)"
        )
        .run(id, s.projectId, s.title, s.reviewOf, s.createdAt);
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
        { kind: "review", title: s.title }
      );
      this.event(
        at,
        actor,
        "session.started",
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

  /** Archived tasks for the project card, newest archive first. */
  listArchivedForProject(projectId: ProjectId): ArchivedTask[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.title, t.kind, t.archived_at AS archivedAt,
                COUNT(v.n) AS variants
         FROM tasks t LEFT JOIN variants v ON v.task_id = t.id
         WHERE t.project_id = ? AND t.archived_at IS NOT NULL
         GROUP BY t.id ORDER BY t.archived_at DESC, t.id DESC`
      )
      .all(projectId) as unknown as ArchivedTask[];
    return rows;
  }

  /** Returns an archived task to the live project list. */
  restore(taskId: string, actor: Actor = USER): boolean {
    const at = this.now();
    return this.write(() => {
      const task = this.raw(taskId);
      if (!task || task.archived_at === null) {
        return false;
      }
      this.db
        .prepare("UPDATE tasks SET archived_at = NULL WHERE id = ?")
        .run(taskId);
      this.event(at, actor, "task.restored", task.project_id, taskId, {
        id: taskId,
        type: "task",
      });
      return true;
    });
  }

  /** Deletes only an archived task's database record; external sessions and worktrees stay. */
  deleteArchived(taskId: string, actor: Actor = USER): boolean {
    const at = this.now();
    return this.write(() => {
      const task = this.raw(taskId);
      if (!task || task.archived_at === null) {
        return false;
      }
      this.db
        .prepare(
          "UPDATE branches SET created_by_task = NULL, created_by_variant = NULL WHERE created_by_task = ?"
        )
        .run(taskId);
      this.db
        .prepare("UPDATE tasks SET proposed_in = NULL WHERE proposed_in = ?")
        .run(taskId);
      this.db
        .prepare(
          "UPDATE tasks SET implemented_in = NULL WHERE implemented_in = ?"
        )
        .run(taskId);
      this.db
        .prepare("UPDATE reviews SET task_id = NULL WHERE task_id = ?")
        .run(taskId);
      this.db
        .prepare(
          "UPDATE chats SET adopted_task = NULL, adopted_variant = NULL, archived_at = COALESCE(archived_at, ?) WHERE adopted_task = ?"
        )
        .run(at, taskId);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      this.event(
        at,
        actor,
        "task.deleted",
        task.project_id,
        taskId,
        {
          id: taskId,
          type: "task",
        },
        { title: task.title }
      );
      return true;
    });
  }

  /** Conversations still present for an archived task, including earlier tabs, with the environment of each. */
  liveSessions(taskId: string): { sessionId: string; envId?: EnvId }[] {
    const rows = this.db
      .prepare(`
      SELECT session_id, env_id FROM variants WHERE task_id = ? AND session_id IS NOT NULL AND session_removed_at IS NULL
      UNION
      SELECT s.session_id, v.env_id FROM task_sessions s JOIN variants v ON v.task_id = s.task_id AND v.n = s.n
      WHERE s.task_id = ? AND v.session_removed_at IS NULL
    `)
      .all(taskId, taskId) as { session_id: string; env_id: EnvId | null }[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      ...(row.env_id === null ? {} : { envId: row.env_id }),
    }));
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
        `${TASK_SELECT} WHERE t.project_id = ? AND t.archived_at IS NULL ORDER BY t.created_at, t.id`
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
      .prepare(`SELECT v.* FROM variants v WHERE v.session_id = ?1 OR EXISTS
        (SELECT 1 FROM task_sessions s WHERE s.session_id = ?1 AND s.task_id = v.task_id AND s.n = v.n)`)
      .get(sessionId) as RawVariant | undefined;
    const task = v && this.get(v.task_id);
    const variant = task?.variants.find((x) => x.n === v?.n);
    return task && variant ? { task, variant } : undefined;
  }

  /** Hides one task conversation while keeping it in opencode until cleanup deletes it. */
  archiveSession(sessionId: string): boolean {
    return this.write(() => {
      const result = this.db
        .prepare(
          "UPDATE task_sessions SET archived_at = ? WHERE session_id = ? AND archived_at IS NULL"
        )
        .run(this.now(), sessionId);
      return result.changes > 0;
    });
  }

  isSessionArchived(sessionId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM task_sessions WHERE session_id = ? AND archived_at IS NOT NULL"
      )
      .get(sessionId);
  }

  /** What a session in the snapshot says about its task; cached until the next change. */
  sessionRef(sessionId: string): SessionTaskRef | undefined {
    if (!this.refs) {
      const rows = this.db
        .prepare(
          `SELECT v.session_id AS session, v.task_id AS id, t.kind AS kind, v.n AS n, v.discarded_at AS discarded
           FROM variants v JOIN tasks t ON t.id = v.task_id WHERE v.session_id IS NOT NULL
           UNION
           SELECT s.session_id AS session, s.task_id AS id, t.kind AS kind, s.n AS n, v.discarded_at AS discarded
           FROM task_sessions s JOIN tasks t ON t.id = s.task_id
           JOIN variants v ON v.task_id = s.task_id AND v.n = s.n`
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
          {
            discarded: r.discarded !== null,
            id: r.id,
            kind: r.kind,
            n: r.n,
          },
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
      this.chatsChanged?.();
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
    return this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId) as
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
