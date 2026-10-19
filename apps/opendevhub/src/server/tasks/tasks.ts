import { deriveTitle, variantLabels, variantTitle } from "../../shared/tasks";
import type {
  ArchivedTask,
  NodeId,
  PickResult,
  Project,
  ProjectId,
  TaskPlan,
  TaskRequest,
  TaskResult,
  TaskStartSpec,
  TaskVariantSpec,
} from "../../shared/types";
import { USER, variantActor } from "../db/events";
import { DraftStartedError } from "../db/tasks";
import type { TaskRecord } from "../db/tasks";
import { CommandError } from "../environments/containers";
import type { Environments } from "../environments/environments";
import type { HubDeps, NodeKit } from "../environments/ports";
import { ConflictError, NotFoundError, UnavailableError } from "../errors";
import type { CleanupTargets } from "../git/cleanup-targets";
import { InvalidRequestError } from "../git/worktrees";
import { LOCAL_NODE } from "../nodes/host";
import type { OpencodeClient } from "../opencode/client";
import { TASK_ID, newTaskId } from "../projects/ids";
import { CheckoutSetup, NO_WORKTREE_MOUNT } from "./checkout-setup";
import type { FirstTurn, SetupSink } from "./checkout-setup";
import { APPLY_COMMAND, PROPOSE_COMMAND } from "./openspec";
import { TITLE_LIMIT, parseJiraTaskSource, parseTaskRequest } from "./request";

/** A checked request to start variants, with what setting them up needs. */
interface Prepared {
  req: TaskRequest;
  project: Project;
  client: OpencodeClient;
  node: NodeId;
  remoteKit?: NodeKit;
  base?: string;
}

/** What a draft keeps of a request so that Start can prefill its dialog. */
const planOf = (req: TaskRequest): TaskPlan => ({
  variants: req.variants,
  where: req.where,
  ...(req.directory ? { directory: req.directory } : {}),
  ...(req.branch ? { branch: req.branch } : {}),
  ...(req.base ? { base: req.base } : {}),
  ...(req.environment ? { environment: req.environment } : {}),
  ...(req.node ? { node: req.node } : {}),
  ...(req.spec ? { spec: true } : {}),
});

/** What a variant's session starts with: the prompt, the composer's message, `opsx-propose <prompt>`, or `opsx-apply <change>`. */
const firstTurn = (req: TaskRequest): FirstTurn => {
  if (req.spec?.phase === "implement") {
    return { command: APPLY_COMMAND, text: req.spec.change };
  }
  if (req.spec) {
    return { command: PROPOSE_COMMAND, text: req.prompt };
  }
  return req.message ? { message: req.message } : { text: req.prompt };
};

/** Tasks: one prompt run as one or more variants, each in its own worktree (and environment) or the main checkout. */
export class Tasks {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  private readonly setup: CheckoutSetup;
  private readonly conversations?: Pick<CleanupTargets, "cleanupConversation">;
  constructor(
    deps: HubDeps,
    envs: Environments,
    setup?: CheckoutSetup,
    conversations?: Pick<CleanupTargets, "cleanupConversation">
  ) {
    this.deps = deps;
    this.envs = envs;
    this.setup = setup ?? new CheckoutSetup(deps, envs);
    this.conversations = conversations;
  }

  /**
   * Starts a task and waits until every variant runs or failed. For each variant: a worktree (unless it runs in
   * the main checkout), a session recorded on the variant's row, and the prompt. Worktrees are created in
   * order under one git lock; a failing variant is recorded on its result and the others still run, and worktrees
   * already created are kept. Isolated variants then start their own containers in parallel and get their sessions there.
   */
  async createTask(
    id: ProjectId,
    body: Record<string, unknown>
  ): Promise<TaskResult> {
    const result3 = await this.beginTask(id, body);
    return result3.done;
  }

  /**
   * Like createTask, but answers once the request is checked: the variants are set up in the background, and
   * the snapshot's task shows each one's step and log until its session exists. `spec` replaces the
   * body's: only the server starts a task implementing a change, once its spec is approved.
   */
  async startTask(
    id: ProjectId,
    body: Record<string, unknown>,
    spec?: TaskStartSpec
  ): Promise<TaskResult> {
    const { task, done } = await this.beginTask(id, body, spec);
    void done.catch(() => undefined);
    return { task, variants: [] };
  }

