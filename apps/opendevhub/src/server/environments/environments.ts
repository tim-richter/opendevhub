import fs from "node:fs/promises";
import path from "node:path";

import type {
  EnvId,
  EnvWorktree,
  ForwardedPort,
  Isolation,
  NodeId,
  Project,
  ProjectId,
  Worktree,
  WorktreeRoot,
} from "../../shared/types";
import { stateDir } from "../config";
import { USER, variantActor } from "../db/events";
import { BusyError, NotFoundError, UnavailableError } from "../errors";
import { InvalidRequestError, mountArg, worktreeRoot } from "../git/worktrees";
import type { ForwardTarget } from "../network/port-forwarder";
import { parseForwardPorts } from "../network/ports";
import { AGENT_SOCKET, AgentTunnel } from "../network/relay/agent";
import type { RelayTarget } from "../network/relay/client";
import { generateRelayToken } from "../network/relay/runtime";
import type { HostPort, Route, RouteContainer } from "../network/routes";
import { LOCAL_NODE } from "../nodes/host";
import { isGone } from "../opencode/client";
import type { OpencodeClient } from "../opencode/client";
import {
  opencodeMount,
  opencodeVolume,
  VOLUME_LABEL,
} from "../opencode/runtime";
import type { EnvRecord } from "../projects/state";
import { reconcileTasks } from "../sessions/reconcile";
import type { Presence } from "../sessions/reconcile";
import {
  buildOverrideConfig,
  envIdFor,
  isolationBlocker,
  resolveEnvSettings,
} from "./config";
import type { EnvSettings } from "./config";
import { CommandError, envLabels, LABEL } from "./containers";
import type { ContainerInfo, ExecTarget, PortConfig } from "./containers";
import { EnvFiles } from "./files";
import { cleanLogLine, LogBuffer } from "./log-buffer";
import { Monitor } from "./monitor";
import type { MonitorOptions } from "./monitor";
import { DIRECT, repoOf } from "./ports";
import type {
  AgentTunnelFactory,
  AgentTunnelHandle,
  ContainersPort,
  EnvFilesPort,
  HubDeps,
  Kit,
  MonitorHandle,
} from "./ports";

const RELAY_RECOVERY_INTERVAL_MS = 30_000;
const GIT_WAIT_MS = 200;
const GIT_WAIT_LIMIT_MS = 120_000;

/**
 * One devcontainer with its opencode, relay, route, port forwards and monitor. A project's main
 * environment has the project's id and the project's container; a task environment serves one worktree.
 */
export interface Env {
  id: EnvId;
  project: Project;
  /** Where its container runs. */
  node: NodeId;
  /** What `devcontainer up` and `exec` address: the project itself for the main environment. */
  target: ExecTarget;
  /** Set on task environments. */
  worktree?: EnvWorktree;
}

export type TaskEnv = Env & { worktree: EnvWorktree };

/**
 * Every Environment's lifecycle (provision, connect, disconnect, stop, remove) and what each one holds while it
 * runs. The Hub's other modules reach environments through the methods under "For the Hub's modules".
 */
export class Environments {
  private readonly busy = new Set<EnvId>();
  private readonly monitors = new Map<EnvId, MonitorHandle>();
  private readonly logs = new Map<ProjectId, LogBuffer>();
  private readonly logListeners = new Set<
    (projectId: ProjectId, line: string) => void
  >();
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
  /** The starting task variant an environment is being set up for, so its steps and log lines reach it. */
  private readonly setups = new Map<EnvId, { task: string; variant: number }>();
  private defaultEnvFiles?: EnvFilesPort;
  /**
   * Task containers come up one at a time per node: concurrent `devcontainer up` calls race on the CLI's shared
   * temp files (its UID Dockerfile) and one of them fails.
   */
  private readonly taskUps = new Map<NodeId, Promise<unknown>>();
  /** What `devcontainer exec` adds to `docker exec`'s environment, probed once per container id. */
  private readonly terminalEnvs = new Map<
    string,
    Promise<Record<string, string>>
  >();
  private readonly unwatchListeners = new Set<(id: EnvId) => void>();
  private readonly deps: HubDeps;
  constructor(deps: HubDeps) {
    this.deps = deps;
  }

  async rescan(): Promise<void> {
    const list = await this.deps.scan(this.deps.roots());
    this.deps.projects.upsertAll(list);
    this.deps.store.setProjects(list);
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

  /** Recreates the project's container; `noCache` also rebuilds its image without Docker's layer cache. */
  rebuild(id: ProjectId, noCache = false): Promise<void> {
    return this.exclusive(id, async (p) => {
      this.stopMonitor(p.id);
      await this.closePorts(p.id);
      await this.bringUp(p, true, noCache);
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
        if (!this.kitOf(env.node)) {
          continue;
        }
        const rt = store.runtime(env.id);
        if (
          this.busy.has(env.id) ||
          !rt.containerId ||
          rt.containerState === "stopped"
        ) {
          continue;
        }
        await this.exclusiveEnv(env, () => this.stopContainer(env));
      }
      await this.stopContainer(this.mainEnv(p));
    });
  }

  /** Gives a worktree its own container and starts it in the background. */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async createEnv(
    projectId: ProjectId,
    worktreePath: string
  ): Promise<{ envId: EnvId }> {
    const project = this.requireProject(projectId);
    const { store } = this.deps;
    if (store.runtime(projectId).containerState !== "running") {
      throw new UnavailableError(
        "the container is not running — start the project first"
      );
    }
    const unsupported = store.isolation(projectId)?.unsupported;
    if (unsupported) {
      throw new InvalidRequestError(unsupported);
    }
    const wt = store
      .runtime(projectId)
      .worktrees?.find((w) => w.path === worktreePath);
    if (!wt) {
      throw new InvalidRequestError(`unknown worktree ${worktreePath}`);
    }
    if (!wt.hostPath) {
      throw new InvalidRequestError(
        `${worktreePath} is not in the mounted worktrees folder, so it can't get its own container`
      );
    }
    const env = this.recordTaskEnv(project, {
      branch: wt.branch ?? path.posix.basename(wt.path),
      hostPath: wt.hostPath,
      path: wt.path,
    });
    void this.exclusiveEnv(env, () => this.bringUpTask(env)).catch(
      () => undefined
    );
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

  /**
   * Recreates a worktree's container from its devcontainer config; running sessions are interrupted.
   * `noCache` also rebuilds its images without Docker's layer cache.
   */
  rebuildEnv(
    projectId: ProjectId,
    envId: EnvId,
    noCache = false
  ): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    this.kit(env);
    return this.exclusiveEnv(env, async () => {
      this.stopMonitor(env.id);
      await this.closePorts(env.id);
      await this.bringUpTask(env, true, noCache);
    });
  }

