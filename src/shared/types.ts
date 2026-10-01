export type ProjectId = string;

export interface Project {
  id: ProjectId;
  name: string;
  path: string;
  devcontainerPath: string;
}

export type ContainerState = "stopped" | "starting" | "running" | "stopping" | "error";
export type OpencodeState = "absent" | "starting" | "healthy" | "unhealthy";

export type ForwardedPort =
  | { status: "forwarded"; containerPort: number; label?: string; hostPort: number }
  | { status: "failed"; containerPort: number; label?: string; reason: string }
  | { status: "skipped"; entry: string; reason: string };

export interface Worktree {
  /** Path inside the container. */
  path: string;
  /** Same checkout on this machine, when it lives in the mounted worktrees folder. */
  hostPath?: string;
  branch?: string;
  head?: string;
}

/** Where opendevhub keeps worktrees: a host folder next to the project, mounted next to the workspace. */
export interface WorktreeRoot {
  host: string;
  container: string;
  /** False when the running container was created without the mount (needs a rebuild). */
  mounted: boolean;
}

export interface ProjectRuntime {
  projectId: ProjectId;
  containerId?: string;
  containerName?: string;
  remoteUser?: string;
  containerIp?: string;
  containerState: ContainerState;
  opencode: OpencodeState;
  opencodeVersion?: string;
  password?: string;
  workspaceFolder?: string;
  error?: string;
  ports?: ForwardedPort[];
  relayToken?: string;
  relay?: "active" | "unavailable";
  worktreeRoot?: WorktreeRoot;
  worktrees?: Worktree[];
}

export type PublicRuntime = Omit<ProjectRuntime, "password" | "relayToken">;

export type SessionStatus = "idle" | "running" | "needs-permission" | "needs-answer";

export interface SessionSummary {
  id: string;
  projectId: ProjectId;
  title: string;
  directory: string;
  updatedAt: number;
  status: SessionStatus;
}

export interface Preflight {
  errors: string[];
}

export interface ProjectView {
  project: Project;
  runtime: PublicRuntime;
  sessions: SessionSummary[];
  openUrl: string;
}

export type EditorTarget = "host" | "container";

export interface EditorInfo {
  id: string;
  label: string;
  /** "host" editors open the checkout on this machine; "container" editors attach to the container. */
  target: EditorTarget;
}

export interface DashboardSnapshot {
  roots: string[];
  preflight: Preflight;
  editors: EditorInfo[];
  projects: ProjectView[];
}

export interface LogEvent {
  projectId: ProjectId;
  line: string;
}
