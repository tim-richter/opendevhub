import type { AiFinding, AiReviewMode, OcrRunStats } from "./forgejo";
import type { JiraTaskSource } from "./jira";
import type { ProjectAppearance } from "./project-appearance";
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

/** The Jira board and Forgejo repository a project's tickets and pull requests come from. */
export interface ProjectLinks {
  jiraBoard?: { id: number; name: string };
  /** Raw JQL that picks the project's tickets, on the board when there is one. */
  jiraJql?: string;
  /** `owner/name` on the Forgejo instance. */
  forgejoRepository?: string;
}

/** Where a project setting is saved: the team's devcontainer.json, or the user's own config.json. */
export type SettingsScope = "team" | "personal";

/** The shareable settings of one layer. */
export interface ProjectSharedSettings {
  name?: string;
  appearance: ProjectAppearance;
  links: ProjectLinks;
  /** Team: devcontainer.json's own numeric `forwardPorts`. Personal: the ones forwarded on top. */
  forwardPorts: number[];
}

/** A project's shareable settings per layer, so the UI can say where each value comes from. */
export interface ProjectTeamView {
  /** devcontainer.json relative to the project, where team settings are saved. */
  file: string;
  /** The file could be read, so team settings can be saved to it. */
  writable: boolean;
  errors: string[];
  team: ProjectSharedSettings;
  personal: ProjectSharedSettings;
}

/** One item on a project's to-do list. */
export interface ProjectTodo {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
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
  /** Its branch's row, from `GET /api/projects/:id/branches`. */
  branchId?: number;
  /** Its own row, for `GET /api/provenance/worktree/:id`; absent until opendevhub has recorded it. */
  id?: number;
  /** Who made the worktree; absent until opendevhub has recorded it. */
  createdBy?: CheckoutCreator;
}

/**
 * Who made a branch or worktree: a task variant, the user (on the checkouts page, or from Chat for a chat, which it
 * names), a pull request checkout, or not opendevhub.
 */
export type CheckoutCreator =
  | { by: "variant"; task: string; n: number; title: string }
  | { by: "manual"; chat?: { id: string; title: string } }
  | { by: "pull"; url?: string }
  | { by: "unmanaged" };

