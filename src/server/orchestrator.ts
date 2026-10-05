import fs from "node:fs/promises";
import path from "node:path";
import type {
  EnvId,
  EnvWorktree,
  FormAnswer,
  ForwardedPort,
  ModelsInfo,
  PendingItems,
  PermissionDecision,
  PickResult,
  Project,
  ProjectId,
  PublishInfo,
  PublishResult,
  ReviewData,
  SessionSummary,
  TaskMeta,
  TaskResult,
  TaskVariantResult,
  UpdateResult,
  Worktree,
  WorktreeRoot,
} from "../shared/types";
import { CommandError, type ContainerInfo, type Containers, type ExecTarget, type PortConfig } from "./containers";
import type { EditorLauncher } from "./editors";
import { deriveTitle, taskBranches, variantLabels, variantTitle } from "../shared/tasks";
import { splitTitleBody } from "./forge";
import { newTaskId } from "./ids";
import { discardMetadata, parseTaskMeta, parseTaskRequest, toModelsInfo } from "./tasks";
import type { GitOps } from "./git";
import { diffMode, PATCH_BUDGET_BYTES, resolveBase, toReviewFiles } from "./review";
import { cleanLogLine, LogBuffer } from "./log-buffer";
import { Monitor, type MonitorOptions } from "./monitor";
import { type HostPort, type Network, type Route, type RouteContainer, directRoute } from "./network";
import { type OpencodeClient, type OpencodeEndpoint, isGone, isInvalidAnswer } from "./opencode/client";
import type { OpencodeRuntime } from "./opencode/runtime";
import type { ForwardTarget, PortForwarder } from "./port-forwarder";
import { parseForwardPorts } from "./ports";
import type { Publisher } from "./publish";
import { type RelayRuntime, generateRelayToken } from "./relay/runtime";
import type { StateStore } from "./state";
import { InvalidRequestError, type Worktrees, mountArg, validateBranch, worktreeRoot } from "./worktrees";

const RELAY_RECOVERY_INTERVAL_MS = 30_000;
const MODELS_TTL_MS = 60_000;
const MODELS_RETRY_MS = 1500;
const NO_WORKTREE_MOUNT =
  "this container was created before opendevhub mounted a worktrees folder — rebuild the container to enable worktrees";

export class BusyError extends Error {
  constructor(id: string) {
    super(`another action is already running for ${id}`);
    this.name = "BusyError";
  }
}

/** The request is fine but the project can't serve it right now (container stopped, mount missing…). */
export class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

export class NotFoundError extends Error {
  constructor(id: string, what = "project") {
    super(`unknown ${what} ${id}`);
    this.name = "NotFoundError";
  }
}

/** The permission request or form was already answered or cancelled, e.g. in the opencode tab. */
export class AlreadyAnsweredError extends Error {
  constructor() {
    super("already answered");
    this.name = "AlreadyAnsweredError";
  }
}

const COMMIT_PROMPT = "Write a conventional commit message for the uncommitted changes. Reply with the message only.";

const PUBLISH_PROMPT =
  "Write a pull request title on the first line, then a blank line, then a short description of this branch's changes. Reply with that text only.";
const STRATEGIES: readonly string[] = ["branch", "agit"];
const REMOTE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

const DECISIONS: readonly string[] = ["once", "always", "reject"] satisfies PermissionDecision[];

export type ContainersPort = Pick<
  Containers,
  "up" | "inspect" | "listManaged" | "stop" | "readConfiguration" | "workspaceFolder"
>;
export type GitPort = Pick<
  GitOps,
  "currentBranch" | "recordedBase" | "aheadBehind" | "isClean" | "isPushed" | "commit" | "update" | "mergeInto" | "deleteBranch" | "localBranches"
>;
export type WorktreesPort = Pick<Worktrees, "list" | "add" | "remove">;
export type EditorsPort = Pick<EditorLauncher, "open">;
export type ForwarderPort = Pick<PortForwarder, "open" | "close" | "closeAll">;
export type RuntimePort = Pick<
  OpencodeRuntime,
  "ensureRunning" | "stopServer" | "isHealthy" | "endpoint" | "resolveBinary"
>;
export type RelayPort = Pick<RelayRuntime, "ensureRunning" | "stop">;
export type NetworkPort = Pick<Network, "route">;
export interface MonitorHandle {
  start(): void;
  stop(): void;
  reconcile?(): unknown;
}

export type PublisherPort = Pick<Publisher, "info" | "publish">;

export interface OrchestratorDeps {
  store: StateStore;
  containers: ContainersPort;
  runtime: RuntimePort;
  forwarder: ForwarderPort;
  relay: RelayPort;
  worktrees: WorktreesPort;
  publisher: PublisherPort;
  git: GitPort;
  editors: EditorsPort;
  /** Creates the host worktrees folder before `up` mounts it (defaults to a recursive mkdir). */
  mkdir?: (dir: string) => Promise<void>;
  /** Defaults to connecting to container IPs directly. */
  network?: NetworkPort;
  clientFor: (ep: OpencodeEndpoint) => OpencodeClient;
  roots: () => string[];
  scan: (roots: string[]) => Promise<Project[]>;
  monitorFactory?: (opts: MonitorOptions) => MonitorHandle;
  /** Clock for task ids and the models cache; tests pass their own. */
  now?: () => number;
  /** Waits between retries; tests pass their own. */
  delay?: (ms: number) => Promise<void>;
}

/**
 * One devcontainer with its opencode, relay, route, port forwards and monitor. A project's main
 * environment has the project's id and the project's container; a task environment serves one worktree.
 */
interface Env {
  id: EnvId;
  project: Project;
  /** What `devcontainer up` and `exec` address: the project itself for the main environment. */
  target: ExecTarget;
  /** Set on task environments. */
  worktree?: EnvWorktree;
}

