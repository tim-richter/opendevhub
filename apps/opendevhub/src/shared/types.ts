import type { JiraTaskSource } from "./jira";
import type { StackId } from "./stacks";

export type ProjectId = string;

/** One devcontainer with its own opencode. A project's main environment has the project's id. */
export type EnvId = string;

/** Whether a task's worktree runs in the project's container or in its own. */
export type Isolation = "shared" | "isolated";

/** The worktree a task environment serves, as the main container and this machine see it. */
export interface EnvWorktree {
  path: string;
  hostPath: string;
  branch: string;
}

export interface Project {
  id: ProjectId;
  name: string;
  path: string;
  devcontainerPath: string;
}

export type ContainerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";
export type OpencodeState = "absent" | "starting" | "healthy" | "unhealthy";

export type ForwardedPort =
  | {
      status: "forwarded";
      containerPort: number;
      label?: string;
      hostPort: number;
    }
  | { status: "failed"; containerPort: number; label?: string; reason: string }
  | { status: "skipped"; entry: string; reason: string };

export interface Worktree {
  /** Path inside the container. */
  path: string;
  /** Same checkout on this machine, when it lives in the mounted worktrees folder. */
  hostPath?: string;
  /** Set on worktrees that live on another node; they have no hostPath on this machine. */
  node?: NodeId;
  branch?: string;
  head?: string;
  /** The pull request or Jira ticket (its web URL) the worktree was created for, when opendevhub made it for one. */
  origin?: string;
}

/** Where opendevhub keeps worktrees: a host folder next to the project, mounted next to the workspace. */
export interface WorktreeRoot {
  host: string;
  container: string;
  /** False when the running container was created without the mount (needs a rebuild). */
  mounted: boolean;
}

/** Whether the host's ssh-agent reaches a container: forwarded, turned off for the project, or not working (see the reason). */
export type SshAgentState = "forwarded" | "off" | "unavailable";

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
  sshAgent?: SshAgentState;
  sshAgentReason?: string;
  worktreeRoot?: WorktreeRoot;
  worktrees?: Worktree[];
}

export type PublicRuntime = Omit<ProjectRuntime, "password" | "relayToken">;

/** A worktree's own container. */
export interface EnvironmentView {
  id: EnvId;
  worktree: EnvWorktree;
  /** The node it runs on; absent for this machine. */
  node?: NodeId;
  /** The base image it was last started from. */
  image?: { key: string; ref: string };
  runtime: PublicRuntime;
  /** Its opencode, like ProjectView.openUrl. */
  openUrl: string;
}

export interface IsolationInfo {
  /** What new tasks use unless they choose. */
  default: Isolation;
  /** Why worktrees of this project can't get their own container; tasks then run shared. */
  unsupported?: string;
}

export type SessionStatus =
  | "idle"
  | "running"
  | "needs-permission"
  | "needs-answer";

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

/**
 * `working`: uncommitted changes. `branch`: everything since the merge-base with the base. `turn`: what an agent
 * session changed in one of its turns.
 */
export type ReviewMode = "working" | "branch" | "turn";

/** A prompt that started a turn, for picking which turn to review. */
export interface ReviewTurnPrompt {
  /** The user message id. */
  id: string;
  /** The prompt's text, cut to its start. */
  text: string;
  created: number;
}

/** The session and turn a `turn` review shows. */
export interface ReviewTurn {
  sessionId: string;
  sessionTitle: string;
  /** The prompt whose turn is shown; missing when the session has no prompts yet. */
  from?: string;
  /** The newest prompt's turn is shown. */
  latest: boolean;
  /** The session is still working, so the turn may change. */
  running: boolean;
  /** Recent prompts, newest first. */
  prompts: ReviewTurnPrompt[];
}

export interface ReviewFile {
  file: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** Missing when the response ran out of patch budget, the diff is large (load it with `?file=`) or the file is binary. */
  patch?: string;
  binary?: boolean;
  /** Too big to load with the others: many changed lines or a big patch. */
  large?: boolean;
}