/** A branch opendevhub made, published, checked out for a pull request, or found in a worktree. */
export interface BranchView {
  id: number;
  name: string;
  base?: string;
  createdBy: CheckoutCreator;
  /** The pull request it checks out, or the ticket its task started from. */
  origin?: string;
  publishedRemote?: string;
  publishedAt?: number;
  /** The pull request it was published as. */
  prUrl?: string;
  createdAt: number;
  /** When opendevhub deleted it. */
  deletedAt?: number;
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

/** A host port the project makes reachable inside its containers: forwarded, or not working (see the reason). */
export interface HostPortStatus {
  port: number;
  state: "forwarded" | "unavailable";
  reason?: string;
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
  sshAgent?: SshAgentState;
  sshAgentReason?: string;
  /** Kept in memory only, like the ssh-agent state. */
  hostPorts?: HostPortStatus[];
  worktreeRoot?: WorktreeRoot;
  worktrees?: Worktree[];
  /** The personalization (features and dotfiles) the container was created with, as `creationSettings` gives it. */
  personalization?: string;
}

export type PublicRuntime = Omit<ProjectRuntime, "password" | "relayToken">;

/** Where an environment's log lines come from: opendevhub's setup, the container's own output, or opencode's. */
export type EnvLogSource = "setup" | "container" | "opencode";

/** The end of one source of an environment's log; `unavailable` says why it couldn't be read. */
export interface EnvLogs {
  lines: { at?: number; text: string }[];
  unavailable?: string;
}

/** A worktree's own container. */
export interface EnvironmentView {
  id: EnvId;
  worktree: EnvWorktree;
  /** The worktree row it runs on. */
  worktreeId: number;
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

/** A rule opencode saved when someone answered a permission prompt with "always": `action` is allowed on `resource`. */
export interface SavedPermission {
  id: string;
  /** Such as `bash` or `edit`. */
  action: string;
  /** A pattern, such as `git push *` or `src/**`. */
  resource: string;
  createdAt: number;
  updatedAt: number;
}

export interface SavedPermissionsView {
  rules: SavedPermission[];
  /** Whether rules can be edited, not just removed (opencode 2.1+). */
  canEdit: boolean;
  /** Why no rules could be read, such as a stopped container. */
  unavailable?: string;
}

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
  /** Identifies the diff's content, also when its patch isn't sent. */
  hash?: string;
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
  /** Checks sharing a group are shown together and can be run together. */
  group?: string;
}

/** Where a check comes from: the team's devcontainer.json, the user's own settings, or the user's version of a team check. */
export type CheckSource = "team" | "personal" | "override";

/** An entry of the user's own checks: a check of its own, or one turning a team check off. */
export type CheckOverlay = CheckDef | { name: string; disabled: true };

export interface ChecksConfig {
  /** The checks that apply; each host check says whether its exact command was approved. */
  checks: (CheckDef & { approved: boolean; source: CheckSource })[];
  /** As read from devcontainer.json `customizations.opendevhub.checks`. */
  team: CheckDef[];
  /** The user's own entries, laid over the team's by name. */
  personal: CheckOverlay[];
  /** devcontainer.json could be read, so team checks can be saved to it. */
  teamWritable: boolean;
  /** Entries that were dropped, and why. */
  errors: string[];
}

export type CheckStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "cancelled";

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
  /** An existing pull request the forge printed (linked to the branch for "View PR"). */
  prUrl?: string;
  /** The remote's forge, as detected. */
  forge?: ForgeKind;
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

/** The commands opendevhub runs itself from the composer; they win over an opencode command of the same name. */
export const HUB_COMMANDS = [
  { description: "Start a new conversation in this checkout", name: "new" },
  { description: "Stop the running turn", name: "interrupt" },
] as const;

export type HubCommandName = (typeof HUB_COMMANDS)[number]["name"];

/** A `/` suggestion: an opencode command of the checkout, or one of the hub's. */
export interface ComposerCommand {
  name: string;
  description?: string;
  /** Handled by opendevhub, not sent to opencode. */
  hub?: boolean;
  /** An opencode command a hub command of the same name hides. */
  shadowed?: boolean;
}

/** An `@` token in the message: `text.slice(start, end)` is `@${name}`; `name` is a checkout-relative path or an agent id. */
export interface ComposerMention {
  kind: "file" | "agent";
  start: number;
  end: number;
  name: string;
}

/** A file added to a message from the user's machine, inlined as a base64 `data:` URL. */
export interface ComposerAttachment {
  name: string;
  /** `data:<mime>;base64,<bytes>`. */
  url: string;
}

/** The most bytes one attachment may have; opencode refuses a larger one. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENTS_MAX = 10;
/** The most bytes a message's attachments may have together. */
export const ATTACHMENTS_TOTAL_BYTES = 50 * 1024 * 1024;

export interface ComposerSendRequest {
  text: string;
  mentions?: ComposerMention[];
  attachments?: ComposerAttachment[];
  /** The model the message and the turns after it use; omitted keeps the conversation's. */
  model?: ModelRef;
  /** The primary agent the message and the turns after it use; omitted keeps the conversation's. */
  agent?: string;
}

/** What sending did: `sessionId` is the conversation `/new` started, and `chat` its chat. */
export type ComposerSendResult =
  | { kind: "prompt"; queued: boolean }
  | { kind: "command"; name: string; queued: boolean }
  | { kind: "interrupt" }
  | { kind: "new"; sessionId: string; chat?: string };

/** Where a chat runs: a new worktree on the project's defaults, or one of the project's checkouts. */
export type ChatTarget =
  | { kind: "worktree" }
  | { kind: "checkout"; directory: string };

/** `POST …/chat`: the start composer's first message and where it goes. */
export interface ChatStartRequest {
  target: ChatTarget;
  message: ComposerSendRequest;
}

/** The chat the first message started; `sessionId` once its conversation exists (a checkout's, at once). */
export interface ChatStartResult {
  chat: string;
  sessionId?: string;
}

/** `GET …/chats/:chat`: the chat, or for one a task adopted, the task and variant it became. */
export type ChatLookup =
  | { chat: ChatView }
  | { adoptedBy: { task: string; n: number } };

/** `GET …/chats/:chat/suggestions`: links Make task offers for a chat. */
export interface ChatSuggestions {
  /** Jira keys in the chat's branch name and its user messages, branch first. */
  tickets: string[];
  /** Pull requests whose head is the chat's branch. */
  pullRequests: { url: string; title?: string; number?: number }[];
}

/** `POST …/chats/:chat/task`: Make task. */
export interface MakeTaskRequest {
  title: string;
  brief: string;
  ticket?: JiraTaskSource;
  /** A pull request's URL; the chat's branch is recorded as its head. */
  pullRequest?: string;
  /** Write a spec from the conversation: run `opsx-propose <brief>` in it. */
  spec?: boolean;
  /** Extra variants, each in a new worktree from the chat branch's base. */
  variants?: TaskVariantSpec[];
}

/** Who started a chat: opendevhub for the user, opencode directly, or opendevhub only to generate text (never listed). */
export type ChatOrigin = "hub" | "opencode" | "internal";

/**
 * A chat: a conversation in one of the project's checkouts that no task variant owns. It exists before its session
 * when Chat sets up a new worktree for it.
 */
export interface ChatView {
  /** `c_…`; its view is `/chat/:project/:id`. */
  id: string;
  /** Once its conversation exists. */
  sessionId?: string;
  title: string;
  origin: ChatOrigin;
  /** The environment whose opencode runs its session; absent until known. */
  envId?: EnvId;
  directory?: string;
  /** Set when its checkout is a worktree. */
  branch?: string;
  /** Its worktree's row, when its checkout is one opendevhub recorded. */
  worktreeId?: number;
  createdAt: number;
  /** How far a new worktree's setup got; `session` once its conversation exists. */
  step: StartStep;
  error?: string;
  /** The last lines its setup wrote, while it starts. */
  log?: string[];
  /** Its session is gone from opencode. */
  sessionRemoved?: boolean;
  archived?: boolean;
  /** The task that made it its variant; such a chat is no longer listed. */
  adoptedBy?: { task: string; n: number };
  /** From its session, when opencode lists it. */
  updatedAt?: number;
  status?: SessionStatus;
  pending?: PendingItems;
}

/** OpenSpec's workflow as the project's environment offers it. Spec-first tasks need every command and the CLI. */
export interface SpecWorkflow {
  /** The `opsx-*` commands a spec-first task needs that opencode doesn't have. */
  missing: string[];
  /** Whether the container has the `openspec` CLI; absent when that could not be checked. */
  cli?: boolean;
}

/** Where a spec-first task is: proposing (no code yet), implementing the approved change, or archived. */
export type SpecPhase = "propose" | "implement" | "archived";

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
  /**
   * The checkout has no recorded base (the main checkout), so its new changes can't be told from the rest: none is
   * shown until one is picked from all of them.
   */
  baseUnknown?: true;
  /** Why the view can't be read, e.g. a stopped container or no CLI. */
  unavailable?: string;
}

