import type {
  DashboardSnapshot,
  EditorInfo,
  EnvId,
  EnvWorktree,
  IsolationInfo,
  NodeId,
  NodeView,
  Preflight,
  Project,
  ProjectId,
  ProjectRuntime,
  PublicRuntime,
  ResourceStats,
  SessionSummary,
  StartingTask,
  StartingVariant,
  UsageTotals,
  Worktree,
} from "../shared/types";
import { projectUrl } from "../shared/urls";
import type { PersistedEnv, PersistedRuntime, PersistedState } from "./config";
import type { RunningContainer } from "./resources";
import { compareSessions } from "./status";

export interface StoreOptions {
  port: number;
  persisted: PersistedState;
  persist: (state: PersistedState) => void;
}

const DURABLE_KEYS = ["containerId", "password", "workspaceFolder", "relayToken", "remoteUser"] as const;

/** A task environment opendevhub created: its worktree, and the image it was last started from. */
export interface EnvRecord {
  id: EnvId;
  projectId: ProjectId;
  worktree: EnvWorktree;
  image?: { key: string; ref: string };
  /** Absent for this machine. */
  node?: NodeId;
}

function durable(r: ProjectRuntime): PersistedRuntime {
  return {
    containerId: r.containerId,
    password: r.password,
    workspaceFolder: r.workspaceFolder,
    relayToken: r.relayToken,
    ...(r.remoteUser ? { remoteUser: r.remoteUser } : {}),
  };
}

function publicRuntime(r: ProjectRuntime): PublicRuntime {
  const { password: _password, relayToken: _relayToken, ...rest } = r;
  return rest;
}

function defaultRuntime(projectId: ProjectId): ProjectRuntime {
  return { projectId, containerState: "stopped", opencode: "absent" };
}

export class StateStore {
  private projectsById = new Map<ProjectId, Project>();
  private runtimes = new Map<ProjectId, ProjectRuntime>();
  private sessions = new Map<ProjectId, SessionSummary[]>();
  private listeners = new Set<() => void>();
  private roots: string[] = [];
  private preflightState: Preflight = { errors: [] };
  private editorList: EditorInfo[] = [];
  private envs = new Map<EnvId, EnvRecord>();
  private isolationInfo = new Map<ProjectId, IsolationInfo>();
  private usageTotals?: UsageTotals;
  private resourceStats: Record<EnvId, ResourceStats> = {};
  private nodeViews: NodeView[] = [];
  private startingTasks = new Map<ProjectId, StartingTask[]>();

  constructor(private readonly opts: StoreOptions) {
    for (const [id, saved] of Object.entries(opts.persisted.projects)) {
      this.runtimes.set(id, { ...defaultRuntime(id), ...saved });
    }
    for (const [id, saved] of Object.entries(opts.persisted.environments ?? {})) {
      if (!saved?.worktree?.path || !saved.projectId) continue;
      const { projectId, worktree, image, node, ...runtime } = saved;
      this.envs.set(id, { id, projectId, worktree, ...(image ? { image } : {}), ...(node ? { node } : {}) });
      this.runtimes.set(id, { ...defaultRuntime(projectId), ...runtime });
    }
  }

  setProjects(list: Project[]): void {
    this.projectsById = new Map(list.map((p) => [p.id, p]));
    for (const p of list) if (!this.runtimes.has(p.id)) this.runtimes.set(p.id, defaultRuntime(p.id));
    this.emit();
  }

  projects(): Project[] {
    return [...this.projectsById.values()];
  }

  project(id: ProjectId): Project | undefined {
    return this.projectsById.get(id);
  }

  runtime(id: ProjectId): ProjectRuntime {
    return this.runtimes.get(id) ?? defaultRuntime(id);
  }