export class Orchestrator {
  private readonly busy = new Set<EnvId>();
  private readonly monitors = new Map<EnvId, MonitorHandle>();
  private readonly logs = new Map<ProjectId, LogBuffer>();
  private readonly logListeners = new Set<(projectId: ProjectId, line: string) => void>();
  private readonly relayRecoveries = new Map<EnvId, number>();
  private readonly gitBusy = new Set<ProjectId>();
  /** Session directories already looked up as possible worktrees, so an unknown one triggers one refresh. */
  private readonly seenDirectories = new Map<ProjectId, Set<string>>();
  private readonly routes = new Map<EnvId, Route>();
  private readonly modelCache = new Map<ProjectId, { at: number; value: Promise<ModelsInfo> }>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async rescan(): Promise<void> {
    this.deps.store.setProjects(await this.deps.scan(this.deps.roots()));
  }

  /** Where the host reaches an environment's opencode server while its container runs; a main environment's id is its project's. */
  opencodeAddress(id: EnvId): HostPort | undefined {
    return this.routes.get(id)?.opencode;
  }

  logLines(id: ProjectId): string[] {
    return this.logs.get(id)?.lines() ?? [];
  }

  onLog(fn: (projectId: ProjectId, line: string) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  start(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => this.bringUp(p, false));
  }

