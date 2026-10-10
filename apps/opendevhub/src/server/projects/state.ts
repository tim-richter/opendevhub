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
import { creatorView } from "../db/checkouts";
import type { CheckoutStore } from "../db/checkouts";
import type { DurablePatch, EnvironmentStore } from "../db/environments";
import type { Actor, EventStore } from "../db/events";
import { SYSTEM } from "../db/events";
import type { LinkStore, TaskLinks } from "../db/links";
import type { TaskRecord, TaskStore } from "../db/tasks";
import type { RunningContainer } from "../environments/resources";
import { compareSessions } from "../sessions/status";

export interface StoreOptions {
  port: number;
  /** Where tasks live; the snapshot lists them and sessions show theirs. */
  tasks: TaskStore;
  /** Who made each worktree, and its branch row; worktrees are listed without them when absent. */
  checkouts?: CheckoutStore;
  /** Each task's ticket and pull requests; tasks are listed without them when absent. */
  links?: LinkStore;
  /** Where environments and their durable runtime fields live; read once at start. */
  environments: EnvironmentStore;
  /** The event log; the snapshot carries its newest id so the activity views know to refetch. */
  events?: Pick<EventStore, "latestId">;
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
  /** The worktree row it runs on. */
  worktreeId: number;
  worktree: EnvWorktree;
  image?: { key: string; ref: string };
  /** Absent for this machine. */
  node?: NodeId;
}

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
    opts.links?.subscribe(() => this.emit());
    for (const row of opts.environments.listLive()) {
      this.runtimes.set(row.id, {
        ...defaultRuntime(row.projectId),
        ...row.runtime,
      });
      if (row.kind === "task" && row.worktree && row.worktreeId !== undefined) {
        this.envs.set(row.id, {
          id: row.id,
          projectId: row.projectId,
          worktree: row.worktree,
          worktreeId: row.worktreeId,
          ...(row.image ? { image: row.image } : {}),
          ...(row.node ? { node: row.node } : {}),
        });
      }
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
    const durable = changed.filter((k) =>
      (DURABLE_KEYS as readonly string[]).includes(k)
    ) as (typeof DURABLE_KEYS)[number][];
    if (durable.length > 0) {
      this.opts.environments.updateDurable(
        id,
        Object.fromEntries(durable.map((k) => [k, patch[k]])) as DurablePatch
      );
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
    const links = this.opts.links?.taskLinks(id);
    return this.opts.tasks
      .listForProject(id)
      .map((t) => this.taskView(t, links?.get(t.id)));
  }

  private taskView(t: TaskRecord, links: TaskLinks = {}): TaskView {
    const {
      projectId: _projectId,
      prompt: _prompt,
      archivedAt: _archivedAt,
      ...view
    } = t;
    return {
      ...view,
      ...links,
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

  /**
   * Records a task environment, for the variant of `taskId` when one asked for it, or the image an existing one was
   * last started from.
   */
  putEnvironment(rec: EnvRecord, actor: Actor = SYSTEM, taskId?: string): void {
    const { environments } = this.opts;
    if (!this.envs.has(rec.id)) {
      environments.putTask(
        {
          id: rec.id,
          projectId: rec.projectId,
          worktreeId: rec.worktreeId,
          ...(rec.node ? { node: rec.node } : {}),
        },
        actor,
        taskId
      );
    }
    if (rec.image) {
      environments.updateDurable(rec.id, { image: rec.image });
    }
    this.envs.set(rec.id, rec);
    if (!this.runtimes.has(rec.id)) {
      this.runtimes.set(rec.id, defaultRuntime(rec.projectId));
    }
    this.emit();
  }

  removeEnvironment(id: EnvId, actor: Actor = SYSTEM): void {
    if (!this.envs.delete(id)) {
      return;
    }
    this.opts.environments.markRemoved(id, actor);
    this.runtimes.delete(id);
    this.sessions.delete(id);
    delete this.resourceStats[id];
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
            worktreeId: e.worktreeId,
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
      ...(this.opts.events
        ? { activity: { latestId: this.opts.events.latestId() } }
        : {}),
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
        id: row.id,
        ...(row.branchId === undefined ? {} : { branchId: row.branchId }),
        ...(branch?.originUrl ? { origin: branch.originUrl } : {}),
      };
    });
  }

  private emit(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }
}
