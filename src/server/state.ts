import type {
  DashboardSnapshot,
  EditorInfo,
  EnvId,
  EnvWorktree,
  IsolationInfo,
  Preflight,
  Project,
  ProjectId,
  ProjectRuntime,
  PublicRuntime,
  SessionSummary,
} from "../shared/types";
import { projectUrl } from "../shared/urls";
import type { PersistedEnv, PersistedRuntime, PersistedState } from "./config";
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

  constructor(private readonly opts: StoreOptions) {
    for (const [id, saved] of Object.entries(opts.persisted.projects)) {
      this.runtimes.set(id, { ...defaultRuntime(id), ...saved });
    }
    for (const [id, saved] of Object.entries(opts.persisted.environments ?? {})) {
      if (!saved?.worktree?.path || !saved.projectId) continue;
      const { projectId, worktree, image, ...runtime } = saved;
      this.envs.set(id, { id, projectId, worktree, ...(image ? { image } : {}) });
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
    this.emit();
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
        return {
          project,
          runtime: publicRuntime(this.runtime(project.id)),
          sessions: this.sessionsOf(project.id),
          openUrl: projectUrl(project.id, this.opts.port),
          environments: this.environments(project.id).map((e) => ({
            id: e.id,
            worktree: e.worktree,
            ...(e.image ? { image: e.image } : {}),
            runtime: publicRuntime(this.runtime(e.id)),
            openUrl: projectUrl(e.id, this.opts.port),
          })),
          ...(isolation ? { isolation } : {}),
        };
      }),
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
      environments[id] = { projectId: e.projectId, worktree: e.worktree, ...(e.image ? { image: e.image } : {}), ...durable(this.runtime(id)) };
    }
    this.opts.persist(Object.keys(environments).length > 0 ? { projects, environments } : { projects });
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
