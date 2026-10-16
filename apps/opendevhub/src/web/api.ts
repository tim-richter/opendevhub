import type { ActivityFilter, ObjectType } from "../shared/activity";
import type {
  ForgejoReviewInput,
  ForgejoPullFilter,
  ForgejoPresetFilters,
  ForgejoPullQuery,
  ForgejoSettingsInput,
} from "../shared/forgejo";
import type { ImageSide } from "../shared/images";
import { jiraQueryValues } from "../shared/jira";
import type {
  JiraPresetFilters,
  JiraSettingsInput,
  JiraTaskSource,
  JiraTicketQuery,
} from "../shared/jira";
import type {
  OcrProjectInput,
  OcrSettingsInput,
  OcrTestInput,
} from "../shared/ocr";
import type {
  Personalization,
  ProjectPersonalization,
} from "../shared/personalization";
import type { ProjectColor } from "../shared/project-appearance";
import type { StackId } from "../shared/stacks";
import type {
  ChatStartRequest,
  CheckOverlay,
  CleanupItem,
  ComposerSendRequest,
  DashboardSnapshot,
  FormAnswer,
  LogEvent,
  MakeTaskRequest,
  PermissionDecision,
  ProjectLinks,
  SettingsScope,
  PublishRequest,
  ReviewMode,
  NewTaskBody,
  TaskVariantSpec,
} from "../shared/types";
import { api, complete, read, reply } from "./rpc";

export type Action =
  | "start"
  | "stop"
  | "rebuild"
  | "rebuild-no-cache"
  | "restart-opencode";
export type ReplyOutcome = "done" | "gone";
const project = api.projects[":id"];
const pull = api.forgejo.pulls[":owner"][":repo"][":number"];
const projectParam = (id: string) => ({ id: encodeURIComponent(id) });
const pullParam = (owner: string, repo: string, number: string) => ({
  owner: encodeURIComponent(owner),
  repo: encodeURIComponent(repo),
  number: encodeURIComponent(number),
});

export const fetchForgejoSettings = () =>
  read(
    api.forgejo.settings.$get(undefined, { init: { cache: "no-store" } }),
    "Forgejo settings"
  );

export const saveForgejoSettings = (input: ForgejoSettingsInput) =>
  read(api.forgejo.settings.$post({ json: input }), "save Forgejo settings");

export const fetchForgejoPulls = (
  input: ForgejoPullQuery | ForgejoPullFilter = "all",
  signal?: AbortSignal
) => {
  const options = typeof input === "string" ? { state: input } : input;
  const query = {
    state: options.state,
    inbox: options.inbox,
    repository: options.repository || undefined,
    q: options.q || undefined,
    org: options.org || undefined,
    team: options.team || undefined,
    authors: options.authors?.length ? options.authors.join(",") : undefined,
    page: options.page === undefined ? undefined : String(options.page),
  };
  return read(
    api.forgejo.pulls.$get({ query }, { init: { cache: "no-store", signal } }),
    "Forgejo request"
  );
};

export const fetchForgejoOrganizations = (signal?: AbortSignal) =>
  read(
    api.forgejo.orgs.$get(undefined, { init: { cache: "no-store", signal } }),
    "Forgejo request"
  );