  /** Stops listing a starting task's failed variants; the task's rows are kept. */
  dismissStarting(id: ProjectId, task: string): void {
    this.envs.requireProject(id);
    if (
      this.deps.tasks.get(task)?.projectId !== id ||
      !this.deps.tasks.dismissStarting(task, USER)
    ) {
      throw new NotFoundError(task, "starting task");
    }
  }

  /** Hides a task from the dashboard; its sessions and worktrees are left as they are. */
  archiveTask(id: ProjectId, task: string): void {
    this.envs.requireProject(id);
    if (!TASK_ID.test(task)) {
      throw new InvalidRequestError(`not a task id: ${task}`);
    }
    if (
      this.deps.tasks.get(task)?.projectId !== id ||
      !this.deps.tasks.archive(task, USER)
    ) {
      throw new NotFoundError(task, "task");
    }
  }

  archivedTasks(id: ProjectId): ArchivedTask[] {
    this.envs.requireProject(id);
    return this.deps.tasks.listArchivedForProject(id);
  }

  restoreTask(id: ProjectId, task: string): void {
    this.envs.requireProject(id);
    if (!TASK_ID.test(task)) {
      throw new InvalidRequestError(`not a task id: ${task}`);
    }
    if (
      this.deps.tasks.get(task)?.projectId !== id ||
      !this.deps.tasks.restore(task, USER)
    ) {
      throw new NotFoundError(task, "archived task");
    }
  }

  /**
   * Deletes an archived task with its conversations, discarded variants' included: left in opencode, they would come
   * back as chats once the task no longer claims them. Keeps the task when one of them can't go now (it is running, or
   * its container is stopped). Worktrees and branches stay.
   */
  async deleteArchivedTask(id: ProjectId, task: string): Promise<void> {
    this.envs.requireProject(id);
    if (!TASK_ID.test(task)) {
      throw new InvalidRequestError(`not a task id: ${task}`);
    }
    const record = this.deps.tasks.get(task);
    if (record?.projectId !== id || record.archivedAt === undefined) {
      throw new NotFoundError(task, "archived task");
    }
    for (const session of this.deps.tasks.liveSessions(task)) {
      const outcome = await this.conversations?.cleanupConversation(
        id,
        session.envId,
        session.sessionId
      );
      if (outcome && outcome.outcome !== "removed") {
        throw new ConflictError(
          `kept the task: ${outcome.message ?? "a conversation could not be deleted"}`
        );
      }
    }
    if (!this.deps.tasks.deleteArchived(task, USER)) {
      throw new NotFoundError(task, "archived task");
    }
  }

  /**
   * Saves a draft: a task with the request's title, prompt (its brief), ticket and spec-first choice, and its
   * variants and options kept as its plan; no variant is created and nothing is set up.
   */
  createDraft(id: ProjectId, body: Record<string, unknown>): { task: string } {
    this.envs.requireProject(id);
    const req = parseTaskRequest(body, { draft: true });
    const now = (this.deps.now ?? Date.now)();
    const task = newTaskId(now);
    this.deps.tasks.createTask(
      {
        createdAt: now,
        id: task,
        plan: planOf(req),
        projectId: id,
        prompt: req.prompt,
        title: req.title ?? deriveTitle(req.prompt),
        variants: [],
        ...(req.jira ? { jira: req.jira } : {}),
        ...(req.spec ? { spec: req.spec } : {}),
      },
      USER
    );
    return { task };
  }

  /** A draft from a Jira ticket: titled from it, its description as the brief, linked to it, one default variant. */
  draftFromTicket(
    id: ProjectId,
    body: Record<string, unknown>
  ): { task: string } {
    const jira = parseJiraTaskSource(body.jira);
    return this.createDraft(id, {
      jira,
      prompt: jira.description.trim() || jira.title,
      title: `${jira.key}: ${jira.title}`.slice(0, TITLE_LIMIT),
      where: "worktree",
    });
  }

  /** Changes a draft's title, brief, spec-first choice or plan. */
  editDraft(id: ProjectId, task: string, body: Record<string, unknown>): void {
    this.requireDraft(id, task);
    const req = parseTaskRequest(body, { draft: true });
    this.deps.tasks.updateDraft(task, {
      plan: planOf(req),
      prompt: req.prompt,
      specFirst: req.spec !== undefined,
      title: req.title ?? deriveTitle(req.prompt),
    });
  }

