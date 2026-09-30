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

export interface ProjectRuntime {
  projectId: ProjectId;
  containerId?: string;
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

export interface DashboardSnapshot {
  roots: string[];
  preflight: Preflight;
  projects: ProjectView[];
}

export interface LogEvent {
  projectId: ProjectId;
  line: string;
}