export const fetchForgejoUsers = (q: string, signal?: AbortSignal) =>
  read(
    api.forgejo.users.$get(
      { query: { q } },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const fetchForgejoTeams = (org: string, signal?: AbortSignal) =>
  read(
    api.forgejo.orgs[":org"].teams.$get(
      { param: { org: encodeURIComponent(org) } },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const fetchForgejoPresets = (signal?: AbortSignal) =>
  read(
    api.forgejo.presets.$get(undefined, {
      init: { cache: "no-store", signal },
    }),
    "Filter presets"
  );

export const createForgejoPreset = (
  name: string,
  filters: ForgejoPresetFilters
) =>
  read(api.forgejo.presets.$post({ json: { filters, name } }), "Save preset");

export const updateForgejoPreset = (
  id: number,
  changes: { name?: string; filters?: ForgejoPresetFilters }
) =>
  read(
    api.forgejo.presets[":id"].$put({
      json: changes,
      param: { id: String(id) },
    }),
    "Update preset"
  );

export const removeForgejoPreset = async (id: number) => {
  await complete(
    api.forgejo.presets[":id"].$delete({ param: { id: String(id) } }),
    "Delete preset"
  );
};

export const fetchForgejoDetails = (
  owner: string,
  repo: string,
  number: string,
  signal?: AbortSignal
) =>
  read(
    pull.$get(
      { param: pullParam(owner, repo, number) },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const fetchForgejoDiff = (
  owner: string,
  repo: string,
  number: string,
  signal?: AbortSignal
) =>
  read(
    pull.patch.$get(
      { param: pullParam(owner, repo, number) },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const fetchForgejoApprovals = (
  owner: string,
  repo: string,
  number: string,
  signal?: AbortSignal
) =>
  read(
    pull.approvals.$get(
      { param: pullParam(owner, repo, number) },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const fetchForgejoComments = (
  owner: string,
  repo: string,
  number: string,
  page: number,
  signal?: AbortSignal
) =>
  read(
    pull.comments.$get(
      { param: pullParam(owner, repo, number), query: { page: String(page) } },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const fetchForgejoReviews = (
  owner: string,
  repo: string,
  number: string,
  page: number,
  signal?: AbortSignal
) =>
  read(
    pull.reviews.$get(
      { param: pullParam(owner, repo, number), query: { page: String(page) } },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const fetchForgejoReviewComments = (
  owner: string,
  repo: string,
  number: string,
  id: number,
  signal?: AbortSignal
) =>
  read(
    pull.reviews[":review"].comments.$get(
      { param: { ...pullParam(owner, repo, number), review: String(id) } },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

/** What opendevhub links to a pull request: the task that made it, its checkouts and its AI reviews. */
export const fetchPullLinks = (url: string, signal?: AbortSignal) =>
  read(
    api.links.pull.$get(
      { query: { url } },
      { init: { cache: "no-store", signal } }
    ),
    "pull request links"
  );

/** A page of the event feed, newest first; `before` is the previous page's `next`. */
export const fetchActivity = (
  filter: ActivityFilter,
  before?: number,
  signal?: AbortSignal
) =>
  read(
    api.activity.$get(
      {
        query: {
          ...(filter.projectId ? { project: filter.projectId } : {}),
          ...(filter.taskId ? { task: filter.taskId } : {}),
          ...(filter.entity
            ? { entity: `${filter.entity.type}:${filter.entity.id}` }
            : {}),
          ...(before === undefined ? {} : { before: String(before) }),
        },
      },
      { init: { cache: "no-store", signal } }
    ),
    "activity"
  );

/** Where an entity came from and what it led to. */
export const fetchProvenance = (
  type: ObjectType,
  id: string,
  signal?: AbortSignal
) =>
  read(
    api.provenance[":type"][":id"].$get(
      { param: { id: encodeURIComponent(id), type } },
      { init: { cache: "no-store", signal } }
    ),
    "provenance"
  );

/** The tasks started from a ticket and their pull requests. */
export const fetchTicketLinks = (
  instance: string,
  key: string,
  signal?: AbortSignal
) =>
  read(
    api.links.ticket.$get(
      { query: { instance, key } },
      { init: { cache: "no-store", signal } }
    ),
    "ticket links"
  );

export const fetchForgejoChecks = (
  owner: string,
  repo: string,
  sha: string,
  page: number,
  signal?: AbortSignal
) =>
  read(
    api.forgejo.checks[":owner"][":repo"][":sha"].$get(
      {
        param: {
          owner: encodeURIComponent(owner),
          repo: encodeURIComponent(repo),
          sha: encodeURIComponent(sha),
        },
        query: { page: String(page) },
      },
      { init: { cache: "no-store", signal } }
    ),
    "Forgejo request"
  );

export const testForgejoConnection = (input: { url: string; token?: string }) =>
  read(api.forgejo.test.$post({ json: input }), "test Forgejo connection");

export const fetchJiraSettings = () =>
  read(
    api.jira.settings.$get(undefined, { init: { cache: "no-store" } }),
    "Jira settings"
  );

export const saveJiraSettings = (input: JiraSettingsInput) =>
  read(api.jira.settings.$post({ json: input }), "save Jira settings");

export const fetchJiraPresets = (signal?: AbortSignal) =>
  read(
    api.jira.presets.$get(undefined, { init: { cache: "no-store", signal } }),
    "Filter presets"
  );

export const createJiraPreset = (name: string, filters: JiraPresetFilters) =>
  read(api.jira.presets.$post({ json: { filters, name } }), "Save preset");

export const updateJiraPreset = (
  id: number,
  changes: { name?: string; filters?: JiraPresetFilters }
) =>
  read(
    api.jira.presets[":id"].$put({ json: changes, param: { id: String(id) } }),
    "Update preset"
  );

export const removeJiraPreset = async (id: number) => {
  await complete(
    api.jira.presets[":id"].$delete({ param: { id: String(id) } }),
    "Delete preset"
  );
};

export const fetchJiraTickets = (
  query: Partial<JiraTicketQuery> = {},
  signal?: AbortSignal
) =>
  read(
    api.jira.tickets.$get(
      { query: jiraQueryValues(query) },
      { init: { cache: "no-store", signal } }
    ),
    "Jira tickets"
  );

export const fetchJiraCatalog = (signal?: AbortSignal) =>
  read(
    api.jira.catalog.$get(undefined, { init: { cache: "no-store", signal } }),
    "Jira boards and filters"
  );

export const fetchJiraBoardColumns = (board: number, signal?: AbortSignal) =>
  read(
    api.jira.boards[":id"].columns.$get(
      { param: { id: String(board) } },
      { init: { cache: "no-store", signal } }
    ),
    "Jira board columns"
  );

export const fetchJiraTicket = (key: string, signal?: AbortSignal) =>
  read(
    api.jira.tickets[":key"].$get(
      { param: { key: encodeURIComponent(key) } },
      { init: { cache: "no-store", signal } }
    ),
    "Jira ticket"
  );

export const postAction = async (projectId: string, action: Action) => {
  await complete(
    project[action].$post({ param: projectParam(projectId) }),
    action
  );
};

export const createWorktree = (
  projectId: string,
  req: {
    branch: string;
    base?: string;
    startSession?: boolean;
    prompt?: string;
  }
) =>
  read(
    project.worktrees.$post({ param: projectParam(projectId), json: req }),
    "create worktree"
  );

export const fetchModels = (projectId: string) =>
  read(project.models.$get({ param: projectParam(projectId) }), "models");

export const createTask = (projectId: string, req: NewTaskBody) =>
  read(
    project.tasks.$post({ param: projectParam(projectId), json: req }),
    "start task"
  );

export const pickVariant = (
  projectId: string,
  task: string,
  sessionId: string,
  removeWorktrees: boolean
) =>
  read(
    project.tasks[":task"].pick.$post({
      param: { ...projectParam(projectId), task: encodeURIComponent(task) },
      json: { removeWorktrees, sessionId },
    }),
    "pick variant"
  );

export const removeWorktree = (
  projectId: string,
  path: string,
  force: boolean,
  deleteBranch = false
) =>
  read(
    project.worktrees.remove.$post({
      param: projectParam(projectId),
      json: { deleteBranch, force, path },
    }),
    "remove worktree"
  );

/** The project's branches, with their base, creator, published remote and pull request; deleted ones included. */
export const fetchBranches = (projectId: string) =>
  read(
    project.branches.$get(
      { param: projectParam(projectId) },
      { init: { cache: "no-store" } }
    ),
    "branches"
  );

export const refreshWorktrees = (projectId: string) =>
  read(
    project.worktrees.refresh.$post({ param: projectParam(projectId) }),
    "refresh worktrees"
  );

export const startSession = async (
  projectId: string,
  directory: string,
  title?: string,
  prompt?: string
) => {
  const created = await read(
    project.sessions.$post({
      param: projectParam(projectId),
      json: { directory, prompt, title },
    }),
    "start session"
  );
  return created;
};

export const openInEditor = (
  projectId: string,
  editor: string,
  directory: string
) =>
  read(
    project.open.$post({
      param: projectParam(projectId),
      json: { directory, editor },
    }),
    "open editor"
  );

export const replyPermission = (
  projectId: string,
  requestId: string,
  decision: PermissionDecision,
  message?: string
) =>
  reply(
    project.permissions[":rid"].$post({
      param: { ...projectParam(projectId), rid: encodeURIComponent(requestId) },
      json: { decision, message },
    }),
    "reply"
  );

export const replyForm = (
  projectId: string,
  formId: string,
  answer: FormAnswer
) =>
  reply(
    project.forms[":fid"].$post({
      param: { ...projectParam(projectId), fid: encodeURIComponent(formId) },
      json: { answer },
    }),
    "answer"
  );

/** Cancels a form. opencode takes no reason, so there is none to send. */
export const dismissForm = (projectId: string, formId: string) =>
  reply(
    project.forms[":fid"].$delete({
      param: { ...projectParam(projectId), fid: encodeURIComponent(formId) },
    }),
    "dismiss"
  );

export const fetchReview = (
  projectId: string,
  directory: string,
  opts: {
    base?: string;
    mode?: ReviewMode;
    file?: string;
    /** Turn mode: the session and the prompt whose turn to show; the checkout's latest session and turn by default. */
    session?: string;
    from?: string;
  } = {},
  signal?: AbortSignal
) =>
  read(
    project.review.$get(
      {
        param: projectParam(projectId),
        query: {
          directory,
          ...(opts.base ? { base: opts.base } : {}),
          ...(opts.mode ? { mode: opts.mode } : {}),
          ...(opts.file ? { file: opts.file } : {}),
          ...(opts.session ? { session: opts.session } : {}),
          ...(opts.from ? { from: opts.from } : {}),
        },
      },
      { init: { signal } }
    ),
    "review"
  );

export const startLocalAiReview = async (
  projectId: string,
  input: { directory: string; mode: "working" | "branch"; base?: string }
) => {
  const result = await read(
    project.review["ai-session"].$post({
      param: projectParam(projectId),
      json: input,
    }),
    "start AI review"
  );
  return result.sessionId;
};

export const collectLocalAiReview = (
  projectId: string,
  directory: string,
  sessionId: string
) =>
  read(
    project.review["ai-findings"].$post({
      param: projectParam(projectId),
      json: { directory, sessionId },
    }),
    "collect AI review"
  );

export const runLocalOcrReview = (
  projectId: string,
  input: {
    directory: string;
    mode: "working" | "branch";
    base?: string;
    runId?: string;
  }
) =>
  read(
    project.review.ocr.$post({ param: projectParam(projectId), json: input }),
    "Open Code Review"
  );

/** Where the review loads one version of a changed image in a checkout. */
export const reviewImageUrl = (
  projectId: string,
  directory: string,
  opts: { file: string; side: ImageSide; mode?: ReviewMode; base?: string }
) =>
  project.review.image.$path({
    param: projectParam(projectId),
    query: {
      directory,
      file: opts.file,
      side: opts.side,
      ...(opts.base ? { base: opts.base } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
    },
  });

export const suggestCommitMessage = async (
  projectId: string,
  directory: string
) => {
  const suggested = await read(
    project.review["commit-message"].$post({
      param: projectParam(projectId),
      json: { directory },
    }),
    "commit message"
  );
  return suggested.message;
};

export const commitChanges = async (
  projectId: string,
  directory: string,
  message: string
) => {
  await complete(
    project.review.commit.$post({
      param: projectParam(projectId),
      json: { directory, message },
    }),
    "commit"
  );
};

export const updateFromBase = (
  projectId: string,
  directory: string,
  base: string
) =>
  read(
    project.review.update.$post({
      param: projectParam(projectId),
      json: { base, directory },
    }),
    "update from base"
  );

export const mergeIntoBase = (
  projectId: string,
  directory: string,
  base: string,
  ffOnly: boolean
) =>
  read(
    project.review.merge.$post({
      param: projectParam(projectId),
      json: { base, directory, ffOnly },
    }),
    "merge into base"
  );

export const bringHome = (projectId: string, directory: string) =>
  read(
    project.review["bring-home"].$post({
      param: projectParam(projectId),
      json: { directory },
    }),
    "bring home"
  );

export const sendPrompt = async (
  projectId: string,
  sessionId: string,
  text: string
) => {
  await complete(
    project.sessions[":sid"].prompt.$post({
      param: { ...projectParam(projectId), sid: encodeURIComponent(sessionId) },
      json: { text },
    }),
    "send to agent"
  );
};

/** Starts a chat from Chat's start composer, in a new worktree or one of the project's checkouts. */
export const startChat = (projectId: string, request: ChatStartRequest) =>
  read(
    project.chat.$post({ param: projectParam(projectId), json: request }),
    "start chat"
  );

const chatParam = (projectId: string, chat: string) => ({
  ...projectParam(projectId),
  chat: encodeURIComponent(chat),
});

/** A chat the snapshot doesn't list (archived, removed, or not yet listed), or the task that adopted it. */
export const fetchChat = (projectId: string, chat: string) =>
  read(
    project.chats[":chat"].$get({ param: chatParam(projectId, chat) }),
    "chat"
  );

/** Hides a chat from every list; its conversation keeps running. */
export const archiveChat = async (projectId: string, chat: string) => {
  await complete(
    project.chats[":chat"].archive.$post({ param: chatParam(projectId, chat) }),
    "archive chat"
  );
};

/** Make task's brief, drafted from the chat's own conversation without adding to it. */
export const fetchChatBrief = (
  projectId: string,
  chat: string,
  signal?: AbortSignal
) =>
  read(
    project.chats[":chat"].brief.$get(
      { param: chatParam(projectId, chat) },
      { init: { signal } }
    ),
    "draft the brief"
  );

/** The ticket keys and pull requests Make task suggests for a chat. */
export const fetchChatSuggestions = (projectId: string, chat: string) =>
  read(
    project.chats[":chat"].suggestions.$get({
      param: chatParam(projectId, chat),
    }),
    "suggestions"
  );

/** Makes a task of a chat in a worktree: the task adopts it as variant 1. */
export const makeTask = (
  projectId: string,
  chat: string,
  body: MakeTaskRequest
) =>
  read(
    project.chats[":chat"].task.$post({
      param: chatParam(projectId, chat),
      json: body,
    }),
    "make task"
  );

/** Saves a task as a draft: nothing runs until it starts. */
export const createDraft = (projectId: string, req: NewTaskBody) =>
  read(
    project.drafts.$post({ param: projectParam(projectId), json: req }),
    "save draft"
  );

/** A draft from a Jira ticket, titled from it with its description as the brief. */
export const draftFromTicket = (projectId: string, jira: JiraTaskSource) =>
  read(
    project.drafts.ticket.$post({
      param: projectParam(projectId),
      json: { jira },
    }),
    "create draft"
  );

/** Changes a draft without starting it. */
export const editDraft = async (
  projectId: string,
  task: string,
  req: NewTaskBody
) => {
  await complete(
    project.tasks[":task"].draft.$put({
      param: { ...projectParam(projectId), task: encodeURIComponent(task) },
      json: req,
    }),
    "save draft"
  );
};

/** Starts a draft: its variants are added to the same task. */
export const startDraft = (projectId: string, task: string, req: NewTaskBody) =>
  read(
    project.tasks[":task"].start.$post({
      param: { ...projectParam(projectId), task: encodeURIComponent(task) },
      json: req,
    }),
    "start task"
  );

/** Sends what the composer holds; the hub decides whether it's a hub command, an opencode command or a prompt. */
export const sendComposerMessage = (
  projectId: string,
  sessionId: string,
  message: ComposerSendRequest
) =>
  read(
    project.sessions[":sid"].send.$post({
      param: { ...projectParam(projectId), sid: encodeURIComponent(sessionId) },
      json: message,
    }),
    "send to agent"
  );

export const startTaskConversation = (projectId: string, sessionId: string) =>
  read(
    project.sessions[":sid"]["task-conversation"].$post({
      param: { ...projectParam(projectId), sid: encodeURIComponent(sessionId) },
    }),
    "start task conversation"
  );

export const archiveTaskConversation = async (
  projectId: string,
  sessionId: string
) => {
  await complete(
    project.sessions[":sid"].archive.$post({
      param: { ...projectParam(projectId), sid: encodeURIComponent(sessionId) },
    }),
    "close task conversation"
  );
};

/** The `/` suggestions of a checkout: the hub's commands and opencode's. */
export const fetchComposerCommands = (projectId: string, directory: string) =>
  read(
    project.composer.commands.$get({
      param: projectParam(projectId),
      query: { directory },
    }),
    "list commands"
  );

/** The agents `@` can mention in a checkout. */
export const fetchComposerAgents = (projectId: string, directory: string) =>
  read(
    project.composer.agents.$get({
      param: projectParam(projectId),
      query: { directory },
    }),
    "list agents"
  );

/** Files in a checkout matching `query`, best first and capped by the hub. */
export const searchComposerFiles = (
  projectId: string,
  directory: string,
  query: string,
  signal?: AbortSignal
) =>
  read(
    project.composer.files.$get(
      { param: projectParam(projectId), query: { directory, query } },
      { init: { signal } }
    ),
    "search files"
  );

/** Deletes a session with its subagent sessions, stopping it first if it's busy. */
export const removeSession = async (projectId: string, sessionId: string) => {
  await complete(
    project.sessions[":sid"].$delete({
      param: { ...projectParam(projectId), sid: encodeURIComponent(sessionId) },
    }),
    "remove session"
  );
};

/** Kills a shell command the session left running in the background. */
export const killShell = async (
  projectId: string,
  sessionId: string,
  shellId: string
) => {
  await complete(
    project.sessions[":sid"].shells[":shid"].$delete({
      param: {
        ...projectParam(projectId),
        sid: encodeURIComponent(sessionId),
        shid: encodeURIComponent(shellId),
      },
    }),
    "stop the command"
  );
};

/** A session's turns, token usage and subagents. */
export const fetchSessionDetail = (projectId: string, sessionId: string) =>
  read(
    project.sessions[":sid"].$get({
      param: { ...projectParam(projectId), sid: encodeURIComponent(sessionId) },
    }),
    "load the session"
  );

export const rescan = () => read(api.projects.rescan.$post(), "rescan");

/** Replaces the folders scanned for projects; the server rescans before answering. */
export const saveRoots = (roots: string[]) =>
  read(api.settings.roots.$post({ json: { roots } }), "save folders");

/** A blank name goes back to the project's folder name. */
/** `team` saves the name to devcontainer.json for everyone; a blank name goes back to the team's or the folder's. */
export const renameProject = async (
  projectId: string,
  name: string,
  scope: SettingsScope = "personal"
) => {
  await complete(
    project.name.$post({
      json: { name, scope },
      param: projectParam(projectId),
    }),
    "rename project"
  );
};

export const saveProjectAppearance = (
  projectId: string,
  appearance: { shortName: string; color: ProjectColor | "" },
  scope: SettingsScope = "personal"
) =>
  read(
    project.appearance.$post({
      json: { ...appearance, scope },
      param: projectParam(projectId),
    }),
    "save project appearance"
  );

/** The project's shareable settings as devcontainer.json and the user's own settings each have them. */
export const fetchProjectTeam = (projectId: string, signal?: AbortSignal) =>
  read(
    project["team-settings"].$get(
      { param: projectParam(projectId) },
      { init: { cache: "no-store", signal } }
    ),
    "team settings"
  );

export const fetchProjectPorts = (projectId: string, signal?: AbortSignal) =>
  read(
    project.ports.$get(
      { param: projectParam(projectId) },
      { init: { signal } }
    ),
    "project ports"
  );

/**
 * Saves the ports the project forwards on top of devcontainer.json's, and forwards them right away. With
 * `team`, replaces devcontainer.json's own instead.
 */
export const saveProjectPorts = (
  projectId: string,
  ports: number[],
  scope: SettingsScope = "personal"
) =>
  read(
    project.ports.$post({
      param: projectParam(projectId),
      json: { ports, scope },
    }),
    "save project ports"
  );

export const fetchProjectHostPorts = (
  projectId: string,
  signal?: AbortSignal
) =>
  read(
    project["host-ports"].$get(
      { param: projectParam(projectId) },
      { init: { signal } }
    ),
    "project host ports"
  );

/** Saves the ports on this machine the project's containers reach, and applies them right away. */
export const saveProjectHostPorts = (projectId: string, ports: number[]) =>
  read(
    project["host-ports"].$post({
      json: { ports },
      param: projectParam(projectId),
    }),
    "save project host ports"
  );

export const fetchProjectLinks = (projectId: string, signal?: AbortSignal) =>
  read(
    project.links.$get(
      { param: projectParam(projectId) },
      { init: { signal } }
    ),
    "project links"
  );

/** Links the project to a Jira board and a Forgejo repository; a link left out is removed. */
export const saveProjectLinks = (
  projectId: string,
  links: ProjectLinks,
  scope: SettingsScope = "personal"
) =>
  read(
    project.links.$post({
      json: { ...links, scope },
      param: projectParam(projectId),
    }),
    "save project links"
  );

export const fetchTodos = (projectId: string, signal?: AbortSignal) =>
  read(
    project.todos.$get(
      { param: projectParam(projectId) },
      { init: { cache: "no-store", signal } }
    ),
    "to-do list"
  );

export const addTodo = (projectId: string, text: string) =>
  read(
    project.todos.$post({ json: { text }, param: projectParam(projectId) }),
    "add to-do"
  );

export const updateTodo = (
  projectId: string,
  id: number,
  changes: { text?: string; done?: boolean }
) =>
  read(
    project.todos[":todo"].$patch({
      json: changes,
      param: { ...projectParam(projectId), todo: String(id) },
    }),
    "update to-do"
  );

export const removeTodo = async (projectId: string, id: number) => {
  await complete(
    project.todos[":todo"].$delete({
      param: { ...projectParam(projectId), todo: String(id) },
    }),
    "delete to-do"
  );
};

export const fetchGitSetup = () =>
  read(
    api.settings.git.$get(undefined, { init: { cache: "no-store" } }),
    "git settings"
  );

export const testSshHost = (host: string) =>
  read(api.settings.git.test.$post({ json: { host } }), "test ssh connection");

export const fetchUsage = (day?: string) =>
  read(api.usage.$get({ query: day ? { day } : {} }), "usage");

export const fetchLogs = async (projectId: string) => {
  const data = await read(
    project.logs.$get({ param: projectParam(projectId) }),
    "logs"
  );
  return data.lines;
};

export const fetchPublishInfo = (
  projectId: string,
  directory: string,
  remote?: string,
  signal?: AbortSignal
) =>
  read(
    project.publish.$get(
      {
        param: projectParam(projectId),
        query: { directory, ...(remote ? { remote } : {}) },
      },
      { init: { signal } }
    ),
    "publish info"
  );

export const suggestPublish = (projectId: string, directory: string) =>
  read(
    project.publish.suggest.$post({
      param: projectParam(projectId),
      json: { directory },
    }),
    "suggest"
  );

export const publishChanges = (
  projectId: string,
  directory: string,
  req: PublishRequest
) =>
  read(
    project.publish.$post({
      param: projectParam(projectId),
      json: { directory, ...req },
    }),
    "publish"
  );

export const fetchChecks = (
  projectId: string,
  directory?: string,
  signal?: AbortSignal
) =>
  read(
    project.checks.$get(
      {
        param: projectParam(projectId),
        query: directory === undefined ? {} : { directory },
      },
      { init: { signal } }
    ),
    "checks"
  );

/** A checkout's OpenSpec changes, showing `change` or the one the server picks. */
export const fetchSpec = (
  projectId: string,
  directory: string,
  change?: string,
  signal?: AbortSignal
) =>
  read(
    project.spec.$get(
      {
        param: projectParam(projectId),
        query: { directory, ...(change ? { change } : {}) },
      },
      { init: { signal } }
    ),
    "spec"
  );

/** Sends review feedback on a change to the checkout's spec-first task, which runs `/opsx-update`. */
export const reviseSpec = async (
  projectId: string,
  body: { directory: string; change: string; feedback: string }
) => {
  await complete(
    project.spec.revise.$post({ param: projectParam(projectId), json: body }),
    "send the comments"
  );
};

/** Approves the checkout's proposed change; its spec-first task then runs `/opsx-apply`. */
export const approveSpec = async (
  projectId: string,
  body: {
    directory: string;
    change: string;
    force?: boolean;
    newConversation?: boolean;
  }
) => {
  await complete(
    project.spec.approve.$post({ param: projectParam(projectId), json: body }),
    "approve the spec"
  );
};

/** Approves the checkout's proposed change and implements it in a new task, one worktree per variant. */
export const implementSpec = (
  projectId: string,
  body: {
    directory: string;
    change: string;
    variants: TaskVariantSpec[];
    force?: boolean;
  }
) =>
  read(
    project.spec.implement.$post({
      param: projectParam(projectId),
      json: body,
    }),
    "implement the spec"
  );

/** Archives the checkout's implemented change with `openspec archive`, updating its main specs. */
export const archiveSpec = async (
  projectId: string,
  body: { directory: string; change: string }
) => {
  await complete(
    project.spec.archive.$post({ param: projectParam(projectId), json: body }),
    "archive the change"
  );
};

export const fetchCheckRun = async (
  projectId: string,
  directory: string,
  signal?: AbortSignal
) => {
  const data = await read(
    project.checks.run.$get(
      { param: projectParam(projectId), query: { directory } },
      { init: { signal } }
    ),
    "checks"
  );
  return data.run;
};

/** Runs all checks, or the named ones; `approve` lists host commands the user just approved. */
export const runChecks = (
  projectId: string,
  directory: string,
  opts: { names?: string[]; approve?: string[] } = {}
) =>
  read(
    project.checks.run.$post({
      param: projectParam(projectId),
      json: { directory, ...opts },
    }),
    "run checks"
  );

/** Saves the project's own list of checks, or goes back to devcontainer.json's with null. */
/** Saves the user's own checks (null removes them), or with `team` the team's list in devcontainer.json. */
export const saveChecks = (
  projectId: string,
  checks: CheckOverlay[] | null,
  scope: SettingsScope = "personal"
) =>
  read(
    project.checks.settings.$post({
      param: projectParam(projectId),
      json: { checks, scope },
    }),
    "save checks"
  );

export const subscribe = (handlers: {
  onSnapshot: (s: DashboardSnapshot) => void;
  onLog: (e: LogEvent) => void;
  onConnection: (connected: boolean) => void;
}): (() => void) => {
  const source = new EventSource(api.events.$path());
  source.addEventListener("snapshot", (e) =>
    handlers.onSnapshot(JSON.parse((e as MessageEvent<string>).data))
  );
  source.addEventListener("log", (e) =>
    handlers.onLog(JSON.parse((e as MessageEvent<string>).data))
  );
  source.onopen = () => handlers.onConnection(true);
  source.onerror = () => handlers.onConnection(false);
  return () => source.close();
};

export const createEnv = (projectId: string, path: string) =>
  read(
    project.envs.$post({ param: projectParam(projectId), json: { path } }),
    "create container"
  );

export const envAction = async (
  projectId: string,
  envId: string,
  action: Action
) => {
  await complete(
    project.envs[":env"][action].$post({
      param: { ...projectParam(projectId), env: encodeURIComponent(envId) },
    }),
    `${action} container`
  );
};

export const removeEnv = (projectId: string, envId: string) =>
  read(
    project.envs[":env"].remove.$post({
      param: { ...projectParam(projectId), env: encodeURIComponent(envId) },
    }),
    "remove container"
  );

export const fetchCandidates = () =>
  read(api.onboarding.candidates.$get(), "list repos");

export const addProject = (path: string, stack: StackId) =>
  read(api.onboarding.$post({ json: { path, stack } }), "add project");

export const fetchCleanup = () => read(api.cleanup.$get(), "cleanup scan");

export const applyCleanup = (items: CleanupItem[]) =>
  read(api.cleanup.$post({ json: { items } }), "cleanup");

export const addNode = (ssh: string, label?: string) =>
  read(
    api.nodes.$post({ json: { ssh, ...(label ? { label } : {}) } }),
    "add node"
  );

export const removeNode = async (id: string) => {
  await complete(
    api.nodes[":id"].$delete({ param: { id: encodeURIComponent(id) } }),
    "remove node"
  );
};

/** Forgets a starting task's variants that failed. */
export const dismissStarting = async (projectId: string, task: string) => {
  await complete(
    project.tasks[":task"].starting.$delete({
      param: { ...projectParam(projectId), task: encodeURIComponent(task) },
    }),
    "dismiss"
  );
};

/** Hides a task from the dashboard; its sessions and worktrees stay. */
export const archiveTask = async (projectId: string, task: string) => {
  await complete(
    project.tasks[":task"].archive.$post({
      param: { ...projectParam(projectId), task: encodeURIComponent(task) },
    }),
    "archive task"
  );
};

export const fetchArchivedTasks = (projectId: string) =>
  read(
    project.tasks.archived.$get(
      { param: projectParam(projectId) },
      { init: { cache: "no-store" } }
    ),
    "archived tasks"
  );

export const restoreTask = async (projectId: string, task: string) => {
  await complete(
    project.tasks[":task"].restore.$post({
      param: { ...projectParam(projectId), task: encodeURIComponent(task) },
    }),
    "restore task"
  );
};

export const deleteArchivedTask = async (projectId: string, task: string) => {
  await complete(
    project.tasks[":task"].$delete({
      param: { ...projectParam(projectId), task: encodeURIComponent(task) },
    }),
    "delete task"
  );
};

export const sendForgejoReview = async (
  owner: string,
  repo: string,
  number: string,
  input: ForgejoReviewInput
) => {
  await complete(
    pull.reviews.$post({ param: pullParam(owner, repo, number), json: input }),
    "send review"
  );
};

export const createForgejoWorktree = (
  owner: string,
  repo: string,
  number: string,
  projectId: string,
  commitId: string
) =>
  read(
    pull.worktree.$post({
      param: pullParam(owner, repo, number),
      json: { commitId, projectId },
    }),
    "create PR worktree"
  );

/** Where a pull request's review loads one version of a changed image. */
export const forgejoImageUrl = (
  owner: string,
  repo: string,
  number: string,
  file: string,
  side: ImageSide
) =>
  pull.image.$path({
    param: pullParam(owner, repo, number),
    query: { file, side },
  });

/** Starts a session that reviews the pull request in a checkout of it; collect its findings once it is idle. */
export const startAiReviewSession = async (
  owner: string,
  repo: string,
  number: string,
  input: { projectId: string; directory: string; commitId: string }
) => {
  const data = await read(
    pull["ai-review"].session.$post({
      param: pullParam(owner, repo, number),
      json: input,
    }),
    "start AI review"
  );
  return data.sessionId;
};

/** Findings from a finished review session, or without one, from the diff alone. */
export const collectAiReview = (
  owner: string,
  repo: string,
  number: string,
  input: {
    projectId: string;
    directory: string;
    commitId: string;
    sessionId?: string;
  }
) =>
  read(
    pull["ai-review"].$post({
      param: pullParam(owner, repo, number),
      json: input,
    }),
    "collect AI review"
  );

export const fetchOcrSettings = (signal?: AbortSignal) =>
  read(
    api.ocr.settings.$get(undefined, { init: { cache: "no-store", signal } }),
    "Open Code Review settings"
  );

export const saveOcrSettings = (input: OcrSettingsInput) =>
  read(
    api.ocr.settings.$put({ json: input }),
    "save Open Code Review settings"
  );

/** Runs `ocr llm test` on this machine with the form's values; a missing key falls back to the saved one. */
export const testOcrConnection = (input: OcrTestInput) =>
  read(
    api.ocr.settings.test.$post({ json: input }),
    "test Open Code Review connection"
  );

/** The active provider of this machine's `~/.opencodereview/config.json`, to fill the form with. */
export const importOcrConfig = () =>
  read(api.ocr.settings.import.$post(), "import Open Code Review config");

export const fetchProjectOcr = (projectId: string, signal?: AbortSignal) =>
  read(
    project.ocr.$get(
      { param: projectParam(projectId) },
      { init: { cache: "no-store", signal } }
    ),
    "project Open Code Review settings"
  );

export const saveProjectOcr = (projectId: string, input: OcrProjectInput) =>
  read(
    project.ocr.$put({ json: input, param: projectParam(projectId) }),
    "save project Open Code Review settings"
  );

/** Copies the bundled `ocr` into the checkout's environment unless it has it. */
export const installOcr = (input: { projectId: string; directory: string }) =>
  read(api.ocr.install.$post({ json: input }), "install Open Code Review");

/** Runs Open Code Review on the pull request's head commit in a checkout; the review is stored before it answers. */
export const runOcrReview = (
  owner: string,
  repo: string,
  number: string,
  input: {
    projectId: string;
    directory: string;
    commitId: string;
    runId?: string;
  }
) =>
  read(
    pull["ocr-review"].$post({
      param: pullParam(owner, repo, number),
      json: input,
    }),
    "Open Code Review"
  );

export const fetchOcrLog = (id: string) =>
  read(
    api.ocr.runs[":id"].logs.$get({ param: { id } }),
    "Open Code Review progress"
  );

/** What the user adds to every project's containers: features, a setup command and dotfiles. */
export const fetchPersonalization = (signal?: AbortSignal) =>
  read(
    api.settings.personalization.$get(undefined, {
      init: { cache: "no-store", signal },
    }),
    "personalization settings"
  );

export const savePersonalization = (input: Personalization) =>
  read(
    api.settings.personalization.$put({ json: input }),
    "save personalization settings"
  );

export const fetchProjectPersonalization = (
  projectId: string,
  signal?: AbortSignal
) =>
  read(
    project.personalization.$get(
      { param: projectParam(projectId) },
      { init: { cache: "no-store", signal } }
    ),
    "project personalization"
  );

export const saveProjectPersonalization = (
  projectId: string,
  input: ProjectPersonalization
) =>
  read(
    project.personalization.$put({
      json: input,
      param: projectParam(projectId),
    }),
    "save project personalization"
  );