export type TaskWhere = "worktree" | "workspace" | "existing";

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
  /** Path of a known worktree when `where` is `existing`. */
  directory?: string;
  branch?: string;
  base?: string;
  /** Worktree tasks only; the project's default when absent. */
  environment?: Isolation;
  /** The node isolated variants run on; absent for this machine. */
  node?: NodeId;
  /**
   * Propose: start with OpenSpec's `opsx-propose`, the prompt being what to propose. Implement: start with
   * `opsx-apply <change>`, for a change another task proposed and committed on the base.
   */
  spec?: TaskStartSpec;
  /**
   * The first turn as the composer sent it (Chat): run like a later message, a `/name` of a command the variant's
   * checkout has as that command and mentions as attachments. `prompt` is then its text.
   */
  message?: ComposerSendRequest;
  variants: TaskVariantSpec[];
}

export type TaskStartSpec =
  | { phase: "propose" }
  | { phase: "implement"; change: string; proposedIn: string };

/** `POST …/tasks`: spec-first tasks start by proposing; implementing one needs the spec approved first. */
export type NewTaskBody = Omit<TaskRequest, "spec" | "message"> & {
  spec?: true;
};

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
  /** Its task when a task variant owns it; a chat's session has none. */
  task?: SessionTaskRef;
  /** Its chat when no variant owns it, once it has been reconciled. */
  chat?: string;
  model?: ModelRef;
  /** USD so far, its subagents included. */
  cost?: number;
  /** Tokens processed so far (input, output, reasoning and cache), its subagents included. */
  tokens?: number;
  /** Tokens in its context as of the latest reply, the number opencode shows for it; its subagents excluded. */
  context?: number;
  /** Child agent sessions, including agents running after this session goes idle. */
  subagents?: LiveSubagentSummary[];
  /** Shell commands it or its subagents left running in the background, oldest first. */
  shells?: BackgroundShell[];
}

