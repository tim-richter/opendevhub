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
  TaskView,
  UsageTotals,
  Worktree,
} from "../../shared/types";
import { projectUrl } from "../../shared/urls";
import type { PersistedEnv, PersistedRuntime, PersistedState } from "../config";
import { creatorView } from "../db/checkouts";
import type { CheckoutStore } from "../db/checkouts";
import type { TaskRecord, TaskStore } from "../db/tasks";
import type { RunningContainer } from "../environments/resources";
import { compareSessions } from "../sessions/status";

export interface StoreOptions {
  port: number;
  /** Where tasks live; the snapshot lists them and sessions show theirs. */
  tasks: TaskStore;
  /** Who made each worktree, and its branch row; worktrees are listed without them when absent. */
  checkouts?: CheckoutStore;
  persisted: PersistedState;
  persist: (state: PersistedState) => void;
}

const DURABLE_KEYS = [
  "containerId",
  "password",
  "workspaceFolder",
  "relayToken",
  "remoteUser",
] as const;

/** A task environment opendevhub created: its worktree, and the image it was last started from. */
export interface EnvRecord {
  id: EnvId;
  projectId: ProjectId;
  worktree: EnvWorktree;
  image?: { key: string; ref: string };
  /** Absent for this machine. */
  node?: NodeId;
}

const durable = (r: ProjectRuntime): PersistedRuntime => ({
  containerId: r.containerId,
  password: r.password,
  relayToken: r.relayToken,
  workspaceFolder: r.workspaceFolder,
  ...(r.remoteUser ? { remoteUser: r.remoteUser } : {}),
});

const publicRuntime = (r: ProjectRuntime): PublicRuntime => {
  const { password: _password, relayToken: _relayToken, ...rest } = r;
  return rest;
};