  updateRuntime(id: ProjectId, patch: Partial<ProjectRuntime>): void {
    const current = this.runtime(id);
    const changed = (Object.keys(patch) as (keyof ProjectRuntime)[]).filter((k) => current[k] !== patch[k]);
    if (changed.length === 0) return;
    this.runtimes.set(id, { ...current, ...patch });
    if (changed.some((k) => (DURABLE_KEYS as readonly string[]).includes(k))) this.save();
    this.emit();
  }

  setSessions(id: ProjectId, list: SessionSummary[]): void {
    const current = this.sessions.get(id) ?? [];
    if (JSON.stringify(current) === JSON.stringify(list)) return;
    this.sessions.set(id, list);
    const owner = this.envs.get(id)?.projectId ?? id;
    this.pruneStarting(owner);
    this.emit();
  }

  /** Records a task whose variants are being set up. */
  putStarting(projectId: ProjectId, task: StartingTask): void {
    this.startingTasks.set(projectId, [...(this.startingTasks.get(projectId) ?? []).filter((t) => t.task !== task.task), task]);
    this.emit();
  }

  startingTask(projectId: ProjectId, task: string): StartingTask | undefined {
    return this.startingTasks.get(projectId)?.find((t) => t.task === task);
  }

  updateStarting(projectId: ProjectId, task: string, variant: number, patch: Partial<Omit<StartingVariant, "variant" | "log">>): void {
    const v = this.startingVariant(projectId, task, variant);
    if (!v) return;
    Object.assign(v, patch);
    this.pruneStarting(projectId);
    this.emit();
  }

  /** Keeps the last 30 lines. */
  appendStartingLog(projectId: ProjectId, task: string, variant: number, line: string): void {
    const v = this.startingVariant(projectId, task, variant);
    if (!v) return;
    v.log = [...v.log, line].slice(-30);
    this.emit();
  }

  /** Drops the variants that failed or got their session; false when the task isn't listed. */
  dismissStarting(projectId: ProjectId, task: string): boolean {
    const t = this.startingTask(projectId, task);
    if (!t) return false;
    t.variants = t.variants.filter((v) => v.step !== "failed" && v.step !== "session");
    this.pruneStarting(projectId);
    this.emit();
    return true;
  }

  private startingVariant(projectId: ProjectId, task: string, variant: number): StartingVariant | undefined {
    return this.startingTask(projectId, task)?.variants.find((v) => v.variant === variant);
  }

  /** Variants whose session is listed are running; tasks without variants are done. */
  private pruneStarting(projectId: ProjectId): void {
    const tasks = this.startingTasks.get(projectId);
    if (!tasks) return;
    const listed = new Set(this.sessionsOf(projectId).map((s) => s.id));
    for (const t of tasks) t.variants = t.variants.filter((v) => !v.sessionId || !listed.has(v.sessionId));
    const left = tasks.filter((t) => t.variants.length > 0);
    if (left.length > 0) this.startingTasks.set(projectId, left);
    else this.startingTasks.delete(projectId);
  }

  /** The project's sessions across its main and task environments. */
  sessionsOf(id: ProjectId): SessionSummary[] {
    const main = this.sessions.get(id) ?? [];
    const envs = this.environments(id);
    if (envs.length === 0) return main;
    return [...main, ...envs.flatMap((e) => this.sessions.get(e.id) ?? [])].sort(compareSessions);
  }

  environments(projectId: ProjectId): EnvRecord[] {
    return [...this.envs.values()].filter((e) => e.projectId === projectId);
  }

  environment(id: EnvId): EnvRecord | undefined {
    return this.envs.get(id);
  }

  putEnvironment(rec: EnvRecord): void {
    this.envs.set(rec.id, rec);
    if (!this.runtimes.has(rec.id)) this.runtimes.set(rec.id, defaultRuntime(rec.projectId));
    this.save();
    this.emit();
  }

  removeEnvironment(id: EnvId): void {
    if (!this.envs.delete(id)) return;
    this.runtimes.delete(id);
    this.sessions.delete(id);
    delete this.resourceStats[id];
    this.save();
    this.emit();
  }