/** A shell command an agent moved to the background; it keeps running after the turn ends. */
export interface BackgroundShell {
  id: string;
  /** The session (this one or a subagent) whose tool call started it. */
  sessionId: string;
  command: string;
  /** The checkout opencode runs it for; killing it goes through this directory. */
  directory: string;
  startedAt: number;
}

export interface LiveSubagentSummary {
  id: string;
  parentId: string;
  title: string;
  agent?: string;
  updatedAt: number;
  status: SessionStatus;
  outcome?: "succeeded" | "failed" | "interrupted";
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

/** One piece of an assistant message in a transcript. */
export type TranscriptPart =
  | { kind: "text"; text: string }
  | {
      kind: "reasoning";
      text: string;
      /** How long the model thought, in milliseconds; missing until it stops or when opencode doesn't time it. */
      duration?: number;
    }
  | {
      kind: "tool";
      name: string;
      /** What the call did, such as the command it ran or the file it read. */
      title?: string;
      status: "pending" | "running" | "completed" | "error";
      /** The text it returned, cut to its start; set once it is done. */
      output?: string;
      /** Why it failed; set on an error. */
      error?: string;
    };

/** A file a user message carried; the bytes stay with opencode. */
export interface TranscriptAttachment {
  name: string;
  mime?: string;
}

/** One message of a session's transcript. */
export type TranscriptMessage =
  | {
      id: string;
      role: "user";
      created: number;
      text: string;
      /** Files added to it from the user's machine; `@` mentions stay in the text. */
      attachments?: TranscriptAttachment[];
    }
  | {
      id: string;
      role: "assistant";
      created: number;
      /** Missing while the agent is still at it. */
      completed?: number;
      parts: TranscriptPart[];
      /** Why it failed, when it did. */
      error?: string;
      agent?: string;
      model?: ModelRef;
    }
  /** The conversation was compacted here. */
  | { id: string; role: "compaction"; created: number }
  /** What opendevhub told the agent about its task when the conversation started in it. */
  | { id: string; role: "briefing"; created: number; text: string };

/** A subagent (child session) of a session. */
export interface SubagentSummary {
  id: string;
  title: string;
  agent?: string;
  updatedAt: number;
  outcome?: "succeeded" | "failed" | "interrupted";
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
  /** Its messages, oldest first. */
  transcript: TranscriptMessage[];
  /** It has older turns than those listed. */
  more: boolean;
}

export interface Preflight {
  errors: string[];
}

export interface ProjectView {
  project: Project;
  appearance?: ProjectAppearance;
  runtime: PublicRuntime;
  sessions: SessionSummary[];
  openUrl: string;
  /** Worktrees with their own container. The main environment is `runtime`. */
  environments: EnvironmentView[];
  /** Known once the main container has started. */
  isolation?: IsolationInfo;
  /** Its tasks that are not archived, oldest first. */
  tasks: TaskView[];
  /** Its chats that are not internal, archived, removed or adopted, newest first. */
  chats: ChatView[];
  /** Host-affecting container settings waiting for the user's approval; see `PendingConfigApproval`. */
  approvals?: PendingConfigApproval[];
}

/** A checkout whose container start a pending approval blocks: the main checkout, or a worktree. */
export type ConfigApprovalSource =
  | { kind: "main" }
  | { kind: "worktree"; envId: EnvId; branch: string; node: NodeId };

/** One host-affecting setting against the closest approved settings. */
export interface ConfigApprovalChange {
  key: string;
  kind: "added" | "changed" | "removed" | "unchanged";
  before?: unknown;
  after?: unknown;
}

/** Host-affecting settings of a project's devcontainer config that no approval of the project matches. */
export interface PendingConfigApproval {
  /** The settings' fingerprint; approving or refusing names it. */
  fingerprint: string;
  sources: ConfigApprovalSource[];
  /** The settings, normalized as compared. */
  surface: Record<string, unknown>;
  /** Against the closest approval, or every setting as added when the project has none. */
  changes: ConfigApprovalChange[];
  /** Whether the project had no approval yet. */
  first: boolean;
  /** Why features count by themselves: their metadata couldn't be read. */
  mergedError?: string;
  at: number;
}

/** Where a starting task variant is: its worktree, its environment (approval, image, container), then its session. */
export type StartStep =
  | "queued"
  | "pushing"
  | "worktree"
  | "approval"
  | "image"
  | "container"
  | "session"
  | "failed";

/**
 * `task`: started or drafted from the New task dialog or a ticket, or made from a chat. `review`: an AI review of a
 * pull request. (Databases from before chats may still hold `manual` in old events; no task has it.)
 */
export type TaskKind = "task" | "review";

/** How a branch relates to a pull request: published as its head, or made to check it out. */
export type PullRole = "head" | "checkout";

/** A pull request opendevhub published, checked out or reviewed. Title and state are as last fetched from its forge. */
export interface PullRequestRef {
  url: string;
  forge: ForgeKind;
  owner?: string;
  repo?: string;
  number?: number;
  title?: string;
  state?: "open" | "closed" | "merged";
  /** When the title and state were fetched; absent when they never were (no API client for the forge). */
  fetchedAt?: number;
}

/** A Jira ticket a task was started from. Title and status are as last fetched from Jira. */
export interface TicketRef {
  instanceUrl: string;
  key: string;
  url: string;
  title?: string;
  status?: string;
  fetchedAt?: number;
}

/** A pull request a task variant's branch was published as. */
export interface VariantPullRequest extends PullRequestRef {
  variant: number;
}

/**
 * Draft while it has no variants; starting while a variant is being set up or failed without being dismissed;
 * running while a variant has a live session; ended once none has.
 */
export type TaskState = "draft" | "starting" | "running" | "ended";

/** What a draft will start with, as the New task dialog asked for it; Start prefills the dialog from it. */
export interface TaskPlan {
  where: TaskWhere;
  directory?: string;
  variants: TaskVariantSpec[];
  branch?: string;
  base?: string;
  environment?: Isolation;
  node?: NodeId;
  /** Start by proposing an OpenSpec change. */
  spec?: boolean;
}

/** A spec-first variant's place in the OpenSpec workflow. */
export interface VariantSpec {
  phase: SpecPhase;
  /** The OpenSpec change the variant works on, once the Spec view found it. */
  change?: string;
  /** The change's folder under `openspec/changes/archive/` once it's archived, e.g. `2026-10-10-add-login`. */
  archived?: string;
}

/** One model/agent attempt at a task, with its checkout and session. */
export interface VariantView {
  /** 1-based. */
  n: number;
  model?: ModelRef;
  agent?: string;
  /** Set when it runs on another node. */
  node?: NodeId;
  /** The environment whose opencode runs its session; the project's id for the main environment. */
  envId?: EnvId;
  branch?: string;
  directory?: string;
  step: StartStep;
  /** Why it failed. */
  error?: string;
  sessionId?: string;
  /** Its session is gone from opencode. */
  sessionRemoved?: boolean;
  picked?: boolean;
  /** Discarded by a pick, or a failed start that was dismissed. */
  discarded?: boolean;
  spec?: VariantSpec;
  /** The last lines its setup wrote, while it starts. Not kept across restarts. */
  log?: string[];
}

/** A task as the database records it. */
export interface TaskView {
  id: string;
  kind: TaskKind;
  title: string;
  jira?: JiraTaskSource;
  /** Spec-first tasks: `first` when it started with `opsx-propose`, and the tasks that proposed or implement its change. */
  spec?: { first: boolean; proposedIn?: string; implementedIn?: string };
  createdAt: number;
  state: TaskState;
  variants: VariantView[];
  /** What the task is for: the prompt it started with, or the brief written for it. */
  brief?: string;
  /** A draft's plan for when it starts. */
  plan?: TaskPlan;
  /** The chat it was made from, which is its variant 1. */
  fromChat?: string;
  /** The ticket it was started from, as last fetched; `jira` keeps what the prompt was built from. */
  ticket?: TicketRef;
  /** The pull requests its variants' branches were published as; absent when there are none. */
  pullRequests?: VariantPullRequest[];
  /** Review tasks: the pull request under review. */
  reviewOf?: PullRequestRef;
}

/** An archived task shown in the project's task card, outside the live snapshot. */
export interface ArchivedTask {
  id: string;
  title: string;
  kind: TaskKind;
  variants: number;
  archivedAt: number;
}

/** What a pull request is linked to in opendevhub, from `GET /api/links/pull`. Empty for one it never touched. */
export interface PullLinks {
  /** Its row, for `GET /api/provenance/pull_request/:id`. */
  id?: number;
  pull?: PullRequestRef;
  branches: {
    projectId: ProjectId;
    id: number;
    name: string;
    role: PullRole;
    deleted?: boolean;
    /** The task variant that created the branch. */
    task?: { id: string; title: string; n: number };
    /** Its worktrees, live and removed, newest first. */
    worktrees: { path: string; node?: NodeId; removed?: boolean }[];
  }[];
  /** The review tasks of the pull request, newest first. */
  reviewTasks: {
    projectId: ProjectId;
    id: string;
    title: string;
    createdAt: number;
  }[];
  /** Stored AI reviews, newest first. */
  reviews: StoredAiReview[];
}

/** What a ticket is linked to in opendevhub, from `GET /api/links/ticket`. Empty for one no task started from. */
export interface TicketLinks {
  /** Its row, for `GET /api/provenance/ticket/:id`. */
  id?: number;
  ticket?: TicketRef;
  /** The tasks started from it, archived ones included, newest first, each with its variants' pull requests. */
  tasks: {
    projectId: ProjectId;
    id: string;
    title: string;
    state: TaskState;
    createdAt: number;
    archived?: boolean;
    pullRequests: VariantPullRequest[];
  }[];
}

/** One stored AI review run of a pull request. */
export interface StoredAiReview {
  id: number;
  /** The head commit the review was checked against. */
  headSha: string;
  mode: AiReviewMode;
  sessionId?: string;
  /** The review task it ran in. */
  taskId?: string;
  summary: string;
  findings: AiFinding[];
  /** Set for Open Code Review runs. */
  stats?: OcrRunStats;
  createdAt: number;
}

/** The task a session belongs to. */
export interface SessionTaskRef {
  id: string;
  kind: TaskKind;
  /** Its variant's number. */
  n: number;
  discarded: boolean;
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
  /** By task id, discarded variants included. */
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
  /** The newest recorded event's id; changes whenever an event is recorded. Absent without an event log. */
  activity?: { latestId: number };
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
  why: "archived" | "discarded" | "worktree-gone" | "idle";
}

/** An ended task cleanup may archive: hidden from the dashboard, its record kept. */
export interface TaskCleanupItem {
  /** `task:<projectId>:<taskId>`. */
  id: string;
  kind: "task";
  checked: boolean;
  reason: string;
  projectId: ProjectId;
  taskId: string;
  title: string;
  /** When anything last happened to it, such as its last session going away. */
  lastActivity: number;
}

/** An archived chat record that cleanup may permanently delete. */
export interface ChatCleanupItem {
  id: string;
  kind: "chat";
  checked: boolean;
  reason: string;
  projectId: ProjectId;
  chatId: string;
  title: string;
  archivedAt: number;
}

/** An archived task record that cleanup may permanently delete. */
export interface ArchivedTaskCleanupItem {
  id: string;
  kind: "archived-task";
  checked: boolean;
  reason: string;
  projectId: ProjectId;
  taskId: string;
  title: string;
  archivedAt: number;
}

/** The stored AI reviews of a closed or merged pull request, none of them recent. */
export interface ReviewCleanupItem {
  /** `review:<pullRequestId>`. */
  id: string;
  kind: "review";
  checked: boolean;
  reason: string;
  pullRequestId: number;
  url: string;
  number?: number;
  title?: string;
  /** How many reviews it has. */
  count: number;
  /** When its newest review ran. */
  lastReview: number;
}

export type CleanupItem =
  | BranchCleanupItem
  | ChatCleanupItem
  | ArchivedTaskCleanupItem
  | ContainerCleanupItem
  | ImageCleanupItem
  | SessionCleanupItem
  | TaskCleanupItem
  | ReviewCleanupItem;

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