const defaultRuntime = (projectId: ProjectId): ProjectRuntime => ({
  containerState: "stopped",
  opencode: "absent",
  projectId,
});

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
  /** The last lines each starting variant's setup wrote, by `<task>/<n>`. Not worth keeping across restarts. */
  private setupLogs = new Map<string, string[]>();

  private readonly opts: StoreOptions;
  constructor(opts: StoreOptions) {
    this.opts = opts;
    opts.tasks.subscribe(() => this.emit());
    opts.checkouts?.subscribe(() => this.emit());
    for (const [id, saved] of Object.entries(opts.persisted.projects)) {
      this.runtimes.set(id, { ...defaultRuntime(id), ...saved });
    }
    for (const [id, saved] of Object.entries(
      opts.persisted.environments ?? {}
    )) {
      if (!saved?.worktree?.path || !saved.projectId) {
        continue;
      }
      const { projectId, worktree, image, node, ...runtime } = saved;
      this.envs.set(id, {
        id,
        projectId,
        worktree,
        ...(image ? { image } : {}),
        ...(node ? { node } : {}),
      });
      this.runtimes.set(id, { ...defaultRuntime(projectId), ...runtime });
    }
  }

  setProjects(list: Project[]): void {
    this.projectsById = new Map(list.map((p) => [p.id, p]));
    for (const p of list) {
      if (!this.runtimes.has(p.id)) {
        this.runtimes.set(p.id, defaultRuntime(p.id));
      }
    }
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
    const changed = (Object.keys(patch) as (keyof ProjectRuntime)[]).filter(
      (k) => current[k] !== patch[k]
    );
    if (changed.length === 0) {
      return;
    }
    this.runtimes.set(id, { ...current, ...patch });
    if (changed.some((k) => (DURABLE_KEYS as readonly string[]).includes(k))) {
      this.save();
    }
    this.emit();
  }

  setSessions(id: ProjectId, list: SessionSummary[]): void {
    const current = this.sessions.get(id) ?? [];
    if (JSON.stringify(current) === JSON.stringify(list)) {
      return;
    }
    this.sessions.set(id, list);
    this.emit();
  }

  /** Keeps the last 30 lines of a starting variant's setup. */
  appendStartingLog(task: string, variant: number, line: string): void {
    const key = `${task}/${variant}`;
    this.setupLogs.set(
      key,
      [...(this.setupLogs.get(key) ?? []), line].slice(-30)
    );
    this.emit();
  }

  /** The id of the task a session belongs to. */
  readonly taskOf = (sessionId: string): string | undefined =>
    this.opts.tasks.sessionRef(sessionId)?.id;

  /** The project's tasks that are not archived, as the snapshot lists them. */
  tasksOf(id: ProjectId): TaskView[] {
    return this.opts.tasks.listForProject(id).map((t) => this.taskView(t));
  }

  private taskView(t: TaskRecord): TaskView {
    const {
      projectId: _projectId,
      prompt: _prompt,
      archivedAt: _archivedAt,
      ...view
    } = t;
    return {
      ...view,
      variants: view.variants.map((v) => {
        const log =
          v.step === "session"
            ? undefined
            : this.setupLogs.get(`${t.id}/${v.n}`);
        return log ? { ...v, log } : v;
      }),
    };
  }

  /** Sessions as listed, with their task; discarded variants are hidden, the way archiving would. */
  private withTasks(list: SessionSummary[]): SessionSummary[] {
    return list.flatMap((s) => {
      const task = this.opts.tasks.sessionRef(s.id);
      if (task?.discarded) {
        return [];
      }
      return [task ? { ...s, task } : s];
    });
  }

  /** The project's sessions across its main and task environments. */
  sessionsOf(id: ProjectId): SessionSummary[] {
    const main = this.sessions.get(id) ?? [];
    const envs = this.environments(id);
    if (envs.length === 0) {
      return this.withTasks(main);
    }
    return this.withTasks(
      [...main, ...envs.flatMap((e) => this.sessions.get(e.id) ?? [])].toSorted(
        compareSessions
      )
    );
  }

  environments(projectId: ProjectId): EnvRecord[] {
    return [...this.envs.values()].filter((e) => e.projectId === projectId);
  }

  environment(id: EnvId): EnvRecord | undefined {
    return this.envs.get(id);
  }

  putEnvironment(rec: EnvRecord): void {
    this.envs.set(rec.id, rec);
    if (!this.runtimes.has(rec.id)) {
      this.runtimes.set(rec.id, defaultRuntime(rec.projectId));
    }
    this.save();
    this.emit();
  }

  removeEnvironment(id: EnvId): void {
    if (!this.envs.delete(id)) {
      return;
    }
    this.runtimes.delete(id);
    this.sessions.delete(id);
    delete this.resourceStats[id];
    this.save();
    this.emit();
  }

  setIsolation(projectId: ProjectId, info: IsolationInfo): void {
    if (
      JSON.stringify(this.isolationInfo.get(projectId)) === JSON.stringify(info)
    ) {
      return;
    }
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
    if (JSON.stringify(this.usageTotals) === JSON.stringify(totals)) {
      return;
    }
    this.usageTotals = totals;
    this.emit();
  }

  setResources(stats: Record<EnvId, ResourceStats>): void {
    if (JSON.stringify(this.resourceStats) === JSON.stringify(stats)) {
      return;
    }
    this.resourceStats = stats;
    this.emit();
  }

  setNodes(views: NodeView[]): void {
    if (JSON.stringify(this.nodeViews) === JSON.stringify(views)) {
      return;
    }
    this.nodeViews = views;
    this.emit();
  }

  /** The containers of running environments, main and task, for the resource sampler. */
  runningContainers(): RunningContainer[] {
    return [...this.projectsById.keys(), ...this.envs.keys()].flatMap(
      (envId) => {
        const r = this.runtimes.get(envId);
        return r?.containerState === "running" && r.containerId
          ? [{ containerId: r.containerId, envId }]
          : [];
      }
    );
  }

  preflight(): Preflight {
    return this.preflightState;
  }

  snapshot(): DashboardSnapshot {
    return {
      editors: this.editorList,
      preflight: this.preflightState,
      projects: this.projects().map((project) => {
        const isolation = this.isolationInfo.get(project.id);
        const envs = this.environments(project.id);
        const remote: Worktree[] = envs.flatMap((e) =>
          e.node
            ? [
                {
                  branch: e.worktree.branch,
                  node: e.node,
                  path: e.worktree.path,
                },
              ]
            : []
        );
        const runtime = publicRuntime(this.runtime(project.id));
        return {
          environments: envs.map((e) => ({
            id: e.id,
            worktree: e.worktree,
            ...(e.node ? { node: e.node } : {}),
            ...(e.image ? { image: e.image } : {}),
            runtime: publicRuntime(this.runtime(e.id)),
            openUrl: projectUrl(e.id, this.opts.port),
          })),
          openUrl: projectUrl(project.id, this.opts.port),
          project,
          runtime:
            remote.length > 0 || runtime.worktrees
              ? {
                  ...runtime,
                  worktrees: this.withCreators(project.id, [
                    ...(runtime.worktrees ?? []),
                    ...remote,
                  ]),
                }
              : runtime,
          sessions: this.sessionsOf(project.id),
          tasks: this.tasksOf(project.id),
          ...(isolation ? { isolation } : {}),
        };
      }),
      roots: this.roots,
      ...(this.usageTotals ? { usage: this.usageTotals } : {}),
      ...(Object.keys(this.resourceStats).length > 0
        ? { resources: this.resourceStats }
        : {}),
      ...(this.nodeViews.length > 0 ? { nodes: this.nodeViews } : {}),
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Worktrees with their branch row, who made them, and what their branch was made for. */
  private withCreators(projectId: ProjectId, list: Worktree[]): Worktree[] {
    const { checkouts } = this.opts;
    if (!checkouts) {
      return list;
    }
    const rows = checkouts.worktreesOf(projectId);
    const branches = new Map(
      checkouts.branchesOf(projectId).map((b) => [b.id, b])
    );
    return list.map((w) => {
      const row = rows.find(
        (r) => r.path === w.path && (r.node ?? "") === (w.node ?? "")
      );
      if (!row) {
        return w;
      }
      const branch =
        row.branchId === undefined ? undefined : branches.get(row.branchId);
      const { by } = row.createdBy;
      const createdBy = creatorView(row.createdBy, {
        ...(by === "variant"
          ? { title: this.opts.tasks.get(row.createdBy.task)?.title }
          : {}),
        ...(branch?.originUrl ? { url: branch.originUrl } : {}),
      });
      return {
        ...w,
        createdBy,
        ...(row.branchId === undefined ? {} : { branchId: row.branchId }),
        ...(branch?.originUrl ? { origin: branch.originUrl } : {}),
      };
    });
  }

  private save(): void {
    const projects: Record<ProjectId, PersistedRuntime> = {};
    const environments: Record<EnvId, PersistedEnv> = {};
    for (const [id, r] of this.runtimes) {
      if (this.envs.has(id)) {
        continue;
      }
      if (r.containerId || r.password || r.workspaceFolder || r.relayToken) {
        projects[id] = durable(r);
      }
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
    this.opts.persist(
      Object.keys(environments).length > 0
        ? { environments, projects }
        : { projects }
    );
  }

  private emit(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }
}