export interface ReviewData {
  directory: string;
  /** Undefined on a detached HEAD. */
  branch?: string;
  base?: ReviewBase;
  mode: ReviewMode;
  /** Set in `turn` mode. */
  turn?: ReviewTurn;
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

/** Where a check runs: in the checkout's environment, or on this machine in its host folder. */
export type CheckWhere = "container" | "host";

/** A command a change must pass, from `customizations.opendevhub.checks` or the project's settings. */
export interface CheckDef {
  name: string;
  command: string;
  where: CheckWhere;
  /** Seconds. */
  timeout: number;
}

export type CheckSource = "devcontainer" | "settings" | "none";

export interface ChecksConfig {
  /** The checks that apply; each host check says whether its exact command was approved. */
  checks: (CheckDef & { approved: boolean })[];
  source: CheckSource;
  /** As read from devcontainer.json, and the project's own list when it has one. */
  devcontainer: CheckDef[];
  settings?: CheckDef[];
  /** Entries that were dropped, and why. */
  errors: string[];
}

export type CheckStatus = "queued" | "running" | "passed" | "failed" | "error";

export interface CheckResult {
  name: string;
  command: string;
  where: CheckWhere;
  status: CheckStatus;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  /** Why it couldn't run ("error"). */
  reason?: string;
  /** The last lines of its output. */
  output: string[];
}

export interface CheckRun {
  directory: string;
  /** The commit the run tested, and whether it had uncommitted changes then. */
  head?: string;
  dirty: boolean;
  startedAt: number;
  finishedAt?: number;
  results: CheckResult[];
}

export interface ChecksView extends ChecksConfig {
  run?: CheckRun;
  /** The run still describes the checkout: same HEAD, same dirty state. */
  current?: boolean;
}

export type ForgeKind =
  | "github"
  | "gitlab"
  | "forgejo"
  | "gitea"
  | "bitbucket"
  | "unknown";
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
  /** Absent when opencode has none of OpenSpec's `opsx-*` commands. */
  spec?: SpecWorkflow;
}

/** OpenSpec's workflow as the project's environment offers it. Spec-first tasks need every command and the CLI. */
export interface SpecWorkflow {
  /** The `opsx-*` commands a spec-first task needs that opencode doesn't have. */
  missing: string[];
  /** Whether the container has the `openspec` CLI; absent when that could not be checked. */
  cli?: boolean;
}

/** What opendevhub writes to `metadata.opendevhub` on each session of a task. */
export interface TaskMeta {
  jira?: JiraTaskSource;
  task: string;
  /** 1-based. */
  variant: number;
  of: number;
  title: string;
  /** The branch the task created for this variant's worktree; absent for the main checkout and for older tasks. */
  branch?: string;
  /** Started with OpenSpec's `opsx-propose`: the agent writes a change proposal before any code. */
  spec?: TaskSpec;
  discarded?: boolean;
}

/** Where a spec-first task is: proposing (no code yet), implementing the approved change, or archived. */
export type SpecPhase = "propose" | "implement" | "archived";

export interface TaskSpec {
  phase: SpecPhase;
  /** The OpenSpec change the task works on, once the Spec view found it. */
  change?: string;
  /** The change's folder under `openspec/changes/archive/` once it's archived, e.g. `2026-10-10-add-login`. */
  archived?: string;
}

/** A change in `openspec list`; `isNew` when the checkout's base doesn't have it, so the task made it. */
export interface SpecChangeSummary {
  name: string;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  isNew: boolean;
}

/** One artifact of the change's schema (proposal, specs, design, tasks) as `openspec status` reports it. */
export interface SpecArtifact {
  id: string;
  outputPath: string;
  /** `done`, `ready` (its dependencies are done) or `blocked`. */
  status: string;
  missingDeps?: string[];
}

export type RequirementOperation = "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED";