  /**
   * Starts a draft as the request asks: its title, brief and spec-first choice are updated, then its variants are
   * added to the same task and set up in the background, as `startTask` does.
   */
  async startDraft(
    id: ProjectId,
    task: string,
    body: Record<string, unknown>
  ): Promise<TaskResult> {
    const draft = this.requireDraft(id, task);
    const prepared = await this.prepare(id, body);
    const { req } = prepared;
    const title = req.title ?? draft.title;
    this.deps.tasks.updateDraft(task, {
      prompt: req.prompt,
      specFirst: req.spec !== undefined,
      title,
    });
    let first: number;
    try {
      first = this.addRows(task, prepared, { draft: true });
    } catch (error) {
      if (error instanceof DraftStartedError) {
        throw new InvalidRequestError("the task has already started");
      }
      throw error;
    }
    void this.run(prepared, task, title, first).catch(() => undefined);
    return { task, variants: [] };
  }

  /**
   * Adds variants to a running task of kind `task` and sets them up in the background, each in a new worktree from
   * `base` with `turn` as its first turn: Make task's extra variants.
   */
  async addVariants(
    id: ProjectId,
    task: string,
    variants: TaskVariantSpec[],
    options: { base?: string; spec: boolean }
  ): Promise<void> {
    const record = this.deps.tasks.get(task);
    if (record?.projectId !== id || record.kind !== "task") {
      throw new NotFoundError(task, "task");
    }
    const prepared = await this.prepare(id, {
      prompt: record.prompt ?? record.title,
      spec: options.spec,
      title: record.title,
      variants,
      where: "worktree",
      ...(options.base ? { base: options.base } : {}),
    });
    const first = this.addRows(task, prepared);
    await this.run(prepared, task, record.title, first);
  }

  /** The project's draft `task`; throws when it isn't one. */
  private requireDraft(id: ProjectId, task: string): TaskRecord {
    this.envs.requireProject(id);
    const record = TASK_ID.test(task) ? this.deps.tasks.get(task) : undefined;
    if (record?.projectId !== id) {
      throw new NotFoundError(task, "task");
    }
    if (record.state !== "draft") {
      throw new InvalidRequestError("the task has already started");
    }
    return record;
  }

  /** The checks a task request must pass before anything is created; then the job that sets it up. */
  private async beginTask(
    id: ProjectId,
    body: Record<string, unknown>,
    spec?: TaskStartSpec
  ): Promise<{ task: string; done: Promise<TaskResult> }> {
    const prepared = await this.prepare(id, body, spec);
    const { req, remoteKit, node } = prepared;
    const now = (this.deps.now ?? Date.now)();
    const task = newTaskId(now);
    const title = req.title ?? deriveTitle(req.prompt);
    this.deps.tasks.createTask(
      {
        createdAt: now,
        id: task,
        projectId: id,
        prompt: req.prompt,
        title,
        variants: req.variants.map((v) => ({
          ...v,
          ...(remoteKit ? { node } : {}),
        })),
        ...(req.jira ? { jira: req.jira } : {}),
        ...(req.spec ? { spec: req.spec } : {}),
      },
      USER
    );
    return { done: this.run(prepared, task, title, 1), task };
  }

  /** Checks a request to start variants: its fields, the node it runs on, the worktrees mount and the base. */
  private async prepare(
    id: ProjectId,
    body: Record<string, unknown>,
    spec?: TaskStartSpec
  ): Promise<Prepared> {
    const parsed = parseTaskRequest(body);
    const req = spec ? { ...parsed, spec } : parsed;
    const client = this.envs.opencodeClient(id);
    const project = this.envs.requireProject(id);
    const node = req.node ?? LOCAL_NODE;
    const remoteKit =
      node === LOCAL_NODE ? undefined : this.remoteKitFor(project, req, node);
    const { store } = this.deps;
    if (
      req.where === "worktree" &&
      !remoteKit &&
      !store.runtime(id).worktreeRoot?.mounted
    ) {
      throw new UnavailableError(NO_WORKTREE_MOUNT);
    }
    if (req.where === "existing") {
      const known = this.deps.store
        .runtime(id)
        .worktrees?.find(
          (worktree) => worktree.path === req.directory && !worktree.node
        );
      if (!known) {
        throw new InvalidRequestError(
          "the selected worktree is no longer available"
        );
      }
      if (
        this.envs.isolationFor(project, req.environment).isolated &&
        (!known.hostPath || !known.branch)
      ) {
        throw new InvalidRequestError(
          "this worktree cannot run in its own container"
        );
      }
    }
    let { base } = req;
    if (remoteKit && !base) {
      base = await this.deps.git.currentBranch(
        project,
        this.envs.workspaceFolder(project)
      );
      if (!base) {
        throw new InvalidRequestError(
          "the main checkout is on a detached HEAD; choose a base branch for a task on another node"
        );
      }
    }
    return {
      client,
      node,
      project,
      req,
      ...(base ? { base } : {}),
      ...(remoteKit ? { remoteKit } : {}),
    };
  }

