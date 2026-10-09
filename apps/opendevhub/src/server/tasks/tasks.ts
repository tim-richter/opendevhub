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
  SessionSummary,
  StartingVariant,
  TaskMeta,
  TaskRequest,
  TaskResult,
  TaskVariantResult,
  TaskVariantSpec,
} from "../../shared/types";
import { CommandError } from "../environments/containers";
import type { Environments } from "../environments/environments";
import { cleanLogLine } from "../environments/log-buffer";
import type { HubDeps, NodeKit } from "../environments/ports";
import { NotFoundError, UnavailableError } from "../errors";
import { InvalidRequestError, validateBranch } from "../git/worktrees";
import { LOCAL_NODE } from "../nodes/host";
import type { NodeRepoLayout } from "../nodes/repo";
import type { OpencodeClient } from "../opencode/client";
import { newTaskId } from "../projects/ids";
import { discardMetadata, parseTaskMeta, parseTaskRequest } from "./request";

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
   * the main checkout), a session tagged with the task in its metadata, and the prompt. Worktrees are created in
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
   * the snapshot's `starting` shows each one's step and log until its session appears.
   */
  async startTask(
    id: ProjectId,
    body: Record<string, unknown>
  ): Promise<TaskResult> {
    const { task, done } = await this.beginTask(id, body);
    void done.catch(() => undefined);
    return { task, variants: [] };
  }

  /** Forgets a starting task's variants that failed (or already have their session). */
  dismissStarting(id: ProjectId, task: string): void {
    this.envs.requireProject(id);
    if (!this.deps.store.dismissStarting(id, task)) {
      throw new NotFoundError(task, "starting task");
    }
  }

  /** The checks a task request must pass before anything is created; then the job that sets it up. */
  private async beginTask(
    id: ProjectId,
    body: Record<string, unknown>
  ): Promise<{ task: string; done: Promise<TaskResult> }> {
    const req = parseTaskRequest(body);
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
    store.putStarting(id, {
      task,
      title,
      of: req.variants.length,
      ...(req.jira ? { jira: req.jira } : {}),
      createdAt: now,
      variants: req.variants.map((_, i) => ({
        variant: i + 1,
        ...(remoteKit ? { node } : {}),
        step: "queued" as const,
        log: [],
      })),
    });
    const done = this.runTask(project, client, req, {
      base,
      node,
      remoteKit,
      task,
      title,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const v of store.startingTask(id, task)?.variants ?? []) {
        if (v.step !== "session" && v.step !== "failed") {
          store.updateStarting(id, task, v.variant, {
            error: message,
            step: "failed",
          });
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
    const step = (
      i: number,
      patch: Partial<Omit<StartingVariant, "variant" | "log">>
    ) => store.updateStarting(id, task, i + 1, patch);
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
            result.directory = wt.path;
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
              origin: req.jira ? jiraTicketUrl(req.jira) : undefined,
              root,
              workspaceFolder: ws,
            });
            result.directory = wt.path;
            if (isolated && wt.hostPath) {
              own[i] = { branch, hostPath: wt.hostPath, path: wt.path };
              continue;
            }
          }
          step(i, { step: "session" });
          const meta: TaskMeta = {
            of,
            task,
            title,
            variant: i + 1,
            ...(req.jira ? { jira: req.jira } : {}),
            ...(branch ? { branch } : {}),
          };
          await this.startVariant(
            client,
            result,
            result.directory ?? ws,
            meta,
            variantTitle(title, labels[i], of),
            v,
            req.prompt
          );
          step(i, { sessionId: result.sessionId });
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
        const list = await this.deps.worktrees.list(p, ws, root).catch(() => {
          const known = rt.worktrees ?? [];
          return [
            ...known,
            ...created.filter((c) => !known.some((w) => w.path === c.path)),
          ];
        });
        store.updateRuntime(id, { worktrees: list });
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
          step(i, { step: "session" });
          const meta: TaskMeta = {
            task,
            variant: i + 1,
            of,
            title,
            ...(req.jira ? { jira: req.jira } : {}),
            branch: worktree.branch,
          };
          await this.startVariant(
            this.envs.opencodeClient(env.id),
            result,
            worktree.path,
            meta,
            variantTitle(title, labels[i], of),
            req.variants[i],
            req.prompt
          );
          step(i, { sessionId: result.sessionId });
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
      this.deps.store.appendStartingLog(id, task, i + 1, line);
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

  /** Creates a variant's session (recorded on the result at once) and sends the prompt. */
  private async startVariant(
    client: OpencodeClient,
    result: TaskVariantResult,
    directory: string,
    meta: TaskMeta,
    title: string,
    v: TaskVariantSpec,
    prompt: string
  ): Promise<void> {
    const session = await client.createSession(directory, {
      title,
      ...(v.model ? { model: v.model } : {}),
      ...(v.agent ? { agent: v.agent } : {}),
      metadata: { opendevhub: meta },
    });
    result.sessionId = session.id;
    await client.prompt(session.id, prompt, undefined, directory);
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
   * Keeps one variant of a task. The others are marked discarded, which hides them; opencode replaces metadata as a
   * whole, so each session's metadata is read and written back with `discarded` added. With `removeWorktrees`,
   * their worktrees are removed with --force and their branches with -D, unless another session still uses one.
   */
  async pickVariant(
    id: ProjectId,
    task: string,
    keep: string,
    removeWorktrees: boolean
  ): Promise<PickResult> {
    this.envs.requireProject(id);
    const all = this.deps.store.sessionsOf(id);
    const variants = all.filter((s) => s.task?.task === task);
    const kept = variants.find((s) => s.id === keep);
    if (!kept) {
      throw new NotFoundError(keep, "variant");
    }
    const clientOf = (s: SessionSummary) =>
      this.envs.opencodeClient(s.envId ?? id);
    // A concurrent pick may have discarded this variant since the dashboard last saw it.
    const result4 = await clientOf(kept).session(keep);
    if (parseTaskMeta(result4.metadata)?.discarded) {
      throw new InvalidRequestError("that variant was already discarded");
    }
    const others = variants.filter((s) => s.id !== keep);
    const result: PickResult = { discarded: [], errors: [], removed: [] };
    const discard = async () => {
      for (const s of others) {
        try {
          const client = clientOf(s);
          const raw = await client.session(s.id);
          await client.updateSession(
            s.id,
            { metadata: discardMetadata(raw.metadata) },
            s.directory
          );
          result.discarded.push(s.id);
          // A discarded variant must not keep running (or be force-removed mid-run).
          if (s.status !== "idle") {
            await client.interrupt(s.id, s.directory);
          }
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
        const ours =
          wt.branch !== undefined &&
          gone.some((s) => s.directory === dir && s.task?.branch === wt.branch);
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
        const list = await this.deps.worktrees
          .list(p, ws, this.deps.store.runtime(id).worktreeRoot)
          .catch(() => known.filter((w) => !result.removed.includes(w.path)));
        this.deps.store.updateRuntime(id, { worktrees: list });
      }
      return result;
    });
  }
}
