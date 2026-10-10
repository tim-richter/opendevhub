import { jiraTicketUrl } from "../../shared/jira";
import {
  deriveTitle,
  taskBranches,
  variantLabels,
  variantTitle,
} from "../../shared/tasks";
import type {
  EnvWorktree,
  NodeId,
  PickResult,
  Project,
  ProjectId,
  TaskRequest,
  TaskResult,
  TaskStartSpec,
  TaskVariantResult,
  TaskVariantSpec,
} from "../../shared/types";
import { USER, variantActor } from "../db/events";
import type { VariantPatch } from "../db/tasks";
import { CommandError } from "../environments/containers";
import type { Environments } from "../environments/environments";
import { cleanLogLine } from "../environments/log-buffer";
import type { HubDeps, NodeKit } from "../environments/ports";
import { NotFoundError, UnavailableError } from "../errors";
import { InvalidRequestError, validateBranch } from "../git/worktrees";
import { LOCAL_NODE } from "../nodes/host";
import type { NodeRepoLayout } from "../nodes/repo";
import type { OpencodeClient } from "../opencode/client";
import { TASK_ID, newTaskId } from "../projects/ids";
import { APPLY_COMMAND, PROPOSE_COMMAND } from "./openspec";
import { parseTaskRequest } from "./request";

/** What a variant's session starts with: the prompt, `opsx-propose <prompt>`, or `opsx-apply <change>`. */
const firstTurn = (req: TaskRequest): { command?: string; text: string } => {
  if (req.spec?.phase === "implement") {
    return { command: APPLY_COMMAND, text: req.spec.change };
  }
  return req.spec
    ? { command: PROPOSE_COMMAND, text: req.prompt }
    : { text: req.prompt };
};

const NO_WORKTREE_MOUNT =
  "this container was created before opendevhub mounted a worktrees folder — rebuild the container to enable worktrees";

/** Tasks: one prompt run as one or more variants, each in its own worktree (and environment) or the main checkout. */
export class Tasks {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  constructor(deps: HubDeps, envs: Environments) {
    this.deps = deps;
    this.envs = envs;
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

  /** The checks a task request must pass before anything is created; then the job that sets it up. */
  private async beginTask(
    id: ProjectId,
    body: Record<string, unknown>,
    spec?: TaskStartSpec
  ): Promise<{ task: string; done: Promise<TaskResult> }> {
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
    const done = this.runTask(project, client, req, {
      base,
      node,
      remoteKit,
      task,
      title,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const v of this.deps.tasks.get(task)?.variants ?? []) {
        if (v.step !== "failed" && !v.sessionId) {
          this.deps.tasks.updateVariant(
            task,
            v.n,
            { error: message, step: "failed" },
            variantActor(task, v.n)
          );
        }
      }
      this.envs.log(id, `task ${title}: could not start: ${message}`);
      throw error;
    });
    return { done, task };
  }