  /** Records the request's variants on an existing task; returns the first new variant's number. */
  private addRows(
    task: string,
    { req, remoteKit, node }: Prepared,
    opts: { draft?: boolean } = {}
  ): number {
    const added = this.deps.tasks.addVariants(
      task,
      req.variants.map((v) => ({ ...v, ...(remoteKit ? { node } : {}) })),
      USER,
      opts
    );
    return added[0] ?? 1;
  }

  /** Sets up the request's variants, numbered from `first`, and waits until each runs or failed. */
  private async run(
    prepared: Prepared,
    task: string,
    title: string,
    first: number
  ): Promise<TaskResult> {
    const { req, project, client, node, remoteKit, base } = prepared;
    const labels = variantLabels(req.variants);
    const of = req.variants.length;
    const variants = await this.setup.run(project, client, {
      label: `task ${title}`,
      node,
      slots: req.variants.map((v, i) => ({
        sessionTitle: variantTitle(title, labels[i], of),
        sink: this.variantSink(task, first + i),
        spec: v,
      })),
      title,
      turn: firstTurn(req),
      where: req.where,
      ...(req.directory ? { directory: req.directory } : {}),
      ...(base ? { base } : {}),
      ...(remoteKit ? { remoteKit } : {}),
      ...(req.branch ? { branch: req.branch } : {}),
      ...(req.environment ? { environment: req.environment } : {}),
    });
    return { task, variants };
  }

  /** Where variant `n` of `task` reports its setup: its row, its log, and its session. */
  private variantSink(task: string, n: number): SetupSink {
    const actor = variantActor(task, n);
    return {
      actor,
      attach: (session) =>
        this.deps.tasks.attachSession(task, n, session, actor),
      // A pick while it is still starting discards it; it must not go on to run its first turn unseen.
      cancelled: () =>
        this.deps.tasks.get(task)?.variants.find((v) => v.n === n)
          ?.discarded === true,
      creator: { by: "variant", n, task },
      log: (line) => this.deps.store.appendStartingLog(task, n, line),
      step: (patch) => this.deps.tasks.updateVariant(task, n, patch, actor),
      taskId: task,
    };
  }

  /** The kit a task placed on `node` runs with; throws when the request or the node rules that out. */
  private remoteKitFor(
    project: Project,
    req: TaskRequest,
    node: NodeId
  ): NodeKit {
    if (req.where !== "worktree" || req.environment === "shared") {
      throw new InvalidRequestError(
        "a task on another node needs a new worktree with its own container"
      );
    }
    if (!this.deps.nodes?.known(node)) {
      throw new InvalidRequestError(`unknown node ${node}`);
    }
    const unsupported = this.deps.store.isolation(project.id)?.unsupported;
    if (unsupported) {
      throw new InvalidRequestError(
        `${project.name} can't run on another node: ${unsupported}`
      );
    }
    const kit = this.deps.nodes.kit(node);
    if (!kit) {
      throw new UnavailableError(`node ${node} is unreachable`);
    }
    return kit;
  }