/** One requirement a change's delta spec touches, with its current text where the capability's spec has it. */
export interface RequirementChange {
  capability: string;
  operation: RequirementOperation;
  name: string;
  /** RENAMED: the requirement's old name. */
  from?: string;
  /** The requirement as `openspec/specs/<capability>/spec.md` has it now. */
  before?: string;
  /** The block as the delta writes it: the new text, or for REMOVED its reason. Empty for a bare rename. */
  delta: string;
}

export interface SpecChange {
  name: string;
  artifacts: SpecArtifact[];
  /** Every artifact implementing needs is done. */
  planningComplete: boolean;
  /** The change's markdown files, relative to its folder. */
  documents: { path: string; content: string }[];
  requirements: RequirementChange[];
  validation: { valid: boolean; issues: string[] };
  /** Once archived: its folder under `openspec/changes/archive/`. */
  archived?: string;
  /** Once archived: the main specs it updated, `<capability>/spec.md` as they are now. */
  updatedSpecs?: { path: string; content: string }[];
}

/** A checkout's OpenSpec changes and the one shown. */
export interface SpecView {
  changes: SpecChangeSummary[];
  change?: SpecChange;
  /** Why the view can't be read, e.g. a stopped container or no CLI. */
  unavailable?: string;
}

export type TaskWhere = "worktree" | "workspace";

/** One variant of a task: no model or agent means the project's default. */
export interface TaskVariantSpec {
  model?: ModelRef;
  agent?: string;
}

export interface TaskRequest {
  jira?: JiraTaskSource;
  prompt: string;
  title?: string;
  where: TaskWhere;
  branch?: string;
  base?: string;
  /** Worktree tasks only; the project's default when absent. */
  environment?: Isolation;
  /** The node isolated variants run on; absent for this machine. */
  node?: NodeId;
  /** Start with OpenSpec's `opsx-propose`, the prompt being what to propose. */
  spec?: true;
  variants: TaskVariantSpec[];
}

export interface TaskVariantResult {
  branch?: string;
  /** Missing when the variant's worktree could not be created. */
  directory?: string;
  sessionId?: string;
  /** Set when the variant runs in its own container. */
  envId?: EnvId;
  /** Why the variant runs shared although its own container was asked for. */
  notice?: string;
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
  /** The task environment whose opencode runs it; absent for the main environment. */
  envId?: EnvId;
  title: string;
  directory: string;
  updatedAt: number;
  status: SessionStatus;
  /** What the session (or one of its subagents) is waiting on, oldest first. Omitted when nothing is. */
  pending?: PendingItems;
  /** Set when the session belongs to a task. */
  task?: TaskMeta;
  model?: ModelRef;
  /** USD so far, its subagents included. */
  cost?: number;
  /** Tokens processed so far (input, output, reasoning and cache), its subagents included. */
  tokens?: number;
  /** Tokens in its context as of the latest reply, the number opencode shows for it; its subagents excluded. */
  context?: number;
}

/** Tokens by kind. */
export interface TokenBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One turn of a session: a prompt and the agent's replies to it. */
export interface SessionTurn {
  /** The prompt's user message id; the `from` of a `turn` review. */
  id: string;
  /** The prompt, cut short when long. */
  prompt: string;
  created: number;
  /** When its last reply finished; missing while the agent is still at it. */
  completed?: number;
  /** USD; its subagents excluded. */
  cost?: number;
  /** Tokens processed, cache included; its subagents excluded. */
  tokens?: number;
  /** Model calls the agent made. */
  steps: number;
  tools: number;
  failedTools: number;
  /** Files its replies changed. */
  files: number;
  /** The text of its last reply that has any, cut short when long. */
  reply?: string;
  /** Why its last reply failed, when it did. */
  error?: string;
  agent?: string;
  model?: ModelRef;
}