  restartEnvOpencode(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    this.kit(env);
    return this.exclusiveEnv(env, () => this.relaunchOpencode(env));
  }

  /** Deletes a worktree's container; the worktree and its files stay, its sessions go. */
  removeEnv(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    this.kit(env);
    return this.destroy(env);
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
      const project = info.projectId
        ? store.project(info.projectId)
        : undefined;
      if (!project) {
        continue;
      }
      const env = this.mainEnv(project);
      if (!info.running) {
        store.updateRuntime(env.id, {
          containerId: info.id,
          containerState: "stopped",
          opencode: "absent",
        });
        continue;
      }
      store.updateRuntime(env.id, {
        containerId: info.id,
        containerIp: info.ip,
        containerName: info.name,
        containerState: "running",
        worktreeRoot: this.detectWorktreeRoot(
          project,
          this.workspaceFolder(project),
          info
        ),
      });
      await this.adoptRunning(env, info);
    }
  }

  async refreshContainers(): Promise<void> {
    const { store } = this.deps;
    for (const env of this.allEnvs()) {
      const kit = this.kitOf(env.node);
      if (!kit) {
        continue;
      }
      const rt = store.runtime(env.id);
      if (
        this.busy.has(env.id) ||
        rt.containerState !== "running" ||
        !rt.containerId
      ) {
        continue;
      }
      try {
        const info = await kit.containers.inspect(rt.containerId);
        // A lifecycle action (start/stop/rebuild/...) may have started while inspect() was in
        // flight; if so it owns the environment's state now, so don't race it with a stale write.
        if (this.busy.has(env.id)) {
          continue;
        }
        if (info?.running) {
          continue;
        }
        await this.markStopped(env);
      } catch {
        // One environment's docker inspect failing shouldn't stop the others from refreshing.
      }
    }
  }

  /** A node came (back) online: adopt its containers as at startup; environments whose container is gone stop. */
  async nodeOnline(node: NodeId): Promise<void> {
    const kit = this.kitOf(node);
    if (!kit || node === LOCAL_NODE) {
      return;
    }
    let managed: ContainerInfo[];
    try {
      managed = await kit.containers.listManaged();
    } catch {
      return;
    }
    const { store } = this.deps;
    for (const project of store.projects()) {
      for (const rec of store.environments(project.id)) {
        if (rec.node !== node || this.busy.has(rec.id)) {
          continue;
        }
        const info = managed.find((i) => i.envId === rec.id);
        if (info) {
          await this.adoptTask(info);
        } else if (store.runtime(rec.id).containerState !== "stopped") {
          await this.markStopped(this.taskEnv(project, rec));
        }
      }
    }
  }

  /** A node dropped: stop watching its environments and close their routes. Their state and sessions stay as last seen. */
  async nodeOffline(node: NodeId): Promise<void> {
    for (const env of this.allEnvs()) {
      if (env.node !== node) {
        continue;
      }
      this.stopMonitor(env.id);
      await this.closePorts(env.id);
      await this.closeRoute(env.id);
    }
  }

  /** Only known checkouts in running environments may open a terminal. */
  async terminalTarget(id: ProjectId, directory: string) {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    const env = this.envForDirectory(project, directory);
    const rt = this.deps.store.runtime(env.id);
    if (rt.containerState !== "running" || !rt.containerId) {
      throw new UnavailableError(
        "Start this checkout's container to open a terminal"
      );
    }
    const { containerId } = rt;
    let probe = this.terminalEnvs.get(containerId);
    if (!probe) {
      probe = (
        this.kit(env).containers.remoteEnv?.(
          env.target,
          containerId,
          rt.remoteUser
        ) ?? Promise.resolve({})
      ).catch(() => ({}));
      this.terminalEnvs.set(containerId, probe);
    }
    return {
      containerId,
      env: await probe,
      node: env.node,
      user: rt.remoteUser,
    };
  }

  /** Writes a line to the project's log. */
  note(id: ProjectId, line: string): void {
    this.log(id, line);
  }

  async shutdown(): Promise<void> {
    for (const id of this.tunnels.keys()) {
      this.stopTunnel(id);
    }
    for (const id of this.monitors.keys()) {
      this.stopMonitor(id);
    }
    await this.deps.forwarder.closeAll();
    await Promise.all([...this.routes.keys()].map((id) => this.closeRoute(id)));
  }

  // For the Hub's modules: resolving checkouts and environments, locks, opencode clients and the project log.

  /** withGit, but waits (up to two minutes) while another git action or lifecycle action holds the project. */
  async withGitWhenFree<T>(
    id: ProjectId,
    fn: (project: Project) => Promise<T>
  ): Promise<T> {
    const delay =
      this.deps.delay ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    for (
      let waited = 0;
      this.busy.has(id) || this.gitBusy.has(id);
      waited += GIT_WAIT_MS
    ) {
      if (waited >= GIT_WAIT_LIMIT_MS) {
        throw new BusyError(id);
      }
      await delay(GIT_WAIT_MS);
    }
    return this.withGit(id, fn);
  }

  requireProject(id: ProjectId): Project {
    const project = this.deps.store.project(id);
    if (!project) {
      throw new NotFoundError(id);
    }
    return project;
  }

  /** Only the workspace and worktrees git reports may be opened — never an arbitrary path from a request. */
  checkDirectory(id: ProjectId, directory: string): void {
    const project = this.requireProject(id);
    if (directory === this.workspaceFolder(project)) {
      return;
    }
    if (
      this.deps.store.runtime(id).worktrees?.some((w) => w.path === directory)
    ) {
      return;
    }
    if (
      this.deps.store
        .environments(id)
        .some((e) => e.worktree.path === directory)
    ) {
      return;
    }
    throw new InvalidRequestError(
      `${directory} is neither the workspace nor a known worktree`
    );
  }

  /** Git work in the container: needs it running, and runs one at a time per project. */
  withGit<T>(id: ProjectId, fn: (project: Project) => Promise<T>): Promise<T> {
    const project = this.requireProject(id);
    if (this.busy.has(id) || this.gitBusy.has(id)) {
      throw new BusyError(id);
    }
    if (this.deps.store.runtime(id).containerState !== "running") {
      throw new UnavailableError(
        "the container is not running — start the project first"
      );
    }
    this.gitBusy.add(id);
    return fn(project).finally(() => this.gitBusy.delete(id));
  }

  /** The worktree's own environment, started unless it already runs. */
  async ensureTaskEnv(
    project: Project,
    worktree: EnvWorktree,
    node: NodeId = LOCAL_NODE,
    setup?: { task: string; variant: number }
  ): Promise<TaskEnv> {
    const env = this.recordTaskEnv(project, worktree, node, setup);
    const rt = this.deps.store.runtime(env.id);
    if (rt.containerState === "running" && rt.opencode === "healthy") {
      return env;
    }
    if (setup) {
      this.setups.set(env.id, setup);
    }
    try {
      await this.exclusiveEnv(env, () => this.bringUpTask(env));
    } finally {
      this.setups.delete(env.id);
    }
    return env;
  }

  /** The remote environment whose worktree is `directory`, if one is. */
  remoteEnvAt(project: Project, directory: string): TaskEnv | undefined {
    const rec = this.deps.store
      .environments(project.id)
      .find((e) => e.node && e.worktree.path === directory);
    return rec ? this.taskEnv(project, rec) : undefined;
  }

  workspaceFolder(project: Project): string {
    return (
      this.deps.store.runtime(project.id).workspaceFolder ??
      `/workspaces/${path.basename(project.path)}`
    );
  }

  taskEnv(project: Project, rec: EnvRecord): TaskEnv {
    const node = rec.node ?? LOCAL_NODE;
    // An offline node has no kit, so no config path; every action on it fails in kit() first.
    const files =
      node === LOCAL_NODE
        ? this.envFiles()
        : this.deps.nodes?.kit(node)?.envFiles;
    return {
      id: rec.id,
      node,
      project,
      target: {
        id: rec.id,
        idLabels: envLabels(rec.id, project.id),
        path: rec.worktree.hostPath,
        ...(files ? { overrideConfig: files.path(rec.id) } : {}),
      },
      worktree: rec.worktree,
    };
  }

  /** The tools for an environment's node; throws while that node is offline. */
  kit(env: Env): Kit {
    const kit = this.kitOf(env.node);
    if (!kit) {
      throw new UnavailableError(`node ${env.node} is unreachable`);
    }
    return kit;
  }

  /** The environment whose opencode serves a checkout: the worktree's own, or the project's. */
  envForDirectory(project: Project, directory: string): Env {
    const rec = this.deps.store
      .environments(project.id)
      .find((e) => e.worktree.path === directory);
    return rec ? this.taskEnv(project, rec) : this.mainEnv(project);
  }

  /** Whether a task's worktrees get their own containers, and why not when that was asked for. */
  isolationFor(
    project: Project,
    requested: Isolation | undefined
  ): { isolated: boolean; notice?: string } {
    const info = this.deps.store.isolation(project.id);
    const wanted =
      requested ?? info?.default ?? this.settingsOf(project).isolation;
    if (wanted !== "isolated") {
      return { isolated: false };
    }
    if (info?.unsupported) {
      return {
        isolated: false,
        notice: `runs in the shared container: ${info.unsupported}`,
      };
    }
    return { isolated: true };
  }

  /** Runs a review git action and writes its outcome (and git's last lines on failure) to the project log. */
  async gitAction<T>(
    id: ProjectId,
    what: string,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      const result = await fn();
      this.log(id, `review: ${what}`);
      return result;
    } catch (error) {
      this.log(
        id,
        `review: ${what} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      if (error instanceof CommandError) {
        for (const line of error.tail) {
          this.log(id, line);
        }
      }
      throw error;
    }
  }

  opencodeClient(id: EnvId): OpencodeClient {
    const env = this.envOf(id);
    if (env && env.node !== LOCAL_NODE && !this.kitOf(env.node)) {
      throw new UnavailableError(`node ${env.node} is unreachable`);
    }
    const rt = this.deps.store.runtime(id);
    const route = this.routes.get(id);
    if (
      rt.containerState !== "running" ||
      rt.opencode !== "healthy" ||
      !route ||
      !rt.password
    ) {
      throw new UnavailableError(
        this.deps.store.environment(id)
          ? "this worktree's container is not running — start it from the Worktrees tab"
          : "opencode is not running — start the project first"
      );
    }
    return this.deps.clientFor(
      this.deps.runtime.endpoint(route.opencode, rt.password)
    );
  }

  /**
   * A successful listing of the project's linked worktrees on this machine: reconciles their rows, then shows the
   * list. Fallback lists, made up after a failed listing, go to `updateRuntime` directly.
   */
  setWorktrees(id: ProjectId, list: Worktree[]): void {
    this.deps.checkouts.reconcileWorktrees(id, list);
    this.deps.store.updateRuntime(id, { worktrees: list });
  }

  log(id: ProjectId, raw: string): void {
    const line = cleanLogLine(raw);
    if (!line) {
      return;
    }
    let buffer = this.logs.get(id);
    if (!buffer) {
      buffer = new LogBuffer();
      this.logs.set(id, buffer);
    }
    buffer.push(line);
    for (const fn of this.logListeners) {
      fn(id, line);
    }
  }

  /** Destroys a task environment as removeEnv does, for a module that already resolved it. */
  destroy(env: TaskEnv): Promise<void> {
    this.kit(env);
    return this.exclusiveEnv(env, () => this.destroyEnv(env));
  }

  /** Asks an environment's monitor to poll now, after something changed its sessions. */
  reconcile(id: EnvId): void {
    this.monitors.get(id)?.reconcile?.();
  }

  /** Calls `fn` whenever an environment stops being watched (stopped, rebuilt, offline): what it served may change. */
  onUnwatch(fn: (id: EnvId) => void): void {
    this.unwatchListeners.add(fn);
  }

  /** Creates the host worktrees folder so `up` can mount it next to the workspace. */
  private async worktreeMounts(project: Project): Promise<string[]> {
    const planned =
      (await this.deps.containers
        .workspaceFolder(project)
        .catch(() => undefined)) ?? this.workspaceFolder(project);
    const root = worktreeRoot(project.path, planned, false);
    try {
      await (
        this.deps.mkdir ??
        ((dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined))
      )(root.host);
      return [mountArg(root)];
    } catch (error) {
      this.log(
        project.id,
        `worktrees: could not create ${root.host}: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  /**
   * The volume that keeps an environment's opencode sessions across rebuilds. Created up front only to label it
   * (so it can be found later); `up` creates it anyway.
   */
  private async opencodeMounts(env: Env): Promise<string[]> {
    const labels = [
      `${VOLUME_LABEL}=opencode`,
      ...(env.worktree
        ? envLabels(env.id, env.project.id)
        : [`${LABEL}=${env.id}`]),
    ];
    await this.kit(env)
      .containers.ensureVolume(opencodeVolume(env.id), labels)
      .catch(() => false);
    return [opencodeMount(env.id)];
  }

  private detectWorktreeRoot(
    project: Project,
    workspaceFolder: string,
    info: ContainerInfo
  ): WorktreeRoot {
    const root = worktreeRoot(project.path, workspaceFolder, false);
    const source = info.binds?.[root.container];
    if (source === undefined) {
      this.log(
        project.id,
        "worktrees: this container has no worktrees mount — rebuild it to enable worktrees"
      );
      return root;
    }
    return { ...root, host: source, mounted: true };
  }

  private async refreshWorktreesQuietly(project: Project): Promise<void> {
    if (this.gitBusy.has(project.id)) {
      return;
    }
    this.gitBusy.add(project.id);
    try {
      const rt = this.deps.store.runtime(project.id);
      const list = await this.deps.worktrees.list(
        project,
        this.workspaceFolder(project),
        rt.worktreeRoot
      );
      this.setWorktrees(project.id, list);
    } catch (error) {
      this.log(
        project.id,
        `worktrees: could not list: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.gitBusy.delete(project.id);
    }
  }

  /** A session in a directory we don't know is probably in a worktree created elsewhere (opencode, a shell). */
  private noticeDirectories(id: ProjectId, directories: string[]): void {
    const project = this.deps.store.project(id);
    if (!project || this.busy.has(id)) {
      return;
    }
    const seen = this.seenDirectories.get(id) ?? new Set<string>();
    this.seenDirectories.set(id, seen);
    const ws = this.workspaceFolder(project);
    const known = new Set([
      ...(this.deps.store.runtime(id).worktrees ?? []).map((w) => w.path),
      ...this.deps.store.environments(id).map((e) => e.worktree.path),
    ]);
    const fresh = directories.filter(
      (d) => d !== ws && !known.has(d) && !seen.has(d)
    );
    if (fresh.length === 0) {
      return;
    }
    for (const d of fresh) {
      seen.add(d);
    }
    void this.refreshWorktreesQuietly(project);
  }

  private exclusive(
    id: ProjectId,
    fn: (project: Project) => Promise<void>
  ): Promise<void> {
    const project = this.deps.store.project(id);
    if (!project) {
      throw new NotFoundError(id);
    }
    return this.exclusiveEnv(this.mainEnv(project), () => fn(project));
  }

  /** Route, relay, ports and opencode health of a running container found at startup. */
  private async adoptRunning(env: Env, info: ContainerInfo): Promise<void> {
    const { store } = this.deps;
    const { runtime } = this.kit(env);
    let route: Route | undefined;
    if (info.ip) {
      try {
        route = await this.openRoute(env, {
          id: info.id,
          ip: info.ip,
          network: info.network,
        });
      } catch (error) {
        this.fail(env, error);
        return;
      }
      const target = await this.startRelay(env, info.ip, route);
      await this.forwardPorts(env, target);
      await this.prepareCredentials(env, target);
    }
    if (!env.worktree) {
      await this.refreshWorktreesQuietly(env.project);
    }
    const rt = store.runtime(env.id);
    if (
      route &&
      rt.password &&
      (await runtime.isHealthy(runtime.endpoint(route.opencode, rt.password)))
    ) {
      store.updateRuntime(env.id, { error: undefined, opencode: "healthy" });
      this.startMonitor(env);
    } else {
      store.updateRuntime(env.id, {
        error: "opencode is not running — use Restart opencode",
        opencode: "unhealthy",
      });
    }
  }

  /** The container went away outside opendevhub: drop what pointed at it. */
  private async markStopped(env: Env): Promise<void> {
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    await this.closeRoute(env.id);
    this.deps.store.updateRuntime(env.id, {
      containerIp: undefined,
      containerState: "stopped",
      opencode: "absent",
    });
    this.deps.store.setSessions(env.id, []);
  }

  private async stopContainer(env: Env): Promise<void> {
    const { store } = this.deps;
    const { runtime, relay, containers } = this.kit(env);
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    const rt = store.runtime(env.id);
    store.updateRuntime(env.id, {
      containerState: "stopping",
      error: undefined,
    });
    try {
      if (rt.containerState === "running") {
        await runtime.stopServer(env.target).catch(() => undefined);
        await relay.stop(env.target).catch(() => undefined);
      }
      if (rt.containerId) {
        await containers.stop(rt.containerId);
      }
      await this.closeRoute(env.id);
      store.updateRuntime(env.id, {
        containerIp: undefined,
        containerState: "stopped",
        opencode: "absent",
      });
      store.setSessions(env.id, []);
    } catch (error) {
      this.fail(env, error);
    }
  }

  private async relaunchOpencode(env: Env): Promise<void> {
    const rt = this.deps.store.runtime(env.id);
    const route = this.routes.get(env.id);
    if (rt.containerState !== "running" || !rt.containerIp || !route) {
      this.fail(
        env,
        new Error("container is not running — start the project first")
      );
      return;
    }
    this.stopMonitor(env.id);
    this.deps.store.updateRuntime(env.id, {
      error: undefined,
      opencode: "starting",
    });
    try {
      const relayWasActive = rt.relay === "active";
      const target = await this.startRelay(env, rt.containerIp, route);
      if (target.relay && !relayWasActive) {
        await this.forwardPorts(env, target);
        await this.prepareCredentials(env, target);
      }
      await this.launchOpencode(env, undefined);
    } catch (error) {
      this.fail(env, error);
    }
  }

  private async adoptTask(info: ContainerInfo): Promise<void> {
    const { store } = this.deps;
    const rec = info.envId ? store.environment(info.envId) : undefined;
    const project = rec && store.project(rec.projectId);
    if (!rec || !project) {
      const owner = info.envProjectId
        ? store.project(info.envProjectId)
        : undefined;
      if (owner) {
        this.log(
          owner.id,
          `environment: ignoring container ${info.name ?? info.id}: opendevhub has no record of ${info.envId}`
        );
      }
      return;
    }
    const env = this.taskEnv(project, rec);
    if (!info.running) {
      store.updateRuntime(env.id, {
        containerId: info.id,
        containerState: "stopped",
        opencode: "absent",
      });
      return;
    }
    store.updateRuntime(env.id, {
      containerId: info.id,
      containerIp: info.ip,
      containerName: info.name,
      containerState: "running",
    });
    await this.adoptRunning(env, info);
  }

  /**
   * Records a worktree's own environment (or returns the one it has), for the variant `setup` when one asked for it.
   * A worktree without a row yet is recorded as unmanaged.
   */
  private recordTaskEnv(
    project: Project,
    worktree: EnvWorktree,
    node: NodeId = LOCAL_NODE,
    setup?: { task: string; variant: number }
  ): TaskEnv {
    const { store } = this.deps;
    const existing = store
      .environments(project.id)
      .find(
        (e) =>
          e.worktree.path === worktree.path && (e.node ?? LOCAL_NODE) === node
      );
    if (existing) {
      return this.taskEnv(project, existing);
    }
    // A remote worktree can sit at the same container path as a local one; its id must not.
    const key =
      node === LOCAL_NODE ? worktree.path : `${node}:${worktree.path}`;
    const remote = node === LOCAL_NODE ? undefined : node;
    const { checkouts } = this.deps;
    const row =
      checkouts
        .worktreesOf(project.id)
        .find((w) => w.path === worktree.path && w.node === remote) ??
      checkouts.insertWorktree(
        project.id,
        {
          branchId: checkouts.ensureBranch(
            project.id,
            worktree.branch,
            { by: "unmanaged" },
            USER
          ).id,
          hostPath: worktree.hostPath,
          path: worktree.path,
          ...(remote ? { node: remote } : {}),
        },
        { by: "unmanaged" },
        USER
      );
    const rec: EnvRecord = {
      id: envIdFor(project.id, key, worktree.branch),
      projectId: project.id,
      worktree,
      worktreeId: row.id,
      ...(remote ? { node: remote } : {}),
    };
    store.putEnvironment(
      rec,
      setup ? variantActor(setup.task, setup.variant) : USER,
      setup?.task
    );
    return this.taskEnv(project, rec);
  }

  /** Moves the starting variant an environment is set up for to its next step. */
  private setupStep(env: Env, step: "image" | "container"): void {
    const setup = this.setups.get(env.id);
    if (setup) {
      this.deps.tasks.updateVariant(
        setup.task,
        setup.variant,
        { step },
        variantActor(setup.task, setup.variant)
      );
    }
  }

  /**
   * Starts a task container: the base image for the worktree's config, the override config, `up`, then
   * route, relay, ports and opencode as for the main container. Records the error and rethrows it.
   */
  private async bringUpTask(
    env: TaskEnv,
    rebuild = false,
    noCache = false
  ): Promise<void> {
    const { store } = this.deps;
    const kit = this.kit(env);
    const { containers } = kit;
    store.updateRuntime(env.id, {
      containerState: "starting",
      error: undefined,
      opencode: "absent",
    });
    try {
      if (
        env.node === LOCAL_NODE &&
        store.runtime(env.project.id).containerState !== "running"
      ) {
        throw new UnavailableError(
          "start the project first: task containers are prepared from its container"
        );
      }
      const { images } = kit;
      if (!images) {
        throw new UnavailableError(
          "task environments are not available in this build"
        );
      }
      this.setupStep(env, "image");
      const image = await images.ensureBase(
        env.project,
        env.worktree,
        this.settingsOf(env.project).keyFiles,
        (l) => this.envLog(env, l),
        noCache
      );
      const read = await containers.readConfig(env.worktree.hostPath);
      const blocker = isolationBlocker(
        read.configuration,
        read.workspaceFolder
      );
      if (blocker) {
        throw new UnavailableError(blocker);
      }
      const { config, notes } = buildOverrideConfig({
        config: read.configuration,
        gitDir: this.gitDirOf(env),
        guessedFolder: read.workspaceFolder,
        image: image.ref,
        worktree: env.worktree,
      });
      for (const note of notes) {
        this.envLog(env, `environment: ${note}`);
      }
      await kit.envFiles.write(env.id, config);
      const rec = store.environment(env.id);
      if (rec) {
        store.putEnvironment({ ...rec, image });
      }
      this.setupStep(env, "container");
      const up = await this.upTask(env, rebuild, noCache);
      store.updateRuntime(env.id, { containerId: up.containerId });
      const info = await containers.inspect(up.containerId);
      if (!info?.running) {
        throw new CommandError(
          "container is not running after devcontainer up"
        );
      }
      if (!info.ip) {
        throw new CommandError(
          "container has no bridge network IP (host networking is not supported)"
        );
      }
      store.updateRuntime(env.id, {
        containerId: up.containerId,
        containerIp: info.ip,
        containerName: info.name,
        containerState: "running",
        opencode: "starting",
        remoteUser: up.remoteUser,
        workspaceFolder: up.remoteWorkspaceFolder,
      });
      const route = await this.openRoute(env, {
        id: up.containerId,
        ip: info.ip,
        network: info.network,
      });
      const target = await this.startRelay(env, info.ip, route);
      await this.forwardPorts(env, target);
      await this.prepareCredentials(env, target);
      await this.launchOpencode(
        env,
        rebuild ? undefined : store.runtime(env.id).password
      );
    } catch (error) {
      this.fail(env, error);
      throw error;
    }
  }

  private upTask(
    env: TaskEnv,
    rebuild: boolean,
    noCache: boolean
  ): ReturnType<ContainersPort["up"]> {
    const { containers } = this.kit(env);
    const next = (this.taskUps.get(env.node) ?? Promise.resolve()).then(
      async () =>
        containers.up(env.target, {
          mounts: await this.opencodeMounts(env),
          noCache,
          onLine: (l) => this.envLog(env, l),
          rebuild,
        })
    );
    this.taskUps.set(
      env.node,
      next.catch(() => undefined)
    );
    return next;
  }

  /** Deletes a task container, its generated config and the UID image the CLI built for it. Throws when the container stays. */
  private async destroyEnv(env: TaskEnv): Promise<void> {
    const { store } = this.deps;
    const kit = this.kit(env);
    const { containers } = kit;
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    await this.closeRoute(env.id);
    const { containerId } = store.runtime(env.id);
    if (containerId) {
      const result6 = await containers
        .inspect(containerId)
        .catch(() => undefined);
      const image = result6?.image;
      await containers.remove(containerId);
      if (image && /^vsc-.+-uid$/u.test(image.split(":")[0])) {
        await containers.removeImage(image);
      }
    }
    // Its sessions go with the worktree; the volume is in no other container's use.
    await containers.removeVolume(opencodeVolume(env.id)).catch(() => false);
    await kit.envFiles.remove(env.id).catch(() => undefined);
    if (env.node !== LOCAL_NODE) {
      // The worktree and branch exist only for this environment; a branch brought home stays on this machine.
      const repo = repoOf(kit);
      await repo.removeWorktree(
        repo.layout(env.project, this.workspaceFolder(env.project)),
        env.worktree
      );
      this.deps.checkouts.removeWorktree(
        env.project.id,
        env.worktree.path,
        env.node,
        USER
      );
      this.deps.checkouts.deleteBranch(
        env.project.id,
        env.worktree.branch,
        USER
      );
    }
    store.removeEnvironment(env.id, USER);
    this.envLog(env, "environment: removed");
  }

  private async bringUp(
    project: Project,
    rebuild: boolean,
    noCache = false
  ): Promise<void> {
    const { store, containers } = this.deps;
    const env = this.mainEnv(project);
    store.updateRuntime(env.id, {
      containerState: "starting",
      error: undefined,
      opencode: "absent",
    });
    try {
      const mounts = [
        ...(await this.worktreeMounts(project)),
        ...(await this.opencodeMounts(env)),
      ];
      const up = await containers.up(project, {
        mounts,
        noCache,
        onLine: (l) => this.log(project.id, l),
        rebuild,
      });
      // Record the container id as soon as `up` succeeds, before the running/IP checks below can
      // throw — otherwise a container that came up but failed those checks has no containerId on
      // record, and Stop has nothing to stop.
      store.updateRuntime(env.id, { containerId: up.containerId });
      const info = await containers.inspect(up.containerId);
      if (!info?.running) {
        throw new CommandError(
          "container is not running after devcontainer up"
        );
      }
      if (!info.ip) {
        throw new CommandError(
          "container has no bridge network IP (host networking is not supported)"
        );
      }
      store.updateRuntime(env.id, {
        containerId: up.containerId,
        containerIp: info.ip,
        containerName: info.name,
        containerState: "running",
        opencode: "starting",
        remoteUser: up.remoteUser,
        workspaceFolder: up.remoteWorkspaceFolder,
        worktreeRoot: this.detectWorktreeRoot(
          project,
          up.remoteWorkspaceFolder,
          info
        ),
      });
      const route = await this.openRoute(env, {
        id: up.containerId,
        ip: info.ip,
        network: info.network,
      });
      const target = await this.startRelay(env, info.ip, route);
      await this.forwardPorts(env, target);
      await this.prepareCredentials(env, target);
      await this.refreshWorktreesQuietly(project);
      await this.launchOpencode(
        env,
        rebuild ? undefined : store.runtime(env.id).password
      );
    } catch (error) {
      this.fail(env, error);
    }
  }

  private async launchOpencode(
    env: Env,
    password: string | undefined
  ): Promise<void> {
    const { store } = this.deps;
    const { runtime } = this.kit(env);
    const route = this.routes.get(env.id);
    if (!route) {
      throw new Error("container is not running — start the project first");
    }
    const result = await runtime.ensureRunning(env.target, {
      address: route.opencode,
      containerId: store.runtime(env.id).containerId,
      onLine: (l) => this.envLog(env, l),
      password,
      workspaceFolder: this.envDirectory(env),
      ...(this.sshAgentOf(env) ? { env: { SSH_AUTH_SOCK: AGENT_SOCKET } } : {}),
    });
    store.updateRuntime(env.id, {
      error: undefined,
      opencode: "healthy",
      opencodeVersion: result.version,
      password: result.password,
    });
    this.startMonitor(env);
  }

  private mainEnv(project: Project): Env {
    return { id: project.id, node: LOCAL_NODE, project, target: project };
  }

  private envOf(id: EnvId): Env | undefined {
    const { store } = this.deps;
    const project = store.project(id);
    if (project) {
      return this.mainEnv(project);
    }
    const rec = store.environment(id);
    const owner = rec && store.project(rec.projectId);
    return rec && owner ? this.taskEnv(owner, rec) : undefined;
  }

  private allEnvs(): Env[] {
    return this.deps.store
      .projects()
      .flatMap((p) => [
        this.mainEnv(p),
        ...this.deps.store.environments(p.id).map((r) => this.taskEnv(p, r)),
      ]);
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
    return (this.deps.store.runtime(projectId).worktrees ?? []).map(
      (w) => w.path
    );
  }

  private envFiles(): EnvFilesPort {
    return (
      this.deps.envFiles ??
      (this.defaultEnvFiles ??= new EnvFiles(path.join(stateDir(), "envs")))
    );
  }

  private kitOf(node: NodeId): Kit | undefined {
    if (node !== LOCAL_NODE) {
      return this.deps.nodes?.kit(node);
    }
    const d = this.deps;
    return {
      containers: d.containers,
      credentials: d.credentials,
      envFiles: this.envFiles(),
      git: d.git,
      images: d.images,
      network: d.network ?? DIRECT,
      relay: d.relay,
      runtime: d.runtime,
    };
  }

  /** The project's .git as a task container mounts it: from this machine, or from the node's repository. */
  private gitDirOf(env: TaskEnv): { host: string; container: string } {
    const ws = this.workspaceFolder(env.project);
    const container = path.posix.join(ws, ".git");
    if (env.node === LOCAL_NODE) {
      return { container, host: path.join(env.project.path, ".git") };
    }
    return {
      container,
      host: repoOf(this.kit(env)).layout(env.project, ws).gitDir,
    };
  }

  private requireTaskEnv(projectId: ProjectId, envId: EnvId): TaskEnv {
    const project = this.requireProject(projectId);
    const rec = this.deps.store.environment(envId);
    if (!rec || rec.projectId !== projectId) {
      throw new NotFoundError(envId, "environment");
    }
    return this.taskEnv(project, rec);
  }

  /** Whether to forward the ssh-agent into this environment: its own configuration first, then the project's settings. */
  private sshAgentOf(env: Env): boolean {
    return this.sshAgents.get(env.id) ?? this.settingsOf(env.project).sshAgent;
  }

  private settingsOf(project: Project): EnvSettings {
    return (
      this.settings.get(project.id) ??
      resolveEnvSettings(undefined, this.deps.projectSettings?.(project))
    );
  }

  /** Reads the project's isolation settings from its devcontainer.json (as read for ports) and config.json. */
  private noteSettings(
    project: Project,
    configuration: Record<string, unknown> | undefined
  ): void {
    const custom = (
      configuration?.customizations as Record<string, unknown> | undefined
    )?.opendevhub;
    const settings = resolveEnvSettings(
      custom,
      this.deps.projectSettings?.(project)
    );
    this.settings.set(project.id, settings);
    const unsupported = configuration
      ? isolationBlocker(configuration)
      : undefined;
    this.deps.store.setIsolation(
      project.id,
      unsupported
        ? { default: "shared", unsupported }
        : { default: settings.isolation }
    );
  }

  /** The project's log; a task environment's lines start with its branch. */
  private envLog(env: Env, raw: string): void {
    const line = cleanLogLine(raw);
    if (!line) {
      return;
    }
    const setup = this.setups.get(env.id);
    if (setup) {
      this.deps.store.appendStartingLog(setup.task, setup.variant, line);
    }
    this.log(
      env.project.id,
      env.worktree ? `[${env.worktree.branch}] ${line}` : line
    );
  }

  /** One lifecycle action per environment at a time; throws BusyError synchronously otherwise. */
  private exclusiveEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(env.id)) {
      throw new BusyError(env.id);
    }
    this.busy.add(env.id);
    return fn().finally(() => this.busy.delete(env.id));
  }

  private async forwardPorts(env: Env, target: ForwardTarget): Promise<void> {
    const { store, forwarder } = this.deps;
    const { containers } = this.kit(env);
    let config: PortConfig;
    try {
      config = await containers.readConfiguration(env.target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.envLog(
        env,
        `ports: could not read devcontainer configuration: ${message}`
      );
      store.updateRuntime(env.id, { ports: [] });
      if (!env.worktree) {
        this.noteSettings(env.project, undefined);
      }
      this.sshAgents.delete(env.id);
      return;
    }
    if (!env.worktree) {
      this.noteSettings(env.project, config.configuration);
    }
    const custom = (
      config.configuration?.customizations as
        | Record<string, unknown>
        | undefined
    )?.opendevhub;
    this.sshAgents.set(
      env.id,
      resolveEnvSettings(custom, this.deps.projectSettings?.(env.project))
        .sshAgent
    );
    const { ports, skipped } = parseForwardPorts(
      config.forwardPorts,
      config.portsAttributes
    );
    for (const s of skipped) {
      this.envLog(env, `ports: skipped ${s.entry} (${s.reason})`);
    }
    const opened = await forwarder.open(
      env.id,
      target,
      ports,
      (line) => this.envLog(env, line),
      {
        onRelayUnreachable: () => void this.recoverRelay(env.id),
      }
    );
    for (const f of opened) {
      if (f.status === "forwarded") {
        this.envLog(env, `ports: ${f.containerPort} → localhost:${f.hostPort}`);
      } else if (f.status === "failed") {
        this.envLog(
          env,
          `ports: ${f.containerPort} not forwarded (${f.reason})`
        );
      }
    }
    const skippedPorts: ForwardedPort[] = skipped.map((s) => ({
      entry: s.entry,
      reason: s.reason,
      status: "skipped",
    }));
    store.updateRuntime(env.id, { ports: [...opened, ...skippedPorts] });
  }

  private async openRoute(env: Env, container: RouteContainer): Promise<Route> {
    await this.closeRoute(env.id);
    const route = await this.kit(env).network.route(container, (line) =>
      this.envLog(env, line)
    );
    this.routes.set(env.id, route);
    return route;
  }

  private async closeRoute(id: EnvId): Promise<void> {
    const route = this.routes.get(id);
    this.routes.delete(id);
    await route?.close();
  }

  private async startRelay(
    env: Env,
    ip: string,
    route: Route
  ): Promise<ForwardTarget> {
    const { store } = this.deps;
    const { runtime, relay } = this.kit(env);
    let token = store.runtime(env.id).relayToken;
    if (!token) {
      token = generateRelayToken();
      store.updateRuntime(env.id, { relayToken: token });
    }
    const binary = await runtime
      .resolveBinary(env.target)
      .catch(() => undefined);
    const result = await relay.ensureRunning(env.target, {
      address: route.relay,
      binary,
      token,
    });
    const direct: ForwardTarget = route.dial
      ? { dial: route.dial, host: ip }
      : { host: ip };
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
  private async prepareCredentials(
    env: Env,
    target: ForwardTarget
  ): Promise<void> {
    const { store } = this.deps;
    const { credentials } = this.kit(env);
    const sshAgent = this.sshAgentOf(env);
    if (credentials) {
      try {
        await credentials.prepare(env.target, env.project.path, {
          onLine: (l) => this.envLog(env, l),
          sshAgent,
        });
      } catch (error) {
        this.envLog(
          env,
          `credentials: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.stopTunnel(env.id);
    if (!sshAgent) {
      store.updateRuntime(env.id, {
        sshAgent: "off",
        sshAgentReason: undefined,
      });
      return;
    }
    if (!target.relay) {
      store.updateRuntime(env.id, {
        sshAgent: "unavailable",
        sshAgentReason: "relay not running",
      });
      this.envLog(env, "ssh-agent: unavailable (relay not running)");
      return;
    }
    const relayTarget: RelayTarget = {
      host: target.relay.host ?? target.host,
      port: target.relay.port,
      token: target.relay.token,
    };
    const factory: AgentTunnelFactory =
      this.deps.agentTunnel ?? ((t, o) => new AgentTunnel(t, o));
    const tunnel = factory(relayTarget, {
      onLog: (l) => this.envLog(env, l),
      onRelayLost: () => void this.recoverRelay(env.id),
      onStatus: (s) =>
        store.updateRuntime(env.id, {
          sshAgent: s.state,
          sshAgentReason: s.reason,
        }),
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
    if (
      now - (this.relayRecoveries.get(id) ?? -Infinity) <
      RELAY_RECOVERY_INTERVAL_MS
    ) {
      return;
    }
    this.relayRecoveries.set(id, now);
    const { store } = this.deps;
    const env = this.envOf(id);
    const rt = store.runtime(id);
    const route = this.routes.get(id);
    if (
      !env ||
      this.busy.has(id) ||
      rt.containerState !== "running" ||
      !rt.containerIp ||
      !route
    ) {
      return;
    }
    store.updateRuntime(id, { relay: "unavailable" });
    this.envLog(env, "relay: unreachable, relaunching");
    await this.startRelay(env, rt.containerIp, route).catch(() => undefined);
  }

  private async closePorts(id: EnvId): Promise<void> {
    this.stopTunnel(id);
    this.sshAgents.delete(id);
    await this.deps.forwarder.close(id);
    this.deps.store.updateRuntime(id, {
      ports: undefined,
      relay: undefined,
      sshAgent: undefined,
      sshAgentReason: undefined,
    });
  }

  private startMonitor(env: Env): void {
    this.stopMonitor(env.id);
    const { store, runtime, clientFor } = this.deps;
    const rt = store.runtime(env.id);
    const route = this.routes.get(env.id);
    if (!route || !rt.password) {
      throw new UnavailableError(`environment ${env.id} has no opencode route`);
    }
    const factory =
      this.deps.monitorFactory ?? ((opts: MonitorOptions) => new Monitor(opts));
    const client = clientFor(runtime.endpoint(route.opencode, rt.password));
    const monitor = factory({
      client,
      projectId: env.project.id,
      envId: env.id,
      directory: this.envDirectory(env),
      ...(env.worktree
        ? {}
        : { extraDirectories: () => this.sharedWorktrees(env.project.id) }),
      onSessions: (sessions) => {
        store.setSessions(env.id, sessions);
        this.noticeDirectories(env.project.id, [
          ...new Set(sessions.map((s) => s.directory)),
        ]);
      },
      onRawSessions: (sessions) => {
        // Before usage, which attributes spend to the tasks reconcile may adopt sessions into.
        void reconcileTasks(this.deps.tasks, {
          branchOf: (directory) =>
            env.worktree?.branch ??
            (directory === this.envDirectory(env)
              ? undefined
              : this.deps.store
                  .runtime(env.project.id)
                  .worktrees?.find((w) => w.path === directory)?.branch),
          envId: env.id,
          lookup: (id) =>
            client.session(id).then(
              (s): Presence =>
                s.time.archived === undefined ? "alive" : "gone",
              (error: unknown): Presence => (isGone(error) ? "gone" : "unknown")
            ),
          projectId: env.project.id,
          sessions,
        }).catch((error: unknown) =>
          this.log(
            env.project.id,
            `tasks: could not reconcile sessions: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        this.deps.recordUsage?.(env.project.id, sessions);
      },
      onHealth: (healthy) => {
        if (store.runtime(env.id).opencode === "starting") {
          return;
        }
        store.updateRuntime(env.id, {
          opencode: healthy ? "healthy" : "unhealthy",
        });
      },
    });
    this.monitors.set(env.id, monitor);
    monitor.start();
  }

  private stopMonitor(id: EnvId): void {
    for (const fn of this.unwatchListeners) {
      fn(id);
    }
    this.monitors.get(id)?.stop();
    this.monitors.delete(id);
  }

  private fail(env: Env, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CommandError) {
      for (const line of err.tail) {
        this.envLog(env, line);
      }
    }
    this.envLog(env, `error: ${message}`);
    const containerUp =
      this.deps.store.runtime(env.id).containerState === "running";
    this.deps.store.updateRuntime(env.id, {
      containerState: containerUp ? "running" : "error",
      error: message,
      opencode: containerUp ? "unhealthy" : "absent",
    });
  }
}