  private async runTask(
    project: Project,
    client: OpencodeClient,
    req: TaskRequest,
    job: {
      task: string;
      title: string;
      node: NodeId;
      remoteKit?: NodeKit;
      base?: string;
    }
  ): Promise<TaskResult> {
    const { task, title, node, remoteKit } = job;
    const { id } = project;
    const { store } = this.deps;
    const localIsolation = () =>
      req.where === "worktree"
        ? this.envs.isolationFor(project, req.environment)
        : { isolated: false, notice: undefined };
    const { isolated, notice } = remoteKit
      ? { isolated: true, notice: undefined }
      : localIsolation();
    const of = req.variants.length;
    const labels = variantLabels(req.variants);
    const own: (EnvWorktree | undefined)[] = [];
    const step = (i: number, patch: VariantPatch) =>
      this.deps.tasks.updateVariant(
        task,
        i + 1,
        patch,
        variantActor(task, i + 1)
      );
    const results = await this.envs.withGitWhenFree(id, async (p) => {
      const rt = store.runtime(id);
      const ws = this.envs.workspaceFolder(p);
      const root = rt.worktreeRoot;
      let branches: string[] = [];
      let remote:
        | { layout: NodeRepoLayout; base: string; notice?: string }
        | undefined;
      if (req.where === "worktree") {
        if (!remoteKit && !root?.mounted) {
          throw new UnavailableError(NO_WORKTREE_MOUNT);
        }
        if (remoteKit) {
          // oxlint-disable-next-line unicorn/no-array-for-each
          req.variants.forEach((_, i) => step(i, { step: "pushing" }));
          remote = await this.prepareRemote(p, ws, remoteKit, node, job.base);
        }
        const taken = new Set([
          ...(await this.deps.git.localBranches(p, ws)),
          ...(rt.worktrees ?? []).flatMap((w) => (w.branch ? [w.branch] : [])),
          ...(remote && remoteKit
            ? await remoteKit.repo.branches(remote.layout)
            : []),
        ]);
        branches = taskBranches({
          branch: req.branch,
          taken,
          title,
          variants: req.variants,
        }).map(validateBranch);
      }
      const variantResults: TaskVariantResult[] = [];
      for (const [i, v] of req.variants.entries()) {
        const branch = branches[i];
        const result: TaskVariantResult = branch
          ? { branch }
          : { directory: ws };
        if (notice) {
          result.notice = notice;
        }
        if (remote?.notice) {
          result.notice = remote.notice;
        }
        variantResults.push(result);
        const onLine = (l: string) => this.variantLog(id, task, i, l);
        try {
          if (branch && remote && remoteKit) {
            step(i, { branch, step: "worktree" });
            const wt = await remoteKit.repo.addWorktree(
              remote.layout,
              branch,
              remote.base
            );
            this.deps.checkouts.recordCreated(
              id,
              {
                base: remote.base,
                branch,
                hostPath: wt.hostPath,
                node,
                path: wt.path,
              },
              { by: "variant", n: i + 1, task },
              variantActor(task, i + 1)
            );
            result.directory = wt.path;
            step(i, { directory: wt.path });
            own[i] = wt;
            continue;
          }
          if (branch) {
            if (!root) {
              throw new UnavailableError(NO_WORKTREE_MOUNT);
            }
            step(i, { branch, step: "worktree" });
            const wt = await this.deps.worktrees.add(p, {
              base: req.base,
              branch,
              onLine,
              root,
              workspaceFolder: ws,
            });
            this.deps.checkouts.recordCreated(
              id,
              {
                branch,
                path: wt.path,
                ...(wt.hostPath ? { hostPath: wt.hostPath } : {}),
                ...(wt.base ? { base: wt.base } : {}),
                ...(req.jira ? { originUrl: jiraTicketUrl(req.jira) } : {}),
              },
              { by: "variant", n: i + 1, task },
              variantActor(task, i + 1)
            );
            result.directory = wt.path;
            step(i, { directory: wt.path });
            if (isolated && wt.hostPath) {
              own[i] = { branch, hostPath: wt.hostPath, path: wt.path };
              continue;
            }
          }
          step(i, { step: "session" });
          await this.startVariant(
            client,
            { envId: id, n: i + 1, task },
            result,
            result.directory ?? ws,
            variantTitle(title, labels[i], of),
            v,
            firstTurn(req)
          );
        } catch (error) {
          this.variantFailed(id, title, i, branch, result, error);
          step(i, { error: result.error, step: "failed" });
        }
      }
      if (branches.length > 0 && !remote) {
        const created = variantResults.flatMap((r) =>
          r.branch && r.directory
            ? [{ branch: r.branch, path: r.directory }]
            : []
        );
        await this.deps.worktrees.list(p, ws, root).then(
          (list) => this.envs.setWorktrees(id, list),
          () => {
            const known = rt.worktrees ?? [];
            store.updateRuntime(id, {
              worktrees: [
                ...known,
                ...created.filter((c) => !known.some((w) => w.path === c.path)),
              ],
            });
          }
        );
      }
      return variantResults;
    });
    await Promise.all(
      own.map(async (worktree, i) => {
        if (!worktree) {
          return;
        }
        const result = results[i];
        try {
          const env = await this.envs
            .ensureTaskEnv(project, worktree, node, {
              task,
              variant: i + 1,
            })
            .catch((error: unknown) => {
              throw new Error(
                `its container did not start: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          result.envId = env.id;
          step(i, { envId: env.id, step: "session" });
          await this.startVariant(
            this.envs.opencodeClient(env.id),
            { envId: env.id, n: i + 1, task },
            result,
            worktree.path,
            variantTitle(title, labels[i], of),
            req.variants[i],
            firstTurn(req)
          );
        } catch (error) {
          this.variantFailed(id, title, i, worktree.branch, result, error);
          step(i, { error: result.error, step: "failed" });
        }
      })
    );
    const started = results.filter((r) => r.sessionId).length;
    this.envs.log(
      id,
      `task ${title}: started ${started} of ${of} variant${of === 1 ? "" : "s"}`
    );
    this.envs.reconcile(id);
    for (const r of results) {
      if (r.envId) {
        this.envs.reconcile(r.envId);
      }
    }
    return { task, variants: results };
  }

  /** A line of a starting variant's setup: in the project's log and in the variant's own. */
  private variantLog(
    id: ProjectId,
    task: string,
    i: number,
    raw: string
  ): void {
    this.envs.log(id, raw);
    const line = cleanLogLine(raw);
    if (line) {
      this.deps.store.appendStartingLog(task, i + 1, line);
    }
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

  /** The node's repository for the project, with the base pushed to it. */
  private async prepareRemote(
    p: Project,
    ws: string,
    kit: NodeKit,
    node: NodeId,
    requested: string | undefined
  ): Promise<{ layout: NodeRepoLayout; base: string; notice?: string }> {
    const base = requested ?? (await this.deps.git.currentBranch(p, ws));
    if (!base) {
      throw new InvalidRequestError(
        "the main checkout is on a detached HEAD; choose a base branch for a task on another node"
      );
    }
    const layout = kit.repo.layout(p, ws);
    await kit.repo.ensure(layout);
    await kit.repo.pushBase(p, layout, base);
    this.envs.log(p.id, `task: pushed ${base} to node ${node}`);
    const clean = await this.deps.git.isClean(p, ws);
    return {
      base,
      layout,
      ...(clean
        ? {}
        : {
            notice: `uncommitted changes in the main checkout are not on node ${node}`,
          }),
    };
  }

  /**
   * Creates a variant's session (recorded on the result and the variant's row at once) and sends its first turn:
   * the prompt, or for a spec-first variant an OpenSpec command, checked first so that a missing command leaves
   * no session. The directory is claimed meanwhile, so that reconcile doesn't adopt the session as a manual task.
   */
  private async startVariant(
    client: OpencodeClient,
    variant: { task: string; n: number; envId: string },
    result: TaskVariantResult,
    directory: string,
    title: string,
    v: TaskVariantSpec,
    turn: { command?: string; text: string }
  ): Promise<void> {
    const { command } = turn;
    if (command) {
      const commands = await client.commands(directory);
      if (!commands.some((c) => c.name === command)) {
        throw new UnavailableError(
          `opencode has no ${command} command here; run \`openspec init --tools opencode\` in the repository`
        );
      }
    }
    const { task, n, envId } = variant;
    const release = this.deps.tasks.claim(envId, directory);
    try {
      const session = await client.createSession(directory, {
        title,
        ...(v.model ? { model: v.model } : {}),
        ...(v.agent ? { agent: v.agent } : {}),
      });
      result.sessionId = session.id;
      this.deps.tasks.attachSession(
        task,
        n,
        { directory, envId, sessionId: session.id },
        variantActor(task, n)
      );
    } finally {
      release();
    }
    const { sessionId } = result;
    await (command
      ? client.command(sessionId, command, turn.text, directory)
      : client.prompt(sessionId, turn.text, undefined, directory));
  }

  private variantFailed(
    id: ProjectId,
    title: string,
    i: number,
    branch: string | undefined,
    result: TaskVariantResult,
    err: unknown
  ): void {
    result.error = err instanceof Error ? err.message : String(err);
    this.envs.log(
      id,
      `task ${title}: variant ${i + 1}${branch ? ` (${branch})` : ""} failed: ${result.error}`
    );
    if (err instanceof CommandError) {
      for (const line of err.tail) {
        this.envs.log(id, line);
      }
    }
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
    const others = all.filter((s) => s.task?.id === task && s.id !== keep);
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