/** A subagent (child session) of a session. */
export interface SubagentSummary {
  id: string;
  title: string;
  agent?: string;
  updatedAt: number;
  /** USD; its own subagents included. */
  cost?: number;
  tokens?: number;
}

/** What the session page shows beyond the session's summary. */
export interface SessionDetail {
  session: SessionSummary;
  createdAt: number;
  agent?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  /** Its own tokens by kind; its subagents excluded. */
  tokens?: TokenBreakdown;
  /** The context window of its model, when opencode knows it. */
  contextLimit?: number;
  subagents: SubagentSummary[];
  /** Its turns, newest first. */
  turns: SessionTurn[];
  /** It has older turns than those listed. */
  more: boolean;
}

export interface Preflight {
  errors: string[];
}

export interface ProjectView {
  project: Project;
  runtime: PublicRuntime;
  sessions: SessionSummary[];
  openUrl: string;
  /** Worktrees with their own container. The main environment is `runtime`. */
  environments: EnvironmentView[];
  /** Known once the main container has started. */
  isolation?: IsolationInfo;
  /** Tasks whose variants are still being set up, newest last. */
  starting?: StartingTask[];
}

/** Where a starting task variant is: its worktree, its environment (image, container), then its session. */
export type StartStep =
  | "queued"
  | "pushing"
  | "worktree"
  | "image"
  | "container"
  | "session"
  | "failed";

export interface StartingVariant {
  /** 1-based, as in TaskMeta. */
  variant: number;
  branch?: string;
  /** Set when it runs on another node. */
  node?: NodeId;
  step: StartStep;
  /** Why it failed. */
  error?: string;
  /** Set once its session exists; the variant leaves the list when the session shows up. */
  sessionId?: string;
  /** The last lines its setup wrote. */
  log: string[];
}

/** A task the dashboard started whose variants aren't all running yet. Kept in memory only. */
export interface StartingTask {
  jira?: JiraTaskSource;
  task: string;
  title: string;
  of: number;
  createdAt: number;
  variants: StartingVariant[];
}

export type EditorTarget = "host" | "container";

export interface EditorInfo {
  id: string;
  label: string;
  /** "host" editors open the checkout on this machine; "container" editors attach to the container. */
  target: EditorTarget;
}

export interface Usage {
  /** USD. */
  cost: number;
  /** Tokens processed: input, output, reasoning and cache. */
  tokens: number;
}

/** Spend from opendevhub's ledger; "today" is the server's local date. */
export interface UsageTotals {
  today: Usage;
  projects: Record<ProjectId, { today: Usage; total: Usage }>;
  /** By TaskMeta.task, discarded variants included. */
  tasks: Record<string, Usage>;
}

/** The Usage page: all-time and today's spend, one day by project, and the daily spend leading up to today. */
export interface UsageReport {
  total: Usage;
  today: Usage;
  /** YYYY-MM-DD, the day `dayTotal` and `projects` are for. */
  day: string;
  dayTotal: Usage;
  /** Most expensive first. */
  projects: ({ projectId: ProjectId } & Usage)[];
  /** One entry per day, oldest first, ending today; days without spend are zeros. */
  days: ({ day: string } & Usage)[];
}

/** One container's load, as `docker stats` reports it. */
export interface ResourceStats {
  /** Percent of one CPU core, so it exceeds 100 on several cores (as in `docker stats`). Whole number. */
  cpu: number;
  /** Bytes, rounded to 1 MiB. */
  memory: number;
  /** Bytes; the container's limit, or the host's memory when it has none. */
  memoryLimit: number;
}

/** A machine that runs environments: `local` (this one), or an ssh destination from config.json. */
export type NodeId = string;

export type NodeState = "online" | "connecting" | "unreachable" | "error";

/** A node's capacity: memory in bytes, `containers` counts opendevhub's running containers. */
export interface NodeStats {
  cpus: number;
  memTotal: number;
  memAvailable: number;
  containers: number;
}