  /**
   * Keeps one variant of a task. The others are recorded as discarded, which hides their sessions, and those still
   * running are stopped. With `removeWorktrees`, their worktrees are removed with --force and their branches with
   * -D, unless another session still uses one.
   */
  async pickVariant(
    id: ProjectId,
    task: string,
    keep: string,
    removeWorktrees: boolean
  ): Promise<PickResult> {
    this.envs.requireProject(id);
    const record = this.deps.tasks.get(task);
    const kept = record?.variants.find((v) => v.sessionId === keep);
    if (!record || record.projectId !== id || !kept) {
      throw new NotFoundError(keep, "variant");
    }
    // A concurrent pick may have discarded this variant since the dashboard last saw it.
    if (kept.discarded) {
      throw new InvalidRequestError("that variant was already discarded");
    }
    const all = this.deps.store.sessionsOf(id);
    const others = all.filter(
      (s) => s.task?.id === task && s.task.n !== kept.n
    );
    const result: PickResult = { discarded: [], errors: [], removed: [] };
    const discard = async () => {
      this.deps.tasks.pick(task, kept.n, USER);
      for (const s of others) {
        result.discarded.push(s.id);
        // A discarded variant must not keep running (or be force-removed mid-run).
        if (s.status === "idle") {
          continue;
        }
        try {
          await this.envs
            .opencodeClient(s.envId ?? id)
            .interrupt(s.id, s.directory);
        } catch (error) {
          result.errors.push(
            `${s.title}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      for (const envId of new Set([id, ...others.map((s) => s.envId ?? id)])) {
        this.envs.reconcile(envId);
      }
    };
    if (!removeWorktrees) {
      await discard();
      return result;
    }
    return this.envs.withGit(id, async (p) => {
      await discard();
      const ws = this.envs.workspaceFolder(p);
      const gone = others.filter((s) => result.discarded.includes(s.id));
      const inUse = new Set(
        all.filter((s) => !gone.includes(s)).map((s) => s.directory)
      );
      const known = this.deps.store.runtime(id).worktrees ?? [];
      const dirs = [...new Set(gone.map((s) => s.directory))].filter(
        (d) => d !== ws && !inUse.has(d)
      );
      const fail = (err: unknown) => {
        if (err instanceof CommandError) {
          for (const line of err.tail) {
            this.envs.log(id, line);
          }
        }
        return err instanceof Error ? err.message : String(err);
      };
      for (const dir of dirs) {
        const remote = this.envs.remoteEnvAt(p, dir);
        if (remote) {
          try {
            this.envs.kit(remote);
            await this.envs.destroy(remote);
            result.removed.push(dir);
            this.envs.log(
              id,
              `task: removed ${dir} and branch ${remote.worktree.branch} on node ${remote.node}`
            );
          } catch (error) {
            result.errors.push(
              `${remote.worktree.branch}: kept — ${fail(error)}`
            );
          }
          continue;
        }
        const wt = known.find((w) => w.path === dir);
        if (!wt) {
          continue;
        }
        // Only delete a branch this task created: the worktree may have switched to another one since.
        const creator = wt.branch
          ? this.deps.checkouts.branch(id, wt.branch)?.createdBy
          : undefined;
        const ours = creator?.by === "variant" && creator.task === task;
        const rec = this.deps.store
          .environments(id)
          .find((e) => e.worktree.path === dir);
        if (rec) {
          const env = this.envs.taskEnv(p, rec);
          try {
            await this.envs.destroy(env);
          } catch (error) {
            result.errors.push(
              `${wt.branch ?? dir}: kept — its container could not be removed: ${fail(error)}`
            );
            continue;
          }
        }
        try {
          await this.deps.worktrees.remove(p, ws, dir, true);
        } catch (error) {
          result.errors.push(`${wt.branch ?? dir}: ${fail(error)}`);
          continue;
        }
        this.deps.checkouts.removeWorktree(id, dir, undefined, USER);
        result.removed.push(dir);
        if (wt.branch && !ours) {
          result.errors.push(`${wt.branch}: kept — not created by this task`);
          this.envs.log(
            id,
            `task: removed ${dir}; kept branch ${wt.branch}, not created by this task`
          );
          continue;
        }
        try {
          if (wt.branch) {
            await this.deps.git.deleteBranch(p, ws, wt.branch, true);
            this.deps.checkouts.deleteBranch(id, wt.branch, USER);
          }
          this.envs.log(
            id,
            `task: removed ${dir}${wt.branch ? ` and branch ${wt.branch}` : ""}`
          );
        } catch (error) {
          result.errors.push(
            `${wt.branch}: worktree removed, branch kept: ${fail(error)}`
          );
        }
      }
      if (dirs.length > 0) {
        await this.deps.worktrees
          .list(p, ws, this.deps.store.runtime(id).worktreeRoot)
          .then(
            (list) => this.envs.setWorktrees(id, list),
            () =>
              this.deps.store.updateRuntime(id, {
                worktrees: known.filter(
                  (w) => !result.removed.includes(w.path)
                ),
              })
          );
      }
      return result;
    });
  }
}