  rebuild(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      this.stopMonitor(p.id);
      await this.closePorts(p.id);
      await this.bringUp(p, true);
    });
  }

  restartOpencode(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => this.relaunchOpencode(this.mainEnv(p)));
  }

  stop(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => this.stopContainer(this.mainEnv(p)));
  }

  async adopt(): Promise<void> {
    const { store, containers } = this.deps;
    let managed: ContainerInfo[];
    try {
      managed = await containers.listManaged();
    } catch {
      return;
    }
    for (const info of managed) {
      const project = info.projectId ? store.project(info.projectId) : undefined;
      if (!project) continue;
      const env = this.mainEnv(project);
      if (!info.running) {
        store.updateRuntime(env.id, { containerId: info.id, containerState: "stopped", opencode: "absent" });
        continue;
      }
      store.updateRuntime(env.id, {
        containerId: info.id,
        containerName: info.name,
        containerIp: info.ip,
        containerState: "running",
        worktreeRoot: this.detectWorktreeRoot(project, this.workspaceFolder(project), info),
      });
      await this.adoptRunning(env, info);
    }
  }

  async refreshContainers(): Promise<void> {
    const { store, containers } = this.deps;
    for (const env of this.allEnvs()) {
      const rt = store.runtime(env.id);
      if (this.busy.has(env.id) || rt.containerState !== "running" || !rt.containerId) continue;
      try {
        const info = await containers.inspect(rt.containerId);
        // A lifecycle action (start/stop/rebuild/...) may have started while inspect() was in
        // flight; if so it owns the environment's state now, so don't race it with a stale write.
        if (this.busy.has(env.id)) continue;
        if (info?.running) continue;
        await this.markStopped(env);
      } catch {
        // One environment's docker inspect failing shouldn't stop the others from refreshing.
      }
    }
  }

  /** Re-reads `git worktree list` in the container. */
  refreshWorktrees(id: ProjectId): Promise<Worktree[]> {
    return this.withGit(id, async (p) => {
      const ws = this.workspaceFolder(p);
      const list = await this.deps.worktrees.list(p, ws, this.deps.store.runtime(id).worktreeRoot);
      this.deps.store.updateRuntime(id, { worktrees: list });
      return list;
    });
  }

  createWorktree(
    id: ProjectId,
    req: { branch: string; base?: string; startSession?: boolean; prompt?: string },
  ): Promise<{ worktree: Worktree; sessionId?: string }> {
    const branch = validateBranch(req.branch);
    const base = req.base?.trim() || undefined;
    return this.withGit(id, async (p) => {
      const rt = this.deps.store.runtime(id);
      const root = rt.worktreeRoot;
      if (!root?.mounted) {
        throw new UnavailableError(NO_WORKTREE_MOUNT);
      }
      const ws = this.workspaceFolder(p);
      const worktree = await this.deps.worktrees.add(p, {
        workspaceFolder: ws,
        root,
        branch,
        base,
        onLine: (l) => this.log(id, l),
      });
      const list = await this.deps.worktrees.list(p, ws, root).catch(() => [...(rt.worktrees ?? []), worktree]);
      this.deps.store.updateRuntime(id, { worktrees: list });
      if (!req.startSession) return { worktree };
      const sessionId = await this.startSession(id, worktree.path, branch, req.prompt).catch((err: unknown) => {
        this.log(id, `worktree: could not start a session: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      return { worktree, sessionId };
    });
  }

  removeWorktree(id: ProjectId, worktreePath: string, force: boolean, deleteBranch = false): Promise<void> {
    return this.withGit(id, async (p) => {
      const known = this.deps.store.runtime(id).worktrees ?? [];
      const target = known.find((w) => w.path === worktreePath);
      if (!target) throw new InvalidRequestError(`unknown worktree ${worktreePath}`);
      const ws = this.workspaceFolder(p);
      await this.deps.worktrees.remove(p, ws, worktreePath, force);
      this.log(id, `worktree: removed ${worktreePath}`);
      try {
        if (deleteBranch && target.branch) {
          await this.gitAction(id, `delete branch ${target.branch}`, () => this.deps.git.deleteBranch(p, ws, target.branch!));
        }
      } finally {
        // The worktree is gone either way; don't keep listing it when only the branch delete failed.
        const list = await this.deps.worktrees
          .list(p, ws, this.deps.store.runtime(id).worktreeRoot)
          .catch(() => known.filter((w) => w.path !== worktreePath));
        this.deps.store.updateRuntime(id, { worktrees: list });
      }
    });
  }

  /** Starts an opencode session in the workspace or one of its worktrees, optionally with a first prompt, and returns its id. */
  async startSession(id: ProjectId, directory: string, title?: string, prompt?: string): Promise<string> {
    this.requireProject(id);
    this.checkDirectory(id, directory);
    const client = this.opencodeClient(id);
    const session = await client.createSession(directory, { title });
    if (prompt?.trim()) await client.prompt(session.id, prompt, undefined, directory);
    this.monitors.get(id)?.reconcile?.();
    return session.id;
  }

  /** Sends a prompt to one of the project's sessions, queued behind the current turn when it is running. */
  async promptSession(id: ProjectId, sessionId: string, text: string): Promise<void> {
    this.requireProject(id);
    if (!text.trim()) throw new InvalidRequestError("the prompt is empty");
    const session = this.deps.store.sessionsOf(id).find((s) => s.id === sessionId);
    if (!session) throw new NotFoundError(sessionId, "session");
    await this.opencodeClient(id).prompt(sessionId, text, session.status === "running" ? "queue" : undefined, session.directory);
    this.monitors.get(id)?.reconcile?.();
  }

  /** Models, the default model and the agents a new session can use; cached for a minute per project. */
  async models(id: ProjectId): Promise<ModelsInfo> {
    const project = this.requireProject(id);
    const client = this.opencodeClient(id);
    const now = (this.deps.now ?? Date.now)();
    const hit = this.modelCache.get(id);
    if (hit && now - hit.at < MODELS_TTL_MS) return hit.value;
    const ws = this.workspaceFolder(project);
    const fetchOnce = () =>
      Promise.all([client.models(ws), client.defaultModel(ws).catch(() => undefined), client.agents(ws)]).then(([models, def, agents]) =>
        toModelsInfo(models, def, agents),
      );
    const isEmpty = (v: ModelsInfo) => v.models.length === 0 && v.agents.length === 0;
    const delay = this.deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // A freshly started opencode answers these routes empty at first, so an empty answer gets one retry.
    const value = fetchOnce().then(async (first) => {
      if (!isEmpty(first)) return first;
      await delay(MODELS_RETRY_MS);
      return fetchOnce();
    });
    this.modelCache.set(id, { at: now, value });
    const forget = () => {
      if (this.modelCache.get(id)?.value === value) this.modelCache.delete(id);
    };
    value.then((v) => isEmpty(v) && forget(), forget);
    return value;
  }

  /**
   * Starts a task: for each variant, a worktree (unless it runs in the main checkout), a session tagged with
   * the task in its metadata, and the prompt. Variants run in order under one git lock; a failing variant is
   * recorded on its result and the others still run. Worktrees already created are kept.
   */
  async createTask(id: ProjectId, body: Record<string, unknown>): Promise<TaskResult> {
    const req = parseTaskRequest(body);
    const client = this.opencodeClient(id);
    return this.withGit(id, async (p) => {
      const rt = this.deps.store.runtime(id);
      const ws = this.workspaceFolder(p);
      const root = rt.worktreeRoot;
      const task = newTaskId((this.deps.now ?? Date.now)());
      const title = req.title ?? deriveTitle(req.prompt);
      const of = req.variants.length;
      const labels = variantLabels(req.variants);
      let branches: string[] = [];
      if (req.where === "worktree") {
        if (!root?.mounted) throw new UnavailableError(NO_WORKTREE_MOUNT);
        const taken = new Set([
          ...(await this.deps.git.localBranches(p, ws)),
          ...(rt.worktrees ?? []).flatMap((w) => (w.branch ? [w.branch] : [])),
        ]);
        branches = taskBranches({ branch: req.branch, title, variants: req.variants, taken }).map(validateBranch);
      }
      const results: TaskVariantResult[] = [];
      for (const [i, v] of req.variants.entries()) {
        const branch = branches[i];
        const result: TaskVariantResult = branch ? { branch } : { directory: ws };
        results.push(result);
        try {
          if (branch) {
            const wt = await this.deps.worktrees.add(p, { workspaceFolder: ws, root: root!, branch, base: req.base, onLine: (l) => this.log(id, l) });
            result.directory = wt.path;
          }
          const directory = result.directory!;
          const meta: TaskMeta = { task, variant: i + 1, of, title, ...(branch ? { branch } : {}) };
          const session = await client.createSession(directory, {
            title: variantTitle(title, labels[i], of),
            ...(v.model ? { model: v.model } : {}),
            ...(v.agent ? { agent: v.agent } : {}),
            metadata: { opendevhub: meta },
          });
          result.sessionId = session.id;
          await client.prompt(session.id, req.prompt, undefined, directory);
        } catch (err) {
          result.error = err instanceof Error ? err.message : String(err);
          this.log(id, `task ${title}: variant ${i + 1}${branch ? ` (${branch})` : ""} failed: ${result.error}`);
          if (err instanceof CommandError) for (const line of err.tail) this.log(id, line);
        }
      }
      if (branches.length > 0) {
        const created = results.flatMap((r) => (r.branch && r.directory ? [{ path: r.directory, branch: r.branch }] : []));
        const list = await this.deps.worktrees
          .list(p, ws, root)
          .catch(() => {
            const known = rt.worktrees ?? [];
            return [...known, ...created.filter((c) => !known.some((w) => w.path === c.path))];
          });
        this.deps.store.updateRuntime(id, { worktrees: list });
      }
      const started = results.filter((r) => r.sessionId).length;
      this.log(id, `task ${title}: started ${started} of ${of} variant${of === 1 ? "" : "s"}`);
      this.monitors.get(id)?.reconcile?.();
      return { task, variants: results };
    });
  }

  /**
   * Keeps one variant of a task. The others are marked discarded, which hides them; opencode replaces metadata as a
   * whole, so each session's metadata is read and written back with `discarded` added. With `removeWorktrees`,
   * their worktrees are removed with --force and their branches with -D, unless another session still uses one.
   */
  async pickVariant(id: ProjectId, task: string, keep: string, removeWorktrees: boolean): Promise<PickResult> {
    this.requireProject(id);
    const all = this.deps.store.sessionsOf(id);
    const variants = all.filter((s) => s.task?.task === task);
    if (!variants.some((s) => s.id === keep)) throw new NotFoundError(keep, "variant");
    const client = this.opencodeClient(id);
    // A concurrent pick may have discarded this variant since the dashboard last saw it.
    if (parseTaskMeta((await client.session(keep)).metadata)?.discarded) throw new InvalidRequestError("that variant was already discarded");
    const others = variants.filter((s) => s.id !== keep);
    const result: PickResult = { discarded: [], removed: [], errors: [] };
    const discard = async () => {
      for (const s of others) {
        try {
          const raw = await client.session(s.id);
          await client.updateSession(s.id, { metadata: discardMetadata(raw.metadata) }, s.directory);
          result.discarded.push(s.id);
          // A discarded variant must not keep running (or be force-removed mid-run).
          if (s.status !== "idle") await client.interrupt(s.id, s.directory);
        } catch (err) {
          result.errors.push(`${s.title}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.monitors.get(id)?.reconcile?.();
    };
    if (!removeWorktrees) {
      await discard();
      return result;
    }
    return this.withGit(id, async (p) => {
      await discard();
      const ws = this.workspaceFolder(p);
      const gone = others.filter((s) => result.discarded.includes(s.id));
      const inUse = new Set(all.filter((s) => !gone.includes(s)).map((s) => s.directory));
      const known = this.deps.store.runtime(id).worktrees ?? [];
      const dirs = [...new Set(gone.map((s) => s.directory))].filter((d) => d !== ws && !inUse.has(d));
      for (const dir of dirs) {
        const wt = known.find((w) => w.path === dir);
        if (!wt) continue;
        // Only delete a branch this task created: the worktree may have switched to another one since.
        const ours = wt.branch !== undefined && gone.some((s) => s.directory === dir && s.task?.branch === wt.branch);
        const fail = (err: unknown) => {
          if (err instanceof CommandError) for (const line of err.tail) this.log(id, line);
          return err instanceof Error ? err.message : String(err);
        };
        try {
          await this.deps.worktrees.remove(p, ws, dir, true);
        } catch (err) {
          result.errors.push(`${wt.branch ?? dir}: ${fail(err)}`);
          continue;
        }
        result.removed.push(dir);
        if (wt.branch && !ours) {
          result.errors.push(`${wt.branch}: kept — not created by this task`);
          this.log(id, `task: removed ${dir}; kept branch ${wt.branch}, not created by this task`);
          continue;
        }
        try {
          if (wt.branch) await this.deps.git.deleteBranch(p, ws, wt.branch, true);
          this.log(id, `task: removed ${dir}${wt.branch ? ` and branch ${wt.branch}` : ""}`);
        } catch (err) {
          result.errors.push(`${wt.branch}: worktree removed, branch kept: ${fail(err)}`);
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

  /** What changed in a checkout compared with its base, for the Review tab. */
  async review(id: ProjectId, directory: string, opts: { base?: string; file?: string } = {}): Promise<ReviewData> {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    const request = opts.base?.trim() ? validateBranch(opts.base) : undefined;
    const client = this.opencodeClient(id);
    const { git } = this.deps;
    const ws = this.workspaceFolder(project);
    const branch = await git.currentBranch(project, directory);
    const [config, opencodeBase, info] = await Promise.all([
      branch ? git.recordedBase(project, directory, branch) : undefined,
      client.vcsBase(directory).catch(() => undefined),
      client.vcsInfo(directory).catch((): { default?: string } => ({})),
    ]);
    const base = resolveBase({ request, config, opencode: opencodeBase, defaultBranch: info.default });
    const mode = diffMode(directory === ws, branch, base);
    const [raw, status, counts, pushed, wsBranch, wsClean] = await Promise.all([
      client.vcsDiff(directory, mode, mode === "branch" ? base?.name : undefined),
      client.vcsStatus(directory),
      base ? git.aheadBehind(project, directory, base.name).catch(() => ({ ahead: 0, behind: 0 })) : { ahead: 0, behind: 0 },
      branch ? git.isPushed(project, directory, branch) : false,
      git.currentBranch(project, ws),
      git.isClean(project, ws),
    ]);
    const wanted = opts.file === undefined ? raw : raw.filter((f) => f.file === opts.file);
    const { files, truncated } = toReviewFiles(wanted, opts.file === undefined ? PATCH_BUDGET_BYTES : Number.POSITIVE_INFINITY);
    return {
      directory,
      ...(branch ? { branch } : {}),
      ...(base ? { base } : {}),
      mode,
      ...counts,
      dirty: status.length > 0,
      pushed,
      workspace: { ...(wsBranch ? { branch: wsBranch } : {}), clean: wsClean },
      files,
      ...(truncated ? { truncated } : {}),
    };
  }

  /** A commit message suggested by the target's latest session; empty when there is none or it fails. */
  async commitMessage(id: ProjectId, directory: string): Promise<string> {
    this.requireProject(id);
    this.checkDirectory(id, directory);
    const session = this.latestSession(id, directory);
    if (!session) return "";
    try {
      return (await this.opencodeClient(id).generate(session.id, COMMIT_PROMPT, directory)).trim();
    } catch {
      return "";
    }
  }

  async commit(id: ProjectId, directory: string, message: string): Promise<void> {
    const msg = message.trim();
    if (!msg) throw new InvalidRequestError("the commit message is empty");
    this.checkDirectory(id, directory);
    await this.withGit(id, async (p) => {
      if (await this.deps.git.isClean(p, directory)) throw new InvalidRequestError("there is nothing to commit");
      await this.gitAction(id, `commit in ${directory}`, () => this.deps.git.commit(p, directory, msg));
    });
  }

  /** Rebases the target onto its base, or merges the base in when the branch was pushed. Conflicts are aborted. */
  async updateFromBase(id: ProjectId, directory: string, base: string): Promise<UpdateResult> {
    const ref = validateBranch(base);
    this.checkDirectory(id, directory);
    return this.withGit(id, async (p) => {
      const { git } = this.deps;
      const branch = await git.currentBranch(p, directory);
      if (!branch) throw new InvalidRequestError(`${directory} is not on a branch`);
      if (!(await git.isClean(p, directory))) throw new InvalidRequestError("commit or discard the uncommitted changes first");
      const strategy = (await git.isPushed(p, directory, branch)) ? "merge" : "rebase";
      const result = await this.gitAction(id, `${strategy} ${branch} with ${ref}`, () => git.update(p, directory, ref, strategy));
      if (result.conflicts) this.log(id, `review: conflicts in ${result.conflicts.join(", ")}; aborted, nothing changed`);
      return result;
    });
  }

  /** Merges a worktree's branch into the main checkout, which must be clean and on the base. Does not push. */
  async mergeIntoBase(id: ProjectId, directory: string, base: string, ffOnly: boolean): Promise<{ branch: string }> {
    const ref = validateBranch(base);
    this.checkDirectory(id, directory);
    return this.withGit(id, async (p) => {
      const { git } = this.deps;
      const ws = this.workspaceFolder(p);
      if (directory === ws) throw new InvalidRequestError("merge a worktree into its base; the main checkout is the base");
      const branch = await git.currentBranch(p, directory);
      if (!branch) throw new InvalidRequestError(`${directory} is not on a branch`);
      if (!(await git.isClean(p, directory))) throw new InvalidRequestError(`${branch} has uncommitted changes; commit them first`);
      const wsBranch = await git.currentBranch(p, ws);
      if (wsBranch !== ref) throw new InvalidRequestError(`the main checkout is on ${wsBranch ?? "a detached HEAD"}, not ${ref}`);
      if (!(await git.isClean(p, ws))) throw new InvalidRequestError("the main checkout has uncommitted changes");
      await this.gitAction(id, `merge ${branch} into ${ref}${ffOnly ? " (fast-forward only)" : ""}`, () =>
        git.mergeInto(p, ws, branch, ffOnly),
      );
      return { branch };
    });
  }

  /** Where and how publishing would push this checkout. */
  async publishInfo(id: ProjectId, directory: string, remote?: string): Promise<PublishInfo> {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    if (remote !== undefined && !REMOTE_NAME.test(remote)) throw new InvalidRequestError(`invalid remote "${remote}"`);
    const branch = await this.deps.git.currentBranch(project, directory);
    return this.deps.publisher.info(project, this.checkout(project, directory), branch, remote);
  }

  /** A PR title and description suggested by the target's latest session; empty when there is none or it fails. */
  async publishSuggestion(id: ProjectId, directory: string): Promise<{ title: string; description: string }> {
    this.requireProject(id);
    this.checkDirectory(id, directory);
    const session = this.latestSession(id, directory);
    if (!session) return { title: "", description: "" };
    try {
      return splitTitleBody(await this.opencodeClient(id).generate(session.id, PUBLISH_PROMPT, directory));
    } catch {
      return { title: "", description: "" };
    }
  }

  /** Pushes the checkout's branch and opens (or links) its pull request. */
  async publish(
    id: ProjectId,
    directory: string,
    req: { remote: string; base: string; strategy: string; title: string; description: string },
  ): Promise<PublishResult> {
    if (!REMOTE_NAME.test(req.remote)) throw new InvalidRequestError(`invalid remote "${req.remote}"`);
    const base = validateBranch(req.base);
    if (!STRATEGIES.includes(req.strategy)) throw new InvalidRequestError(`invalid strategy "${req.strategy}"`);
    const title = req.title.trim();
    if (!title || title.length > 200) throw new InvalidRequestError("the title must be 1 to 200 characters");
    this.checkDirectory(id, directory);
    return this.withGit(id, async (p) => {
      const branch = await this.deps.git.currentBranch(p, directory);
      if (!branch) throw new InvalidRequestError(`${directory} is not on a branch`);
      if (branch === base) throw new InvalidRequestError(`publish a branch, not the base itself (${base})`);
      return this.gitAction(id, `publish ${branch} to ${req.remote} (${req.strategy})`, () =>
        this.deps.publisher.publish(p, this.checkout(p, directory), branch, {
          remote: req.remote,
          base,
          strategy: req.strategy as "branch" | "agit",
          title,
          description: req.description,
        }),
      );
    });
  }

  /** Answers a permission request the dashboard listed for this project. */
  async replyPermission(id: ProjectId, requestId: string, reply: { decision: string; message?: string }): Promise<void> {
    if (!DECISIONS.includes(reply.decision)) throw new InvalidRequestError(`invalid decision "${reply.decision}"`);
    const decision = reply.decision as PermissionDecision;
    await this.respond(
      id,
      "permission request",
      requestId,
      (p) => p.permissions.find((i) => i.id === requestId),
      (client, item, dir) =>
        client.replyPermission(item.sessionId, requestId, { decision, ...(reply.message ? { message: reply.message } : {}) }, dir),
    );
  }

  /** Submits an answer to a form the dashboard listed for this project. */
  async replyForm(id: ProjectId, formId: string, answer: unknown): Promise<void> {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new InvalidRequestError("answer must be an object");
    await this.respond(
      id,
      "form",
      formId,
      (p) => p.forms.find((i) => i.id === formId),
      (client, item, dir) => client.replyForm(item.sessionId, formId, answer as FormAnswer, dir),
    );
  }

  /** Dismisses a form. */
  async cancelForm(id: ProjectId, formId: string): Promise<void> {
    await this.respond(
      id,
      "form",
      formId,
      (p) => p.forms.find((i) => i.id === formId),
      (client, item, dir) => client.cancelForm(item.sessionId, formId, dir),
    );
  }

  /** Opens the workspace or a worktree in an editor on this machine. */
  openInEditor(id: ProjectId, editorId: string, directory: string): Promise<void> {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    const rt = this.deps.store.runtime(id);
    const hostPath =
      directory === this.workspaceFolder(project)
        ? project.path
        : rt.worktrees?.find((w) => w.path === directory)?.hostPath;
    return this.deps.editors.open(editorId, {
      containerPath: directory,
      hostPath,
      containerName: rt.containerState === "running" ? rt.containerName : undefined,
    });
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
    await this.deps.forwarder.closeAll();
    await Promise.all([...this.routes.keys()].map((id) => this.closeRoute(id)));
  }

  private requireProject(id: ProjectId): Project {
    const project = this.deps.store.project(id);
    if (!project) throw new NotFoundError(id);
    return project;
  }

  /** Only the workspace and worktrees git reports may be opened — never an arbitrary path from a request. */
  private checkDirectory(id: ProjectId, directory: string): void {
    const project = this.requireProject(id);
    if (directory === this.workspaceFolder(project)) return;
    if (this.deps.store.runtime(id).worktrees?.some((w) => w.path === directory)) return;
    throw new InvalidRequestError(`${directory} is neither the workspace nor a known worktree`);
  }

  /** Git work in the container: needs it running, and runs one at a time per project. */
  private withGit<T>(id: ProjectId, fn: (project: Project) => Promise<T>): Promise<T> {
    const project = this.requireProject(id);
    if (this.busy.has(id) || this.gitBusy.has(id)) throw new BusyError(id);
    if (this.deps.store.runtime(id).containerState !== "running") {
      throw new UnavailableError("the container is not running — start the project first");
    }
    this.gitBusy.add(id);
    return fn(project).finally(() => this.gitBusy.delete(id));
  }

  /** Creates the host worktrees folder so `up` can mount it next to the workspace. */
  private async worktreeMounts(project: Project): Promise<string[]> {
    const planned = (await this.deps.containers.workspaceFolder(project).catch(() => undefined)) ?? this.workspaceFolder(project);
    const root = worktreeRoot(project.path, planned, false);
    try {
      await (this.deps.mkdir ?? ((dir) => fs.mkdir(dir, { recursive: true }).then(() => {})))(root.host);
      return [mountArg(root)];
    } catch (err) {
      this.log(project.id, `worktrees: could not create ${root.host}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private detectWorktreeRoot(project: Project, workspaceFolder: string, info: ContainerInfo): WorktreeRoot {
    const root = worktreeRoot(project.path, workspaceFolder, false);
    const source = info.binds?.[root.container];
    if (source === undefined) {
      this.log(project.id, "worktrees: this container has no worktrees mount — rebuild it to enable worktrees");
      return root;
    }
    return { ...root, host: source, mounted: true };
  }

  private async refreshWorktreesQuietly(project: Project): Promise<void> {
    if (this.gitBusy.has(project.id)) return;
    this.gitBusy.add(project.id);
    try {
      const rt = this.deps.store.runtime(project.id);
      const list = await this.deps.worktrees.list(project, this.workspaceFolder(project), rt.worktreeRoot);
      this.deps.store.updateRuntime(project.id, { worktrees: list });
    } catch (err) {
      this.log(project.id, `worktrees: could not list: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.gitBusy.delete(project.id);
    }
  }

  /** A session in a directory we don't know is probably in a worktree created elsewhere (opencode, a shell). */
  private noticeDirectories(id: ProjectId, directories: string[]): void {
    const project = this.deps.store.project(id);
    if (!project || this.busy.has(id)) return;
    const seen = this.seenDirectories.get(id) ?? new Set<string>();
    this.seenDirectories.set(id, seen);
    const ws = this.workspaceFolder(project);
    const known = new Set((this.deps.store.runtime(id).worktrees ?? []).map((w) => w.path));
    const fresh = directories.filter((d) => d !== ws && !known.has(d) && !seen.has(d));
    if (fresh.length === 0) return;
    for (const d of fresh) seen.add(d);
    void this.refreshWorktreesQuietly(project);
  }

  private exclusive(id: ProjectId, fn: (project: Project) => Promise<void>): Promise<void> {
    const project = this.deps.store.project(id);
    if (!project) throw new NotFoundError(id);
    return this.exclusiveEnv(this.mainEnv(project), () => fn(project));
  }

  /** Route, relay, ports and opencode health of a running container found at startup. */
  private async adoptRunning(env: Env, info: ContainerInfo): Promise<void> {
    const { store, runtime } = this.deps;
    let route: Route | undefined;
    if (info.ip) {
      try {
        route = await this.openRoute(env, { id: info.id, ip: info.ip, network: info.network });
      } catch (err) {
        this.fail(env, err);
        return;
      }
      await this.forwardPorts(env, await this.startRelay(env, info.ip, route));
    }
    if (!env.worktree) await this.refreshWorktreesQuietly(env.project);
    const rt = store.runtime(env.id);
    if (route && rt.password && (await runtime.isHealthy(runtime.endpoint(route.opencode, rt.password)))) {
      store.updateRuntime(env.id, { opencode: "healthy", error: undefined });
      this.startMonitor(env);
    } else {
      store.updateRuntime(env.id, { opencode: "unhealthy", error: "opencode is not running — use Restart opencode" });
    }
  }

  /** The container went away outside opendevhub: drop what pointed at it. */
  private async markStopped(env: Env): Promise<void> {
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    await this.closeRoute(env.id);
    this.deps.store.updateRuntime(env.id, { containerState: "stopped", opencode: "absent", containerIp: undefined });
    this.deps.store.setSessions(env.id, []);
  }

  private async stopContainer(env: Env): Promise<void> {
    const { store, runtime, containers } = this.deps;
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    const rt = store.runtime(env.id);
    store.updateRuntime(env.id, { containerState: "stopping", error: undefined });
    try {
      if (rt.containerState === "running") {
        await runtime.stopServer(env.target).catch(() => {});
        await this.deps.relay.stop(env.target).catch(() => {});
      }
      if (rt.containerId) await containers.stop(rt.containerId);
      await this.closeRoute(env.id);
      store.updateRuntime(env.id, { containerState: "stopped", opencode: "absent", containerIp: undefined });
      store.setSessions(env.id, []);
    } catch (err) {
      this.fail(env, err);
    }
  }

  private async relaunchOpencode(env: Env): Promise<void> {
    const rt = this.deps.store.runtime(env.id);
    const route = this.routes.get(env.id);
    if (rt.containerState !== "running" || !rt.containerIp || !route) {
      this.fail(env, new Error("container is not running — start the project first"));
      return;
    }
    this.stopMonitor(env.id);
    this.deps.store.updateRuntime(env.id, { opencode: "starting", error: undefined });
    try {
      const relayWasActive = rt.relay === "active";
      const target = await this.startRelay(env, rt.containerIp, route);
      if (target.relay && !relayWasActive) await this.forwardPorts(env, target);
      await this.launchOpencode(env, undefined);
    } catch (err) {
      this.fail(env, err);
    }
  }

  private async bringUp(project: Project, rebuild: boolean): Promise<void> {
    const { store, containers } = this.deps;
    const env = this.mainEnv(project);
    store.updateRuntime(env.id, { containerState: "starting", opencode: "absent", error: undefined });
    try {
      const mounts = await this.worktreeMounts(project);
      const up = await containers.up(project, { rebuild, onLine: (l) => this.log(project.id, l), mounts });
      // Record the container id as soon as `up` succeeds, before the running/IP checks below can
      // throw — otherwise a container that came up but failed those checks has no containerId on
      // record, and Stop has nothing to stop.
      store.updateRuntime(env.id, { containerId: up.containerId });
      const info = await containers.inspect(up.containerId);
      if (!info?.running) throw new CommandError("container is not running after devcontainer up");
      if (!info.ip) {
        throw new CommandError("container has no bridge network IP (host networking is not supported)");
      }
      store.updateRuntime(env.id, {
        containerId: up.containerId,
        containerName: info.name,
        containerIp: info.ip,
        remoteUser: up.remoteUser,
        workspaceFolder: up.remoteWorkspaceFolder,
        worktreeRoot: this.detectWorktreeRoot(project, up.remoteWorkspaceFolder, info),
        containerState: "running",
        opencode: "starting",
      });
      const route = await this.openRoute(env, { id: up.containerId, ip: info.ip, network: info.network });
      await this.forwardPorts(env, await this.startRelay(env, info.ip, route));
      await this.refreshWorktreesQuietly(project);
      await this.launchOpencode(env, rebuild ? undefined : store.runtime(env.id).password);
    } catch (err) {
      this.fail(env, err);
    }
  }

  private async launchOpencode(env: Env, password: string | undefined): Promise<void> {
    const { store, runtime } = this.deps;
    const route = this.routes.get(env.id);
    if (!route) throw new Error("container is not running — start the project first");
    const result = await runtime.ensureRunning(env.target, {
      address: route.opencode,
      password,
      workspaceFolder: this.envDirectory(env),
      onLine: (l) => this.envLog(env, l),
    });
    store.updateRuntime(env.id, {
      password: result.password,
      opencodeVersion: result.version,
      opencode: "healthy",
      error: undefined,
    });
    this.startMonitor(env);
  }

  private workspaceFolder(project: Project): string {
    return this.deps.store.runtime(project.id).workspaceFolder ?? `/workspaces/${path.basename(project.path)}`;
  }

  private mainEnv(project: Project): Env {
    return { id: project.id, project, target: project };
  }

  private envOf(id: EnvId): Env | undefined {
    const project = this.deps.store.project(id);
    return project ? this.mainEnv(project) : undefined;
  }

  private allEnvs(): Env[] {
    return this.deps.store.projects().map((p) => this.mainEnv(p));
  }

  /** The checkout an environment's opencode serves and its monitor watches. */
  private envDirectory(env: Env): string {
    return env.worktree?.path ?? this.workspaceFolder(env.project);
  }

  /** Worktrees the main environment's opencode serves. */
  private sharedWorktrees(projectId: ProjectId): string[] {
    return (this.deps.store.runtime(projectId).worktrees ?? []).map((w) => w.path);
  }

  /** The project's log; a task environment's lines start with its branch. */
  private envLog(env: Env, raw: string): void {
    const line = cleanLogLine(raw);
    if (!line) return;
    this.log(env.project.id, env.worktree ? `[${env.worktree.branch}] ${line}` : line);
  }

  /** One lifecycle action per environment at a time; throws BusyError synchronously otherwise. */
  private exclusiveEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(env.id)) throw new BusyError(env.id);
    this.busy.add(env.id);
    return fn().finally(() => this.busy.delete(env.id));
  }

  private async forwardPorts(env: Env, target: ForwardTarget): Promise<void> {
    const { store, containers, forwarder } = this.deps;
    let config: PortConfig;
    try {
      config = await containers.readConfiguration(env.target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.envLog(env, `ports: could not read devcontainer configuration: ${message}`);
      store.updateRuntime(env.id, { ports: [] });
      return;
    }
    const { ports, skipped } = parseForwardPorts(config.forwardPorts, config.portsAttributes);
    for (const s of skipped) this.envLog(env, `ports: skipped ${s.entry} (${s.reason})`);
    const opened = await forwarder.open(env.id, target, ports, (line) => this.envLog(env, line), {
      onRelayUnreachable: () => void this.recoverRelay(env.id),
    });
    for (const f of opened) {
      if (f.status === "forwarded") this.envLog(env, `ports: ${f.containerPort} → localhost:${f.hostPort}`);
      else if (f.status === "failed") this.envLog(env, `ports: ${f.containerPort} not forwarded (${f.reason})`);
    }
    const skippedPorts: ForwardedPort[] = skipped.map((s) => ({ status: "skipped", entry: s.entry, reason: s.reason }));
    store.updateRuntime(env.id, { ports: [...opened, ...skippedPorts] });
  }

  private async openRoute(env: Env, container: RouteContainer): Promise<Route> {
    await this.closeRoute(env.id);
    const network = this.deps.network ?? { route: async (c: RouteContainer) => directRoute(c.ip) };
    const route = await network.route(container, (line) => this.envLog(env, line));
    this.routes.set(env.id, route);
    return route;
  }

  private async closeRoute(id: EnvId): Promise<void> {
    const route = this.routes.get(id);
    this.routes.delete(id);
    await route?.close();
  }

  private async startRelay(env: Env, ip: string, route: Route): Promise<ForwardTarget> {
    const { store, runtime, relay } = this.deps;
    let token = store.runtime(env.id).relayToken;
    if (!token) {
      token = generateRelayToken();
      store.updateRuntime(env.id, { relayToken: token });
    }
    const binary = await runtime.resolveBinary(env.target).catch(() => undefined);
    const result = await relay.ensureRunning(env.target, { address: route.relay, token, binary });
    const direct: ForwardTarget = route.dial ? { host: ip, dial: route.dial } : { host: ip };
    if (result.status === "active") {
      this.envLog(env, `relay: active (${result.via})`);
      store.updateRuntime(env.id, { relay: "active" });
      return { ...direct, relay: { ...route.relay, token } };
    }
    this.envLog(env, `relay: unavailable (${result.reason})`);
    store.updateRuntime(env.id, { relay: "unavailable" });
    return direct;
  }

  /** A forwarded connection found the relay gone: mark it and relaunch in the background (at most every 30 s). */
  private async recoverRelay(id: EnvId): Promise<void> {
    const now = Date.now();
    if (now - (this.relayRecoveries.get(id) ?? -Infinity) < RELAY_RECOVERY_INTERVAL_MS) return;
    this.relayRecoveries.set(id, now);
    const { store } = this.deps;
    const env = this.envOf(id);
    const rt = store.runtime(id);
    const route = this.routes.get(id);
    if (!env || this.busy.has(id) || rt.containerState !== "running" || !rt.containerIp || !route) return;
    store.updateRuntime(id, { relay: "unavailable" });
    this.envLog(env, "relay: unreachable, relaunching");
    await this.startRelay(env, rt.containerIp, route).catch(() => {});
  }

  private async closePorts(id: EnvId): Promise<void> {
    await this.deps.forwarder.close(id);
    this.deps.store.updateRuntime(id, { ports: undefined, relay: undefined });
  }

  private latestSession(id: ProjectId, directory: string): SessionSummary | undefined {
    return this.deps.store
      .sessionsOf(id)
      .filter((s) => s.directory === directory)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /** The checkout as the container sees it, plus where it lives on this machine when it does. */
  private checkout(project: Project, directory: string): { container: string; host?: string } {
    if (directory === this.workspaceFolder(project)) return { container: directory, host: project.path };
    const hostPath = this.deps.store.runtime(project.id).worktrees?.find((w) => w.path === directory)?.hostPath;
    return { container: directory, ...(hostPath ? { host: hostPath } : {}) };
  }

  /** Runs a review git action and writes its outcome (and git's last lines on failure) to the project log. */
  private async gitAction<T>(id: ProjectId, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.log(id, `review: ${what}`);
      return result;
    } catch (err) {
      this.log(id, `review: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof CommandError) for (const line of err.tail) this.log(id, line);
      throw err;
    }
  }

  private opencodeClient(id: EnvId): OpencodeClient {
    const rt = this.deps.store.runtime(id);
    const route = this.routes.get(id);
    if (rt.containerState !== "running" || rt.opencode !== "healthy" || !route || !rt.password) {
      throw new UnavailableError("opencode is not running — start the project first");
    }
    return this.deps.clientFor(this.deps.runtime.endpoint(route.opencode, rt.password));
  }

  /**
   * Forwards a reply for a pending item, but only for ids in the latest snapshot: the dashboard never relays
   * ids it didn't list itself. Refreshes the snapshot afterwards, whatever happened.
   */
  private async respond<T extends { sessionId: string }>(
    id: ProjectId,
    what: string,
    itemId: string,
    find: (pending: PendingItems) => T | undefined,
    send: (client: OpencodeClient, item: T, directory: string) => Promise<void>,
  ): Promise<void> {
    this.requireProject(id);
    let found: { item: T; directory: string } | undefined;
    for (const s of this.deps.store.sessionsOf(id)) {
      const item = s.pending && find(s.pending);
      if (item) {
        found = { item, directory: s.directory };
        break;
      }
    }
    if (!found) throw new NotFoundError(itemId, what);
    const client = this.opencodeClient(id);
    try {
      await send(client, found.item, found.directory);
    } catch (err) {
      if (isGone(err)) throw new AlreadyAnsweredError();
      if (isInvalidAnswer(err)) throw new InvalidRequestError(err.detail ?? "opencode rejected the answer");
      throw err;
    } finally {
      this.monitors.get(id)?.reconcile?.();
    }
  }

  private startMonitor(env: Env): void {
    this.stopMonitor(env.id);
    const { store, runtime, clientFor } = this.deps;
    const rt = store.runtime(env.id);
    const factory = this.deps.monitorFactory ?? ((opts: MonitorOptions) => new Monitor(opts));
    const monitor = factory({
      client: clientFor(runtime.endpoint(this.routes.get(env.id)!.opencode, rt.password!)),
      projectId: env.project.id,
      envId: env.id,
      directory: this.envDirectory(env),
      ...(env.worktree ? {} : { extraDirectories: () => this.sharedWorktrees(env.project.id) }),
      onSessions: (sessions) => {
        store.setSessions(env.id, sessions);
        this.noticeDirectories(env.project.id, [...new Set(sessions.map((s) => s.directory))]);
      },
      onHealth: (healthy) => {
        if (store.runtime(env.id).opencode === "starting") return;
        store.updateRuntime(env.id, { opencode: healthy ? "healthy" : "unhealthy" });
      },
    });
    this.monitors.set(env.id, monitor);
    monitor.start();
  }

  private stopMonitor(id: EnvId): void {
    this.modelCache.delete(id);
    this.monitors.get(id)?.stop();
    this.monitors.delete(id);
  }

  private log(id: ProjectId, raw: string): void {
    const line = cleanLogLine(raw);
    if (!line) return;
    let buffer = this.logs.get(id);
    if (!buffer) {
      buffer = new LogBuffer();
      this.logs.set(id, buffer);
    }
    buffer.push(line);
    for (const fn of this.logListeners) fn(id, line);
  }

  private fail(env: Env, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CommandError) for (const line of err.tail) this.envLog(env, line);
    this.envLog(env, `error: ${message}`);
    const containerUp = this.deps.store.runtime(env.id).containerState === "running";
    this.deps.store.updateRuntime(env.id, {
      containerState: containerUp ? "running" : "error",
      opencode: containerUp ? "unhealthy" : "absent",
      error: message,
    });
  }
}