export interface NodeView {
  id: NodeId;
  label: string;
  /** The ssh destination; absent for `local`. */
  ssh?: string;
  state: NodeState;
  /** Why the node is unreachable or needs setup. */
  reason?: string;
  stats?: NodeStats;
}

export interface DashboardSnapshot {
  roots: string[];
  preflight: Preflight;
  editors: EditorInfo[];
  projects: ProjectView[];
  /** Absent when the usage ledger couldn't be opened. */
  usage?: UsageTotals;
  /** By environment id (a main environment's id is its project id); running environments only. */
  resources?: Record<EnvId, ResourceStats>;
  /** `local` first, then configured nodes in config order. */
  nodes?: NodeView[];
}

export interface LogEvent {
  projectId: ProjectId;
  line: string;
}

/** A git repo under a root that has no devcontainer yet. */
export interface Candidate {
  path: string;
  name: string;
  /** The root it was found under. */
  root: string;
  /** Detected from marker files; the user can pick another. */
  stack: StackId;
}

export interface CandidateList {
  roots: string[];
  candidates: Candidate[];
}

export interface AddProjectResult {
  projectId: ProjectId;
  started: boolean;
  /** Why the project wasn't started. */
  error?: string;
}

/** A local branch cleanup may delete, with its worktree and that worktree's own container. */
export interface BranchCleanupItem {
  /** `branch:<projectId>:<branch>`. */
  id: string;
  kind: "branch";
  /** Whether the page selects it by default. */
  checked: boolean;
  /** What the page shows, e.g. "merged into main". */
  reason: string;
  projectId: ProjectId;
  branch: string;
  base: string;
  why: "merged" | "upstream-gone";
  /** Its linked worktree, as the container sees it. */
  worktree?: string;
  /** The worktree has uncommitted or untracked changes; removing it discards them. */
  dirty?: boolean;
  /** The worktree's own environment, removed with it. */
  env?: EnvId;
}

export interface ContainerCleanupItem {
  /** `container:<containerId>`. */
  id: string;
  kind: "container";
  checked: boolean;
  reason: string;
  containerId: string;
  name?: string;
  running: boolean;
  why: "orphan-env" | "removed-project";
  /** The project its labels name, current or not. */
  projectId?: ProjectId;
}

export interface ImageCleanupItem {
  /** `image:<ref>`. */
  id: string;
  kind: "image";
  checked: boolean;
  reason: string;
  ref: string;
  bytes: number;
  why: "superseded" | "removed-project" | "uid";
  projectId?: ProjectId;
}

/** A top-level opencode session cleanup may delete, with its subagent sessions. */
export interface SessionCleanupItem {
  /** `session:<projectId>:<sessionId>`. */
  id: string;
  kind: "session";
  checked: boolean;
  reason: string;
  projectId: ProjectId;
  /** The task environment whose opencode holds it; absent for the main environment. */
  envId?: EnvId;
  sessionId: string;
  title: string;
  directory: string;
  /** The latest update in the session's tree. */
  updatedAt: number;
  why: "discarded" | "worktree-gone" | "idle";
}

export type CleanupItem =
  | BranchCleanupItem
  | ContainerCleanupItem
  | ImageCleanupItem
  | SessionCleanupItem;

export interface CleanupProject {
  id: ProjectId;
  name: string;
  /** The scan went on without something, e.g. "using local refs: <reason>". */
  warning?: string;
  /** Branches can't be scanned without the main container. */
  skipped?: "not running";
}

export interface CleanupPlan {
  scannedAt: number;
  projects: CleanupProject[];
  /** Set when Docker could not be listed; there are then no container or image items. */
  dockerError?: string;
  items: CleanupItem[];
}

export interface CleanupOutcome {
  outcome: "removed" | "skipped" | "failed";
  message?: string;
}

export interface CleanupResult {
  results: (CleanupOutcome & { id: string })[];
  /** Sum of the removed images' sizes; layers shared with other images make the real number smaller. */
  freedBytes: number;
}
