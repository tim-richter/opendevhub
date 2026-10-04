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

/** A field of an opencode form, passed through unchanged. `type` stays open so new field types still reach the UI. */
export interface FormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: { key: string; op: "eq" | "neq"; value: unknown }[];
  default?: unknown;
  options?: (string | { value: string; label?: string })[];
  custom?: boolean;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  url?: string;
}

export type FormAnswer = Record<string, string | number | boolean | string[]>;

export type PermissionDecision = "once" | "always" | "reject";

export interface PendingPermission {
  id: string;
  /** The session that asked (may be a subagent); used in the reply path. */
  sessionId: string;
  action: string;
  resources: string[];
  /** Patterns "always" would persist. */
  save?: string[];
  message?: string;
  /** A unified diff from the request's metadata (`diff` or `patch`), when it carries one. */
  diff?: string;
  /** First time the monitor saw it; for ordering. */
  createdAt?: number;
}

export interface PendingForm {
  id: string;
  sessionId: string;
  title: string;
  fields: FormField[];
  createdAt?: number;
}

export interface PendingItems {
  permissions: PendingPermission[];
  forms: PendingForm[];
}

export type UpdateStrategy = "rebase" | "merge";

/** Result of "Update from base": `conflicts` lists files when it was aborted. */
export interface UpdateResult {
  strategy: UpdateStrategy;
  conflicts?: string[];
}

export interface ReviewBase {
  name: string;
  source: "request" | "config" | "opencode" | "default";
}

export interface ReviewFile {
  file: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** Missing when the response ran out of patch budget (load it with `?file=`) or the file is binary. */
  patch?: string;
  binary?: boolean;
}

export interface ReviewData {
  directory: string;
  /** Undefined on a detached HEAD. */
  branch?: string;
  base?: ReviewBase;
  mode: "working" | "branch";
  ahead: number;
  behind: number;
  /** Uncommitted changes in the target. */
  dirty: boolean;
  pushed: boolean;
  /** The main checkout, which "Merge into base" needs clean and on the base. */
  workspace: { branch?: string; clean: boolean };
  files: ReviewFile[];
  truncated?: boolean;
}

export type ForgeKind = "github" | "gitlab" | "forgejo" | "gitea" | "bitbucket" | "unknown";
export type PublishStrategy = "branch" | "agit";

export interface PublishInfo {
  /** Undefined on a detached HEAD. */
  branch?: string;
  remotes: string[];
  /** The remote the rest describes: `origin` when it exists, else the first. */
  remote?: string;
  forge: { kind: ForgeKind; webBase?: string };
  strategies: PublishStrategy[];
  strategy: PublishStrategy;
  /** Where the push will run: the host uses your own ssh-agent and credentials. */
  pushFrom: "host" | "container";
  /** The pull request this branch was published to, when the forge printed one. */
  pr?: string;
}

export interface PublishRequest {
  remote: string;
  base: string;
  strategy: PublishStrategy;
  title: string;
  description: string;
}

export interface PublishResult {
  strategy: PublishStrategy;
  pushedFrom: "host" | "container";
  /** An existing pull request the forge printed (stored for "View PR"). */
  prUrl?: string;
  /** Where to go next: the PR, the forge's new-PR page, or whatever URL the remote printed. */
  openUrl?: string;
  notice?: string;
  /** The last lines of git's output. */
  output: string[];
}

/** A model as opencode refers to it; `id` is the model's id within its provider. */
export interface ModelRef {
  id: string;
  providerID: string;
  /** A reasoning variant such as "high"; opencode's own default is "default". */
  variant?: string;
}

/** A model a new session can use. Only these fields leave the server: opencode's model info also holds API keys. */
export interface ModelOption {
  id: string;
  providerID: string;
  name: string;
  variants: string[];
}

export interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export interface ModelsInfo {
  models: ModelOption[];
  default?: ModelRef;
  agents: AgentOption[];
}

/** What opendevhub writes to `metadata.opendevhub` on each session of a task. */
export interface TaskMeta {
  task: string;
  /** 1-based. */
  variant: number;
  of: number;
  title: string;
  /** The branch the task created for this variant's worktree; absent for the main checkout and for older tasks. */
  branch?: string;
  discarded?: boolean;
}

export type TaskWhere = "worktree" | "workspace";

/** One variant of a task: no model or agent means the project's default. */
export interface TaskVariantSpec {
  model?: ModelRef;
  agent?: string;
}

export interface TaskRequest {
  prompt: string;
  title?: string;
  where: TaskWhere;
  branch?: string;
  base?: string;
  variants: TaskVariantSpec[];
}

export interface TaskVariantResult {
  branch?: string;
  /** Missing when the variant's worktree could not be created. */
  directory?: string;
  sessionId?: string;
  error?: string;
}

export interface TaskResult {
  task: string;
  variants: TaskVariantResult[];
}

export interface PickResult {
  /** Session ids marked discarded. */
  discarded: string[];
  /** Worktree paths removed, with their branches. */
  removed: string[];
  errors: string[];
}

export interface SessionSummary {
  id: string;
  projectId: ProjectId;
  title: string;
  directory: string;
  updatedAt: number;
  status: SessionStatus;
  /** What the session (or one of its subagents) is waiting on, oldest first. Omitted when nothing is. */
  pending?: PendingItems;
  /** Set when the session belongs to a task. */
  task?: TaskMeta;
  model?: ModelRef;
  /** USD so far. */
  cost?: number;
  /** Input, output and reasoning tokens so far. */
  tokens?: number;
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
