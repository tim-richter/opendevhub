import type {
  DashboardSnapshot,
  EditorInfo,
  Preflight,
  Project,
  ProjectId,
  ProjectRuntime,
  SessionSummary,
} from "../shared/types";
import { projectUrl } from "../shared/urls";
import type { PersistedRuntime, PersistedState } from "./config";

export interface StoreOptions {
  port: number;
  persisted: PersistedState;
  persist: (state: PersistedState) => void;
}

const DURABLE_KEYS = ["containerId", "password", "workspaceFolder", "relayToken", "remoteUser"] as const;

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

  constructor(private readonly opts: StoreOptions) {
    for (const [id, saved] of Object.entries(opts.persisted.projects)) {
      this.runtimes.set(id, { ...defaultRuntime(id), ...saved });
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
        const { password: _password, relayToken: _relayToken, ...runtime } = this.runtime(project.id);
        return {
          project,
          runtime,
          sessions: this.sessions.get(project.id) ?? [],
          openUrl: projectUrl(project.id, this.opts.port),
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
    for (const [id, r] of this.runtimes) {
      if (r.containerId || r.password || r.workspaceFolder || r.relayToken) {
        projects[id] = {
          containerId: r.containerId,
          password: r.password,
          workspaceFolder: r.workspaceFolder,
          relayToken: r.relayToken,
          ...(r.remoteUser ? { remoteUser: r.remoteUser } : {}),
        };
      }
    }
    this.opts.persist({ projects });
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