  setIsolation(projectId: ProjectId, info: IsolationInfo): void {
    if (JSON.stringify(this.isolationInfo.get(projectId)) === JSON.stringify(info)) return;
    this.isolationInfo.set(projectId, info);
    this.emit();
  }

  isolation(projectId: ProjectId): IsolationInfo | undefined {
    return this.isolationInfo.get(projectId);
  }

  setRoots(roots: string[]): void {
    this.roots = [...roots];
    this.emit();
  }

  setPreflight(preflight: Preflight): void {
    this.preflightState = preflight;
    this.emit();
  }

  setEditors(editors: EditorInfo[]): void {
    this.editorList = editors;
    this.emit();
  }

  setUsage(totals: UsageTotals | undefined): void {
    if (JSON.stringify(this.usageTotals) === JSON.stringify(totals)) return;
    this.usageTotals = totals;
    this.emit();
  }

  setResources(stats: Record<EnvId, ResourceStats>): void {
    if (JSON.stringify(this.resourceStats) === JSON.stringify(stats)) return;
    this.resourceStats = stats;
    this.emit();
  }

  setNodes(views: NodeView[]): void {
    if (JSON.stringify(this.nodeViews) === JSON.stringify(views)) return;
    this.nodeViews = views;
    this.emit();
  }

  /** The containers of running environments, main and task, for the resource sampler. */
  runningContainers(): RunningContainer[] {
    return [...this.projectsById.keys(), ...this.envs.keys()].flatMap((envId) => {
      const r = this.runtimes.get(envId);
      return r?.containerState === "running" && r.containerId ? [{ envId, containerId: r.containerId }] : [];
    });
  }

  preflight(): Preflight {
    return this.preflightState;
  }

  snapshot(): DashboardSnapshot {
    return {
      roots: this.roots,
      preflight: this.preflightState,
      editors: this.editorList,
      projects: this.projects().map((project) => {
        const isolation = this.isolationInfo.get(project.id);
        const envs = this.environments(project.id);
        const remote: Worktree[] = envs.flatMap((e) => (e.node ? [{ path: e.worktree.path, branch: e.worktree.branch, node: e.node }] : []));
        const runtime = publicRuntime(this.runtime(project.id));
        return {
          project,
          runtime: remote.length > 0 ? { ...runtime, worktrees: [...(runtime.worktrees ?? []), ...remote] } : runtime,
          sessions: this.sessionsOf(project.id),
          openUrl: projectUrl(project.id, this.opts.port),
          environments: envs.map((e) => ({
            id: e.id,
            worktree: e.worktree,
            ...(e.node ? { node: e.node } : {}),
            ...(e.image ? { image: e.image } : {}),
            runtime: publicRuntime(this.runtime(e.id)),
            openUrl: projectUrl(e.id, this.opts.port),
          })),
          ...(isolation ? { isolation } : {}),
          ...(this.startingTasks.has(project.id) ? { starting: structuredClone(this.startingTasks.get(project.id)!) } : {}),
        };
      }),
      ...(this.usageTotals ? { usage: this.usageTotals } : {}),
      ...(Object.keys(this.resourceStats).length > 0 ? { resources: this.resourceStats } : {}),
      ...(this.nodeViews.length > 0 ? { nodes: this.nodeViews } : {}),
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(): void {
    const projects: Record<ProjectId, PersistedRuntime> = {};
    const environments: Record<EnvId, PersistedEnv> = {};
    for (const [id, r] of this.runtimes) {
      if (this.envs.has(id)) continue;
      if (r.containerId || r.password || r.workspaceFolder || r.relayToken) projects[id] = durable(r);
    }
    for (const [id, e] of this.envs) {
      environments[id] = {
        projectId: e.projectId,
        worktree: e.worktree,
        ...(e.image ? { image: e.image } : {}),
        ...(e.node ? { node: e.node } : {}),
        ...durable(this.runtime(id)),
      };
    }
    this.opts.persist(Object.keys(environments).length > 0 ? { projects, environments } : { projects });
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
