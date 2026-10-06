import fs from "node:fs/promises";
import path from "node:path";
import type {
  BranchCleanupItem,
  CleanupOutcome,
  EnvId,
  EnvWorktree,
  FormAnswer,
  ForwardedPort,
  Isolation,
  ModelsInfo,
  NodeId,
  PendingItems,
  PermissionDecision,
  PickResult,
  Project,
  ProjectId,
  PublishInfo,
  PublishResult,
  ReviewData,
  ReviewMode,
  SessionCleanupItem,
  SessionSummary,
  TaskMeta,
  TaskResult,
  TaskVariantResult,
  TaskVariantSpec,
  UpdateResult,
  Worktree,
  WorktreeRoot,
} from "../shared/types";
import { branchChanged, scanBranches, staleSessions } from "./cleanup";
import { CommandError, type ContainerInfo, type Containers, type ExecTarget, type PortConfig, envLabels } from "./containers";
import { stateDir } from "./config";
import type { CheckTarget } from "./checks";
import { buildOverrideConfig, envIdFor, type EnvSettings, isolationBlocker, resolveEnvSettings } from "./env-config";
import { EnvFiles } from "./env-files";
import type { Images } from "./images";
import type { EditorLauncher } from "./editors";
import { deriveTitle, taskBranches, variantLabels, variantTitle } from "../shared/tasks";
import { splitTitleBody } from "./forge";
import { newTaskId } from "./ids";
import { discardMetadata, parseTaskMeta, parseTaskRequest, toModelsInfo } from "./tasks";
import type { GitOps } from "./git";
import { LOCAL_NODE } from "./host";
import type { NodeRepoPort } from "./node-repo";
import { diffMode, NO_LIMITS, resolveBase, toReviewFiles } from "./review";
import { cleanLogLine, LogBuffer } from "./log-buffer";
import { Monitor, type MonitorOptions } from "./monitor";
import { type HostPort, type Network, type Route, type RouteContainer, directRoute } from "./network";
import { type OpencodeClient, type OpencodeEndpoint, type RawSession, isGone, isInvalidAnswer } from "./opencode/client";
import type { OpencodeRuntime } from "./opencode/runtime";
import type { ForwardTarget, PortForwarder } from "./port-forwarder";
import { parseForwardPorts } from "./ports";
import type { Publisher } from "./publish";
import { type RelayRuntime, generateRelayToken } from "./relay/runtime";
import type { Credentials } from "./credentials";
import { AGENT_SOCKET, AgentTunnel, type AgentTunnelOptions } from "./relay/agent";
import type { RelayTarget } from "./relay/client";
import type { EnvRecord, StateStore } from "./state";
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
  "up" | "inspect" | "listManaged" | "stop" | "readConfiguration" | "workspaceFolder" | "readConfig" | "remove" | "removeImage"
>;
export type ImagesPort = Pick<Images, "ensureBase">;
export type EnvFilesPort = Pick<EnvFiles, "path" | "write" | "remove">;
export type GitPort = Pick<
  GitOps,
  | "currentBranch" | "recordedBase" | "aheadBehind" | "isClean" | "isPushed" | "commit" | "update" | "mergeInto" | "deleteBranch"
  | "localBranches" | "remotes" | "fetchPrune" | "branchRefs" | "remoteHead" | "isAncestor"
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
export type CredentialsPort = Pick<Credentials, "prepare">;
export interface AgentTunnelHandle {
  start(): void;
  stop(): void;
}
export type AgentTunnelFactory = (target: RelayTarget, opts: AgentTunnelOptions) => AgentTunnelHandle;

/** Everything that acts on one node's Docker and files; the local node's come from the deps below. */
export interface NodeKit {
  containers: ContainersPort;
  runtime: RuntimePort;
  relay: RelayPort;
  images: ImagesPort;
  envFiles: EnvFilesPort;
  credentials?: CredentialsPort;
  network: NetworkPort;
  git: GitPort;
  repo: NodeRepoPort;
}

/** The other nodes: a kit while a node is online. */
export interface NodeKitsPort {
  known(node: NodeId): boolean;
  kit(node: NodeId): NodeKit | undefined;
}

/** The local node's kit: the deps as they are, where images and a repo may be missing. */
type Kit = Omit<NodeKit, "images" | "repo"> & { images?: ImagesPort; repo?: NodeRepoPort };

const DIRECT: NetworkPort = { route: async (c: RouteContainer) => directRoute(c.ip) };

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
  /** Base images for task environments. */
  images?: ImagesPort;
  /** Where task environments' generated configs live; defaults to the state folder. */
  envFiles?: EnvFilesPort;
  /** The project's entry in config.json `projects`. */
  projectSettings?: (project: Project) => unknown;
  /** Git identity, known_hosts and git's ssh command in containers; skipped when absent. */
  credentials?: CredentialsPort;
  /** Books what each poll's sessions spent; skipped when absent (no usage ledger). */
  recordUsage?: (projectId: ProjectId, sessions: RawSession[]) => void;
  /** Defaults to a real AgentTunnel; tests pass their own. */
  agentTunnel?: AgentTunnelFactory;
  /** Other nodes' kits; absent when nodes aren't wired (and then every environment is local). */
  nodes?: NodeKitsPort;
}

/**
 * One devcontainer with its opencode, relay, route, port forwards and monitor. A project's main
 * environment has the project's id and the project's container; a task environment serves one worktree.
 */
interface Env {
  id: EnvId;
  project: Project;
  /** Where its container runs. */
  node: NodeId;
  /** What `devcontainer up` and `exec` address: the project itself for the main environment. */
  target: ExecTarget;
  /** Set on task environments. */
  worktree?: EnvWorktree;
}

type TaskEnv = Env & { worktree: EnvWorktree };

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
  /** The ssh-agent tunnel of each environment whose agent is forwarded. */
  private readonly tunnels = new Map<EnvId, AgentTunnelHandle>();
  /** Isolation settings per project, read when its main container forwards ports. */
  private readonly settings = new Map<ProjectId, EnvSettings>();
  /** Each environment's sshAgent setting, from the configuration it was started with. */
  private readonly sshAgents = new Map<EnvId, boolean>();
  private defaultEnvFiles?: EnvFilesPort;
  /**
   * Task containers come up one at a time per node: concurrent `devcontainer up` calls race on the CLI's shared
   * temp files (its UID Dockerfile) and one of them fails.
   */
  private readonly taskUps = new Map<NodeId, Promise<unknown>>();
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
    return this.exclusive(id, async (p) => {
      const { store } = this.deps;
      for (const rec of store.environments(p.id)) {
        const env = this.taskEnv(p, rec);
        if (!this.kitOf(env.node)) continue;
        const rt = store.runtime(env.id);
        if (this.busy.has(env.id) || !rt.containerId || rt.containerState === "stopped") continue;
        await this.exclusiveEnv(env, () => this.stopContainer(env));
      }
      await this.stopContainer(this.mainEnv(p));
    });
  }

  /** Gives a worktree its own container and starts it in the background. */
  async createEnv(projectId: ProjectId, worktreePath: string): Promise<{ envId: EnvId }> {
    const project = this.requireProject(projectId);
    const { store } = this.deps;
    if (store.runtime(projectId).containerState !== "running") {
      throw new UnavailableError("the container is not running — start the project first");
    }
    const unsupported = store.isolation(projectId)?.unsupported;
    if (unsupported) throw new InvalidRequestError(unsupported);
    const wt = store.runtime(projectId).worktrees?.find((w) => w.path === worktreePath);
    if (!wt) throw new InvalidRequestError(`unknown worktree ${worktreePath}`);
    if (!wt.hostPath) throw new InvalidRequestError(`${worktreePath} is not in the mounted worktrees folder, so it can't get its own container`);
    const env = this.recordTaskEnv(project, { path: wt.path, hostPath: wt.hostPath, branch: wt.branch ?? path.posix.basename(wt.path) });
    void this.exclusiveEnv(env, () => this.bringUpTask(env)).catch(() => {});
    return { envId: env.id };
  }

  startEnv(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    this.kit(env);
    return this.exclusiveEnv(env, () => this.bringUpTask(env));
  }

  stopEnv(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    this.kit(env);
    return this.exclusiveEnv(env, () => this.stopContainer(env));
  }

  /** Deletes a worktree's container; the worktree and its files stay, its sessions go. */
  removeEnv(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    this.kit(env);
    return this.exclusiveEnv(env, () => this.destroyEnv(env));
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
      if (info.envId) {
        await this.adoptTask(info);
        continue;
      }
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
    const { store } = this.deps;
    for (const env of this.allEnvs()) {
      const kit = this.kitOf(env.node);
      if (!kit) continue;
      const rt = store.runtime(env.id);
      if (this.busy.has(env.id) || rt.containerState !== "running" || !rt.containerId) continue;
      try {
        const info = await kit.containers.inspect(rt.containerId);
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
      await this.dropWorktree(p, worktreePath, force);
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

  /** Lists the project's merged and upstream-gone branches, after `git fetch --prune`. */
  cleanupScan(id: ProjectId): Promise<{ warning?: string; items: BranchCleanupItem[] }> {
    return this.withGit(id, async (p) => {
      const ws = this.workspaceFolder(p);
      const worktrees = await this.deps.worktrees.list(p, ws, this.deps.store.runtime(id).worktreeRoot);
      this.deps.store.updateRuntime(id, { worktrees });
      const envs = this.deps.store.environments(id);
      return scanBranches(this.deps.git, {
        project: p,
        workspace: ws,
        worktrees,
        envOf: (dir) => envs.find((e) => e.worktree.path === dir)?.id,
      });
    });
  }

  /** Deletes a scanned branch with its worktree and that worktree's container, if it still qualifies. */
  cleanupBranch(id: ProjectId, item: BranchCleanupItem): Promise<CleanupOutcome> {
    return this.withGit(id, async (p) => {
      const ws = this.workspaceFolder(p);
      const root = this.deps.store.runtime(id).worktreeRoot;
      const changed = await branchChanged(this.deps.git, p, ws, item, await this.deps.worktrees.list(p, ws, root));
      if (changed) return { outcome: "skipped", message: changed };
      try {
        if (item.worktree) await this.dropWorktree(p, item.worktree, item.dirty === true);
        // -d is git's own check that it's merged; a branch whose upstream is gone may be squash-merged, which -d refuses.
        await this.deps.git.deleteBranch(p, ws, item.branch, item.why === "upstream-gone");
      } finally {
        const list = await this.deps.worktrees.list(p, ws, root).catch(() => undefined);
        if (list) this.deps.store.updateRuntime(id, { worktrees: list });
      }
      this.log(id, `cleanup: deleted branch ${item.branch} (${item.reason})${item.worktree ? " and its worktree" : ""}`);
      return { outcome: "removed" };
    });
  }

  /**
   * Lists the sessions cleanup may delete, from the main opencode and each running task environment's. The worktree
   * list is read fresh; when it can't be, no session counts as of a removed worktree.
   */
  async cleanupSessionScan(id: ProjectId): Promise<{ warning?: string; items: SessionCleanupItem[] }> {
    const p = this.requireProject(id);
    const ws = this.workspaceFolder(p);
    const worktrees = await this.worktreePaths(p, ws);
    const envs = [id, ...this.deps.store.environments(id).filter((e) => this.deps.store.runtime(e.id).containerState === "running").map((e) => e.id)];
    const warnings: string[] = [];
    const items: SessionCleanupItem[] = [];
    for (const envId of envs) {
      try {
        items.push(...(await this.staleSessionsIn(p, envId, ws, worktrees)));
      } catch (err) {
        warnings.push(`could not list ${envId === id ? "" : `${envId}'s `}sessions: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}), items };
  }

  /** Deletes a scanned session, if a fresh scan of its environment still lists it. */
  async cleanupSession(id: ProjectId, item: SessionCleanupItem): Promise<CleanupOutcome> {
    const p = this.requireProject(id);
    const envId = item.envId ?? id;
    if (item.envId && this.deps.store.environment(item.envId)?.projectId !== id) return { outcome: "skipped", message: "changed since scan" };
    const ws = this.workspaceFolder(p);
    const worktrees = await this.worktreePaths(p, ws);
    const current = (await this.staleSessionsIn(p, envId, ws, worktrees)).find((i) => i.id === item.id);
    if (!current) return { outcome: "skipped", message: "changed since scan" };
    await this.opencodeClient(envId).deleteSession(current.sessionId, current.directory);
    this.log(id, `cleanup: removed session ${current.title} (${current.reason})`);
    this.monitors.get(envId)?.reconcile?.();
    return { outcome: "removed" };
  }

  /** Current worktree paths, or undefined when git can't list them. */
  private worktreePaths(p: Project, ws: string): Promise<string[] | undefined> {
    return this.deps.worktrees
      .list(p, ws, this.deps.store.runtime(p.id).worktreeRoot)
      .then((list) => list.map((w) => w.path))
      .catch(() => undefined);
  }

  private async staleSessionsIn(p: Project, envId: EnvId, workspace: string, worktrees: string[] | undefined): Promise<SessionCleanupItem[]> {
    const client = this.opencodeClient(envId);
    const [sessions, active] = await Promise.all([client.sessions(), client.active()]);
    const waiting = this.deps.store.sessionsOf(p.id).filter((s) => s.status !== "idle").map((s) => s.id);
    return staleSessions({
      projectId: p.id,
      ...(envId !== p.id ? { envId } : {}),
      sessions,
      busy: new Set([...active, ...waiting]),
      workspace,
      ...(worktrees ? { worktrees } : {}),
      now: (this.deps.now ?? Date.now)(),
    });
  }

  /** Writes a line to a project's log, for work done outside the orchestrator (cleanup's Docker items). */
  appendLog(id: ProjectId, line: string): void {
    this.log(id, line);
  }

  async startSession(id: ProjectId, directory: string, title?: string, prompt?: string): Promise<string> {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    const env = this.envForDirectory(project, directory);
    const client = this.opencodeClient(env.id);
    const session = await client.createSession(directory, { title });
    if (prompt?.trim()) await client.prompt(session.id, prompt, undefined, directory);
    this.monitors.get(env.id)?.reconcile?.();
    return session.id;
  }

  /** Deletes one of the project's sessions with its subagents, stopping it first when it isn't idle. */
  async removeSession(id: ProjectId, sessionId: string): Promise<void> {
    this.requireProject(id);
    const session = this.deps.store.sessionsOf(id).find((s) => s.id === sessionId);
    if (!session) throw new NotFoundError(sessionId, "session");
    const envId = session.envId ?? id;
    const client = this.opencodeClient(envId);
    if (session.status !== "idle") await client.interrupt(sessionId, session.directory);
    await client.deleteSession(sessionId, session.directory);
    this.log(id, `removed session ${session.title}`);
    this.monitors.get(envId)?.reconcile?.();
  }

  /** Sends a prompt to one of the project's sessions, queued behind the current turn when it is running. */
  async promptSession(id: ProjectId, sessionId: string, text: string): Promise<void> {
    this.requireProject(id);
    if (!text.trim()) throw new InvalidRequestError("the prompt is empty");
    const session = this.deps.store.sessionsOf(id).find((s) => s.id === sessionId);
    if (!session) throw new NotFoundError(sessionId, "session");
    const envId = session.envId ?? id;
    await this.opencodeClient(envId).prompt(sessionId, text, session.status === "running" ? "queue" : undefined, session.directory);
    this.monitors.get(envId)?.reconcile?.();
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
   * the task in its metadata, and the prompt. Worktrees are created in order under one git lock; a failing
   * variant is recorded on its result and the others still run, and worktrees already created are kept.
   * Isolated variants then start their own containers in parallel and get their sessions there.
   */
  async createTask(id: ProjectId, body: Record<string, unknown>): Promise<TaskResult> {
    const req = parseTaskRequest(body);
    const client = this.opencodeClient(id);
    const project = this.requireProject(id);
    const { isolated, notice } = req.where === "worktree" ? this.isolationFor(project, req.environment) : { isolated: false, notice: undefined };
    const title = req.title ?? deriveTitle(req.prompt);
    const of = req.variants.length;
    const labels = variantLabels(req.variants);
    const own: (EnvWorktree | undefined)[] = [];
    const { task, results } = await this.withGit(id, async (p) => {
      const rt = this.deps.store.runtime(id);
      const ws = this.workspaceFolder(p);
      const root = rt.worktreeRoot;
      const task = newTaskId((this.deps.now ?? Date.now)());
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
        if (notice) result.notice = notice;
        results.push(result);
        try {
          if (branch) {
            const wt = await this.deps.worktrees.add(p, { workspaceFolder: ws, root: root!, branch, base: req.base, onLine: (l) => this.log(id, l) });
            result.directory = wt.path;
            if (isolated && wt.hostPath) {
              own[i] = { path: wt.path, hostPath: wt.hostPath, branch };
              continue;
            }
          }
          const meta: TaskMeta = { task, variant: i + 1, of, title, ...(branch ? { branch } : {}) };
          await this.startVariant(client, result, result.directory!, meta, variantTitle(title, labels[i], of), v, req.prompt);
        } catch (err) {
          this.variantFailed(id, title, i, branch, result, err);
        }
      }
      if (branches.length > 0) {
        const created = results.flatMap((r) => (r.branch && r.directory ? [{ path: r.directory, branch: r.branch }] : []));
        const list = await this.deps.worktrees.list(p, ws, root).catch(() => {
          const known = rt.worktrees ?? [];
          return [...known, ...created.filter((c) => !known.some((w) => w.path === c.path))];
        });
        this.deps.store.updateRuntime(id, { worktrees: list });
      }
      return { task, results };
    });
    await Promise.all(
      own.map(async (worktree, i) => {
        if (!worktree) return;
        const result = results[i];
        try {
          const env = await this.ensureTaskEnv(project, worktree).catch((err: unknown) => {
            throw new Error(`its container did not start: ${err instanceof Error ? err.message : String(err)}`);
          });
          result.envId = env.id;
          const meta: TaskMeta = { task, variant: i + 1, of, title, branch: worktree.branch };
          await this.startVariant(this.opencodeClient(env.id), result, worktree.path, meta, variantTitle(title, labels[i], of), req.variants[i], req.prompt);
        } catch (err) {
          this.variantFailed(id, title, i, worktree.branch, result, err);
        }
      }),
    );
    const started = results.filter((r) => r.sessionId).length;
    this.log(id, `task ${title}: started ${started} of ${of} variant${of === 1 ? "" : "s"}`);
    this.monitors.get(id)?.reconcile?.();
    for (const r of results) if (r.envId) this.monitors.get(r.envId)?.reconcile?.();
    return { task, variants: results };
  }

  /** Creates a variant's session (recorded on the result at once) and sends the prompt. */
  private async startVariant(
    client: OpencodeClient,
    result: TaskVariantResult,
    directory: string,
    meta: TaskMeta,
    title: string,
    v: TaskVariantSpec,
    prompt: string,
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

  private variantFailed(id: ProjectId, title: string, i: number, branch: string | undefined, result: TaskVariantResult, err: unknown): void {
    result.error = err instanceof Error ? err.message : String(err);
    this.log(id, `task ${title}: variant ${i + 1}${branch ? ` (${branch})` : ""} failed: ${result.error}`);
    if (err instanceof CommandError) for (const line of err.tail) this.log(id, line);
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
    const clientOf = (s: SessionSummary) => this.opencodeClient(s.envId ?? id);
    const kept = variants.find((s) => s.id === keep)!;
    // A concurrent pick may have discarded this variant since the dashboard last saw it.
    if (parseTaskMeta((await clientOf(kept).session(keep)).metadata)?.discarded) throw new InvalidRequestError("that variant was already discarded");
    const others = variants.filter((s) => s.id !== keep);
    const result: PickResult = { discarded: [], removed: [], errors: [] };
    const discard = async () => {
      for (const s of others) {
        try {
          const client = clientOf(s);
          const raw = await client.session(s.id);
          await client.updateSession(s.id, { metadata: discardMetadata(raw.metadata) }, s.directory);
          result.discarded.push(s.id);
          // A discarded variant must not keep running (or be force-removed mid-run).
          if (s.status !== "idle") await client.interrupt(s.id, s.directory);
        } catch (err) {
          result.errors.push(`${s.title}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const envId of new Set([id, ...others.map((s) => s.envId ?? id)])) this.monitors.get(envId)?.reconcile?.();
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
        const rec = this.deps.store.environments(id).find((e) => e.worktree.path === dir);
        if (rec) {
          const env = this.taskEnv(p, rec);
          try {
            await this.exclusiveEnv(env, () => this.destroyEnv(env));
          } catch (err) {
            result.errors.push(`${wt.branch ?? dir}: kept — its container could not be removed: ${fail(err)}`);
            continue;
          }
        }
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
  async review(id: ProjectId, directory: string, opts: { base?: string; mode?: ReviewMode; file?: string } = {}): Promise<ReviewData> {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    const request = opts.base?.trim() ? validateBranch(opts.base) : undefined;
    const client = this.opencodeClient(this.envForDirectory(project, directory).id);
    const { git } = this.deps;
    const ws = this.workspaceFolder(project);
    const branch = await git.currentBranch(project, directory);
    const [config, opencodeBase, info] = await Promise.all([
      branch ? git.recordedBase(project, directory, branch) : undefined,
      client.vcsBase(directory).catch(() => undefined),
      client.vcsInfo(directory).catch((): { default?: string } => ({})),
    ]);
    const base = resolveBase({ request, config, opencode: opencodeBase, defaultBranch: info.default });
    const mode = diffMode(opts.mode, base);
    const [raw, status, counts, pushed, wsBranch, wsClean] = await Promise.all([
      client.vcsDiff(directory, mode, mode === "branch" ? base?.name : undefined),
      client.vcsStatus(directory),
      base ? git.aheadBehind(project, directory, base.name).catch(() => ({ ahead: 0, behind: 0 })) : { ahead: 0, behind: 0 },
      branch ? git.isPushed(project, directory, branch) : false,
      git.currentBranch(project, ws),
      git.isClean(project, ws),
    ]);
    const wanted = opts.file === undefined ? raw : raw.filter((f) => f.file === opts.file);
    const { files, truncated } = toReviewFiles(wanted, opts.file === undefined ? {} : NO_LIMITS);
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
      return (await this.opencodeClient(session.envId ?? id).generate(session.id, COMMIT_PROMPT, directory)).trim();
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

  /** A checkout as checks run it: its environment (and whether it runs) and its host folder. */
  checkTarget(id: ProjectId, directory: string): CheckTarget {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    const env = this.envForDirectory(project, directory);
    const running = this.deps.store.runtime(env.id).containerState === "running";
    return {
      project,
      exec: env.target,
      ...(running
        ? {}
        : { unavailable: env.worktree ? "this worktree's container is not running — start it from the Worktrees tab" : "the project's container is not running" }),
      checkout: this.checkout(project, directory),
      isMain: directory === this.workspaceFolder(project),
    };
  }

  /** Writes a line to the project's log. */
  note(id: ProjectId, line: string): void {
    this.log(id, line);
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
      return splitTitleBody(await this.opencodeClient(session.envId ?? id).generate(session.id, PUBLISH_PROMPT, directory));
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
    const envRt = this.deps.store.runtime(this.envForDirectory(project, directory).id);
    return this.deps.editors.open(editorId, {
      containerPath: directory,
      hostPath,
      containerName: envRt.containerState === "running" ? envRt.containerName : undefined,
    });
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.tunnels.keys()]) this.stopTunnel(id);
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
    const { store } = this.deps;
    const { runtime } = this.kit(env);
    let route: Route | undefined;
    if (info.ip) {
      try {
        route = await this.openRoute(env, { id: info.id, ip: info.ip, network: info.network });
      } catch (err) {
        this.fail(env, err);
        return;
      }
      const target = await this.startRelay(env, info.ip, route);
      await this.forwardPorts(env, target);
      await this.prepareCredentials(env, target);
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
    const { store } = this.deps;
    const { runtime, relay, containers } = this.kit(env);
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    const rt = store.runtime(env.id);
    store.updateRuntime(env.id, { containerState: "stopping", error: undefined });
    try {
      if (rt.containerState === "running") {
        await runtime.stopServer(env.target).catch(() => {});
        await relay.stop(env.target).catch(() => {});
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
      if (target.relay && !relayWasActive) {
        await this.forwardPorts(env, target);
        await this.prepareCredentials(env, target);
      }
      await this.launchOpencode(env, undefined);
    } catch (err) {
      this.fail(env, err);
    }
  }

  private async adoptTask(info: ContainerInfo): Promise<void> {
    const { store } = this.deps;
    const rec = store.environment(info.envId!);
    const project = rec && store.project(rec.projectId);
    if (!rec || !project) {
      const owner = info.envProjectId ? store.project(info.envProjectId) : undefined;
      if (owner) this.log(owner.id, `environment: ignoring container ${info.name ?? info.id}: opendevhub has no record of ${info.envId}`);
      return;
    }
    const env = this.taskEnv(project, rec);
    if (!info.running) {
      store.updateRuntime(env.id, { containerId: info.id, containerState: "stopped", opencode: "absent" });
      return;
    }
    store.updateRuntime(env.id, { containerId: info.id, containerName: info.name, containerIp: info.ip, containerState: "running" });
    await this.adoptRunning(env, info);
  }

  /** Records a worktree's own environment (or returns the one it has). */
  private recordTaskEnv(project: Project, worktree: EnvWorktree): TaskEnv {
    const { store } = this.deps;
    const existing = store.environments(project.id).find((e) => e.worktree.path === worktree.path);
    if (existing) return this.taskEnv(project, existing);
    const rec: EnvRecord = { id: envIdFor(project.id, worktree.path, worktree.branch), projectId: project.id, worktree };
    store.putEnvironment(rec);
    return this.taskEnv(project, rec);
  }

  /** The worktree's own environment, started unless it already runs. */
  private async ensureTaskEnv(project: Project, worktree: EnvWorktree): Promise<TaskEnv> {
    const env = this.recordTaskEnv(project, worktree);
    const rt = this.deps.store.runtime(env.id);
    if (rt.containerState === "running" && rt.opencode === "healthy") return env;
    await this.exclusiveEnv(env, () => this.bringUpTask(env));
    return env;
  }

  /**
   * Starts a task container: the base image for the worktree's config, the override config, `up`, then
   * route, relay, ports and opencode as for the main container. Records the error and rethrows it.
   */
  private async bringUpTask(env: TaskEnv): Promise<void> {
    const { store } = this.deps;
    const kit = this.kit(env);
    const { containers } = kit;
    store.updateRuntime(env.id, { containerState: "starting", opencode: "absent", error: undefined });
    try {
      if (env.node === LOCAL_NODE && store.runtime(env.project.id).containerState !== "running") {
        throw new UnavailableError("start the project first: task containers are prepared from its container");
      }
      const images = kit.images;
      if (!images) throw new UnavailableError("task environments are not available in this build");
      const image = await images.ensureBase(env.project, env.worktree, this.settingsOf(env.project).keyFiles, (l) => this.envLog(env, l));
      const read = await containers.readConfig(env.worktree.hostPath);
      const blocker = isolationBlocker(read.configuration, read.workspaceFolder);
      if (blocker) throw new UnavailableError(blocker);
      const { config, notes } = buildOverrideConfig({
        config: read.configuration,
        guessedFolder: read.workspaceFolder,
        image: image.ref,
        worktree: env.worktree,
        gitDir: this.gitDirOf(env),
      });
      for (const note of notes) this.envLog(env, `environment: ${note}`);
      await kit.envFiles.write(env.id, config);
      const rec = store.environment(env.id);
      if (rec) store.putEnvironment({ ...rec, image });
      const up = await this.upTask(env);
      store.updateRuntime(env.id, { containerId: up.containerId });
      const info = await containers.inspect(up.containerId);
      if (!info?.running) throw new CommandError("container is not running after devcontainer up");
      if (!info.ip) throw new CommandError("container has no bridge network IP (host networking is not supported)");
      store.updateRuntime(env.id, {
        containerId: up.containerId,
        containerName: info.name,
        containerIp: info.ip,
        remoteUser: up.remoteUser,
        workspaceFolder: up.remoteWorkspaceFolder,
        containerState: "running",
        opencode: "starting",
      });
      const route = await this.openRoute(env, { id: up.containerId, ip: info.ip, network: info.network });
      const target = await this.startRelay(env, info.ip, route);
      await this.forwardPorts(env, target);
      await this.prepareCredentials(env, target);
      await this.launchOpencode(env, store.runtime(env.id).password);
    } catch (err) {
      this.fail(env, err);
      throw err;
    }
  }

  private upTask(env: TaskEnv): ReturnType<ContainersPort["up"]> {
    const { containers } = this.kit(env);
    const next = (this.taskUps.get(env.node) ?? Promise.resolve()).then(() =>
      containers.up(env.target, { rebuild: false, onLine: (l) => this.envLog(env, l) }),
    );
    this.taskUps.set(env.node, next.catch(() => {}));
    return next;
  }

  /** Deletes a task container, its generated config and the UID image the CLI built for it. Throws when the container stays. */
  /** Removes a worktree and its own container first; keeps the worktree when the container won't go. */
  private async dropWorktree(p: Project, worktreePath: string, force: boolean): Promise<void> {
    const rec = this.deps.store.environments(p.id).find((e) => e.worktree.path === worktreePath);
    if (rec) {
      const env = this.taskEnv(p, rec);
      try {
        await this.exclusiveEnv(env, () => this.destroyEnv(env));
      } catch (err) {
        if (err instanceof BusyError) throw err;
        throw new UnavailableError(`kept the worktree: its container could not be removed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    await this.deps.worktrees.remove(p, this.workspaceFolder(p), worktreePath, force);
    this.log(p.id, `worktree: removed ${worktreePath}`);
  }

  private async destroyEnv(env: TaskEnv): Promise<void> {
    const { store } = this.deps;
    const kit = this.kit(env);
    const { containers } = kit;
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    await this.closeRoute(env.id);
    const containerId = store.runtime(env.id).containerId;
    if (containerId) {
      const image = (await containers.inspect(containerId).catch(() => undefined))?.image;
      await containers.remove(containerId);
      if (image && /^vsc-.+-uid$/.test(image.split(":")[0])) await containers.removeImage(image);
    }
    await kit.envFiles.remove(env.id).catch(() => {});
    store.removeEnvironment(env.id);
    this.envLog(env, "environment: removed");
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
      const target = await this.startRelay(env, info.ip, route);
      await this.forwardPorts(env, target);
      await this.prepareCredentials(env, target);
      await this.refreshWorktreesQuietly(project);
      await this.launchOpencode(env, rebuild ? undefined : store.runtime(env.id).password);
    } catch (err) {
      this.fail(env, err);
    }
  }

  private async launchOpencode(env: Env, password: string | undefined): Promise<void> {
    const { store } = this.deps;
    const { runtime } = this.kit(env);
    const route = this.routes.get(env.id);
    if (!route) throw new Error("container is not running — start the project first");
    const result = await runtime.ensureRunning(env.target, {
      address: route.opencode,
      password,
      workspaceFolder: this.envDirectory(env),
      onLine: (l) => this.envLog(env, l),
      ...(this.sshAgentOf(env) ? { env: { SSH_AUTH_SOCK: AGENT_SOCKET } } : {}),
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
    return { id: project.id, project, node: LOCAL_NODE, target: project };
  }

  private envOf(id: EnvId): Env | undefined {
    const { store } = this.deps;
    const project = store.project(id);
    if (project) return this.mainEnv(project);
    const rec = store.environment(id);
    const owner = rec && store.project(rec.projectId);
    return rec && owner ? this.taskEnv(owner, rec) : undefined;
  }

  private allEnvs(): Env[] {
    return this.deps.store
      .projects()
      .flatMap((p) => [this.mainEnv(p), ...this.deps.store.environments(p.id).map((r) => this.taskEnv(p, r))]);
  }

  /** The checkout an environment's opencode serves and its monitor watches. */
  private envDirectory(env: Env): string {
    return env.worktree?.path ?? this.workspaceFolder(env.project);
  }

  /**
   * Worktrees whose sessions the main environment's monitor lists: all of them, so sessions its opencode
   * ran in a worktree before the worktree got its own container stay visible (and answerable).
   */
  private sharedWorktrees(projectId: ProjectId): string[] {
    return (this.deps.store.runtime(projectId).worktrees ?? []).map((w) => w.path);
  }

  private envFiles(): EnvFilesPort {
    return this.deps.envFiles ?? (this.defaultEnvFiles ??= new EnvFiles(path.join(stateDir(), "envs")));
  }

  private taskEnv(project: Project, rec: EnvRecord): TaskEnv {
    const node = rec.node ?? LOCAL_NODE;
    // An offline node has no kit, so no config path; every action on it fails in kit() first.
    const files = node === LOCAL_NODE ? this.envFiles() : this.deps.nodes?.kit(node)?.envFiles;
    return {
      id: rec.id,
      project,
      node,
      worktree: rec.worktree,
      target: {
        id: rec.id,
        path: rec.worktree.hostPath,
        idLabels: envLabels(rec.id, project.id),
        ...(files ? { overrideConfig: files.path(rec.id) } : {}),
      },
    };
  }

  /** The tools for an environment's node; throws while that node is offline. */
  private kit(env: Env): Kit {
    const kit = this.kitOf(env.node);
    if (!kit) throw new UnavailableError(`node ${env.node} is unreachable`);
    return kit;
  }

  private kitOf(node: NodeId): Kit | undefined {
    if (node !== LOCAL_NODE) return this.deps.nodes?.kit(node);
    const d = this.deps;
    return {
      containers: d.containers,
      runtime: d.runtime,
      relay: d.relay,
      images: d.images,
      envFiles: this.envFiles(),
      credentials: d.credentials,
      network: d.network ?? DIRECT,
      git: d.git,
    };
  }

  /** The project's .git as a task container mounts it: from this machine, or from the node's repository. */
  private gitDirOf(env: TaskEnv): { host: string; container: string } {
    const ws = this.workspaceFolder(env.project);
    const container = path.posix.join(ws, ".git");
    if (env.node === LOCAL_NODE) return { host: path.join(env.project.path, ".git"), container };
    return { host: this.kit(env).repo!.layout(env.project, ws).gitDir, container };
  }

  private requireTaskEnv(projectId: ProjectId, envId: EnvId): TaskEnv {
    const project = this.requireProject(projectId);
    const rec = this.deps.store.environment(envId);
    if (!rec || rec.projectId !== projectId) throw new NotFoundError(envId, "environment");
    return this.taskEnv(project, rec);
  }

  /** The environment whose opencode serves a checkout: the worktree's own, or the project's. */
  private envForDirectory(project: Project, directory: string): Env {
    const rec = this.deps.store.environments(project.id).find((e) => e.worktree.path === directory);
    return rec ? this.taskEnv(project, rec) : this.mainEnv(project);
  }

  /** Whether to forward the ssh-agent into this environment: its own configuration first, then the project's settings. */
  private sshAgentOf(env: Env): boolean {
    return this.sshAgents.get(env.id) ?? this.settingsOf(env.project).sshAgent;
  }

  private settingsOf(project: Project): EnvSettings {
    return this.settings.get(project.id) ?? resolveEnvSettings(undefined, this.deps.projectSettings?.(project));
  }

  /** Reads the project's isolation settings from its devcontainer.json (as read for ports) and config.json. */
  private noteSettings(project: Project, configuration: Record<string, unknown> | undefined): void {
    const custom = (configuration?.customizations as Record<string, unknown> | undefined)?.opendevhub;
    const settings = resolveEnvSettings(custom, this.deps.projectSettings?.(project));
    this.settings.set(project.id, settings);
    const unsupported = configuration ? isolationBlocker(configuration) : undefined;
    this.deps.store.setIsolation(project.id, unsupported ? { default: "shared", unsupported } : { default: settings.isolation });
  }

  /** Whether a task's worktrees get their own containers, and why not when that was asked for. */
  private isolationFor(project: Project, requested: Isolation | undefined): { isolated: boolean; notice?: string } {
    const info = this.deps.store.isolation(project.id);
    const wanted = requested ?? info?.default ?? this.settingsOf(project).isolation;
    if (wanted !== "isolated") return { isolated: false };
    if (info?.unsupported) return { isolated: false, notice: `runs in the shared container: ${info.unsupported}` };
    return { isolated: true };
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
    const { store, forwarder } = this.deps;
    const { containers } = this.kit(env);
    let config: PortConfig;
    try {
      config = await containers.readConfiguration(env.target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.envLog(env, `ports: could not read devcontainer configuration: ${message}`);
      store.updateRuntime(env.id, { ports: [] });
      if (!env.worktree) this.noteSettings(env.project, undefined);
      this.sshAgents.delete(env.id);
      return;
    }
    if (!env.worktree) this.noteSettings(env.project, config.configuration);
    const custom = (config.configuration?.customizations as Record<string, unknown> | undefined)?.opendevhub;
    this.sshAgents.set(env.id, resolveEnvSettings(custom, this.deps.projectSettings?.(env.project)).sshAgent);
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
    const route = await this.kit(env).network.route(container, (line) => this.envLog(env, line));
    this.routes.set(env.id, route);
    return route;
  }

  private async closeRoute(id: EnvId): Promise<void> {
    const route = this.routes.get(id);
    this.routes.delete(id);
    await route?.close();
  }

  private async startRelay(env: Env, ip: string, route: Route): Promise<ForwardTarget> {
    const { store } = this.deps;
    const { runtime, relay } = this.kit(env);
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

  /** Git identity, known_hosts and the ssh-agent tunnel. Never throws: each step logs what happened. */
  private async prepareCredentials(env: Env, target: ForwardTarget): Promise<void> {
    const { store } = this.deps;
    const { credentials } = this.kit(env);
    const sshAgent = this.sshAgentOf(env);
    if (credentials) {
      try {
        await credentials.prepare(env.target, env.project.path, { sshAgent, onLine: (l) => this.envLog(env, l) });
      } catch (err) {
        this.envLog(env, `credentials: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.stopTunnel(env.id);
    if (!sshAgent) {
      store.updateRuntime(env.id, { sshAgent: "off", sshAgentReason: undefined });
      return;
    }
    if (!target.relay) {
      store.updateRuntime(env.id, { sshAgent: "unavailable", sshAgentReason: "relay not running" });
      this.envLog(env, "ssh-agent: unavailable (relay not running)");
      return;
    }
    const relayTarget: RelayTarget = { host: target.relay.host ?? target.host, port: target.relay.port, token: target.relay.token };
    const factory: AgentTunnelFactory = this.deps.agentTunnel ?? ((t, o) => new AgentTunnel(t, o));
    const tunnel = factory(relayTarget, {
      onLog: (l) => this.envLog(env, l),
      onStatus: (s) => store.updateRuntime(env.id, { sshAgent: s.state, sshAgentReason: s.reason }),
      onRelayLost: () => void this.recoverRelay(env.id),
    });
    this.tunnels.set(env.id, tunnel);
    tunnel.start();
  }

  private stopTunnel(id: EnvId): void {
    this.tunnels.get(id)?.stop();
    this.tunnels.delete(id);
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
    this.stopTunnel(id);
    this.sshAgents.delete(id);
    await this.deps.forwarder.close(id);
    this.deps.store.updateRuntime(id, { ports: undefined, relay: undefined, sshAgent: undefined, sshAgentReason: undefined });
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
    const env = this.envOf(id);
    if (env && env.node !== LOCAL_NODE && !this.kitOf(env.node)) throw new UnavailableError(`node ${env.node} is unreachable`);
    const rt = this.deps.store.runtime(id);
    const route = this.routes.get(id);
    if (rt.containerState !== "running" || rt.opencode !== "healthy" || !route || !rt.password) {
      throw new UnavailableError(
        this.deps.store.environment(id)
          ? "this worktree's container is not running — start it from the Worktrees tab"
          : "opencode is not running — start the project first",
      );
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
    let found: { item: T; directory: string; envId: EnvId } | undefined;
    for (const s of this.deps.store.sessionsOf(id)) {
      const item = s.pending && find(s.pending);
      if (item) {
        found = { item, directory: s.directory, envId: s.envId ?? id };
        break;
      }
    }
    if (!found) throw new NotFoundError(itemId, what);
    const client = this.opencodeClient(found.envId);
    try {
      await send(client, found.item, found.directory);
    } catch (err) {
      if (isGone(err)) throw new AlreadyAnsweredError();
      if (isInvalidAnswer(err)) throw new InvalidRequestError(err.detail ?? "opencode rejected the answer");
      throw err;
    } finally {
      this.monitors.get(id)?.reconcile?.();
      if (found.envId !== id) this.monitors.get(found.envId)?.reconcile?.();
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
      onRawSessions: (sessions) => this.deps.recordUsage?.(env.project.id, sessions),
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
