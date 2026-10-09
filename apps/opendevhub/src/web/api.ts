import type {
  AiReviewResult,
  ForgejoApprovals,
  ForgejoReviewInput,
  ForgejoChecks,
  ForgejoComment,
  ForgejoConnection,
  ForgejoPage,
  ForgejoPullDetails,
  ForgejoPullFilter,
  ForgejoPullQuery,
  ForgejoOrganizations,
  ForgejoPulls,
  ForgejoReview,
  ForgejoSettings,
  ForgejoSettingsInput,
  ForgejoTeams,
} from "../shared/forgejo";
import type { ImageSide } from "../shared/images";
import { jiraQueryParams } from "../shared/jira";
import type {
  JiraBoardColumn,
  JiraCatalog,
  JiraSettings,
  JiraSettingsInput,
  JiraTicket,
  JiraTicketQuery,
  JiraTickets,
} from "../shared/jira";
import type { StackId } from "../shared/stacks";
import type {
  AddProjectResult,
  CandidateList,
  CheckDef,
  CheckRun,
  ChecksConfig,
  ChecksView,
  CleanupItem,
  CleanupPlan,
  CleanupResult,
  DashboardSnapshot,
  FormAnswer,
  LogEvent,
  ModelsInfo,
  NodeView,
  PermissionDecision,
  PickResult,
  PublishInfo,
  PublishRequest,
  PublishResult,
  ReviewData,
  ReviewMode,
  SessionDetail,
  TaskRequest,
  TaskResult,
  UpdateResult,
  UsageReport,
  Worktree,
} from "../shared/types";

export type Action =
  | "start"
  | "stop"
  | "rebuild"
  | "rebuild-no-cache"
  | "restart-opencode";

const failure = async (res: Response, what: string): Promise<Error> => {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `${what} failed (${res.status})`);
};

export const fetchForgejoSettings = async (): Promise<ForgejoSettings> => {
  const res = await fetch("/api/forgejo/settings", { cache: "no-store" });
  if (!res.ok) {
    throw await failure(res, "Forgejo settings");
  }
  return res.json();
};

export const saveForgejoSettings = async (
  input: ForgejoSettingsInput
): Promise<ForgejoSettings> => {
  const res = await fetch("/api/forgejo/settings", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "save Forgejo settings");
  }
  return res.json();
};

export const fetchForgejoPulls = (
  input: ForgejoPullQuery | ForgejoPullFilter = "all",
  signal?: AbortSignal
): Promise<ForgejoPulls> => {
  const options = typeof input === "string" ? { state: input } : input;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  return forgejoGet(`pulls?${query}`, signal);
};
export const fetchForgejoOrganizations = (
  signal?: AbortSignal
): Promise<ForgejoOrganizations> => forgejoGet("orgs", signal);
export const fetchForgejoTeams = (
  org: string,
  signal?: AbortSignal
): Promise<ForgejoTeams> =>
  forgejoGet(`orgs/${encodeURIComponent(org)}/teams`, signal);

const forgejoPullRoute = (owner: string, repo: string, number: string) =>
  `pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
const forgejoGet = async <T>(
  route: string,
  signal?: AbortSignal
): Promise<T> => {
  const res = await fetch(`/api/forgejo/${route}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw await failure(res, "Forgejo request");
  }
  return res.json();
};
export const fetchForgejoDetails = (
  owner: string,
  repo: string,
  number: string,
  signal?: AbortSignal
): Promise<ForgejoPullDetails> =>
  forgejoGet(forgejoPullRoute(owner, repo, number), signal);
export const fetchForgejoDiff = (
  owner: string,
  repo: string,
  number: string,
  signal?: AbortSignal
): Promise<{ patch: string }> =>
  forgejoGet(`${forgejoPullRoute(owner, repo, number)}/patch`, signal);
export const fetchForgejoApprovals = (
  owner: string,
  repo: string,
  number: string,
  signal?: AbortSignal
): Promise<ForgejoApprovals> =>
  forgejoGet(`${forgejoPullRoute(owner, repo, number)}/approvals`, signal);
export const fetchForgejoComments = (
  owner: string,
  repo: string,
  number: string,
  page: number,
  signal?: AbortSignal
): Promise<ForgejoPage<ForgejoComment>> =>
  forgejoGet(
    `${forgejoPullRoute(owner, repo, number)}/comments?page=${page}`,
    signal
  );
export const fetchForgejoReviews = (
  owner: string,
  repo: string,
  number: string,
  page: number,
  signal?: AbortSignal
): Promise<ForgejoPage<ForgejoReview>> =>
  forgejoGet(
    `${forgejoPullRoute(owner, repo, number)}/reviews?page=${page}`,
    signal
  );
export const fetchForgejoReviewComments = (
  owner: string,
  repo: string,
  number: string,
  id: number,
  signal?: AbortSignal
): Promise<ForgejoComment[]> =>
  forgejoGet(
    `${forgejoPullRoute(owner, repo, number)}/reviews/${id}/comments`,
    signal
  );
export const fetchForgejoChecks = (
  owner: string,
  repo: string,
  sha: string,
  page: number,
  signal?: AbortSignal
): Promise<ForgejoChecks> =>
  forgejoGet(
    `checks/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}?page=${page}`,
    signal
  );
export const testForgejoConnection = async (input: {
  url: string;
  token?: string;
}): Promise<ForgejoConnection> => {
  const res = await fetch("/api/forgejo/test", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "test Forgejo connection");
  }
  return res.json();
};

export const fetchJiraSettings = async (): Promise<JiraSettings> => {
  const res = await fetch("/api/jira/settings", { cache: "no-store" });
  if (!res.ok) {
    throw await failure(res, "Jira settings");
  }
  return res.json();
};

export const saveJiraSettings = async (
  input: JiraSettingsInput
): Promise<JiraSettings> => {
  const res = await fetch("/api/jira/settings", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "save Jira settings");
  }
  return res.json();
};

export const fetchJiraTickets = async (
  query: Partial<JiraTicketQuery> = {},
  signal?: AbortSignal
): Promise<JiraTickets> => {
  const params = jiraQueryParams(query);
  const res = await fetch(
    `/api/jira/tickets${params.size ? `?${params}` : ""}`,
    { cache: "no-store", signal }
  );
  if (!res.ok) {
    throw await failure(res, "Jira tickets");
  }
  return res.json();
};

export const fetchJiraCatalog = async (
  signal?: AbortSignal
): Promise<JiraCatalog> => {
  const res = await fetch("/api/jira/catalog", { cache: "no-store", signal });
  if (!res.ok) {
    throw await failure(res, "Jira boards and filters");
  }
  return res.json();
};

export const fetchJiraBoardColumns = async (
  board: number,
  signal?: AbortSignal
): Promise<JiraBoardColumn[]> => {
  const res = await fetch(`/api/jira/boards/${board}/columns`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw await failure(res, "Jira board columns");
  }
  return res.json();
};

export const fetchJiraTicket = async (
  key: string,
  signal?: AbortSignal
): Promise<JiraTicket> => {
  const res = await fetch(`/api/jira/tickets/${encodeURIComponent(key)}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw await failure(res, "Jira ticket");
  }
  return res.json();
};

export const postAction = async (
  projectId: string,
  action: Action
): Promise<void> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${action}`,
    { method: "POST" }
  );
  if (!res.ok) {
    throw await failure(res, action);
  }
};

const postJson = async <T>(
  projectId: string,
  route: string,
  body: unknown,
  what: string
): Promise<T> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${route}`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  if (!res.ok) {
    throw await failure(res, what);
  }
  return (await res.json()) as T;
};

export const createWorktree = (
  projectId: string,
  req: {
    branch: string;
    base?: string;
    startSession?: boolean;
    prompt?: string;
  }
): Promise<{ worktree: Worktree; sessionId?: string }> =>
  postJson(projectId, "worktrees", req, "create worktree");

export const fetchModels = async (projectId: string): Promise<ModelsInfo> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/models`
  );
  if (!res.ok) {
    throw await failure(res, "models");
  }
  return (await res.json()) as ModelsInfo;
};

export const createTask = (
  projectId: string,
  req: TaskRequest
): Promise<TaskResult> => postJson(projectId, "tasks", req, "start task");

export const pickVariant = (
  projectId: string,
  task: string,
  sessionId: string,
  removeWorktrees: boolean
): Promise<PickResult> =>
  postJson(
    projectId,
    `tasks/${encodeURIComponent(task)}/pick`,
    { removeWorktrees, sessionId },
    "pick variant"
  );

export const removeWorktree = (
  projectId: string,
  path: string,
  force: boolean,
  deleteBranch = false
): Promise<unknown> =>
  postJson(
    projectId,
    "worktrees/remove",
    { deleteBranch, force, path },
    "remove worktree"
  );

export const refreshWorktrees = (
  projectId: string
): Promise<{ worktrees: Worktree[] }> =>
  postJson(projectId, "worktrees/refresh", {}, "refresh worktrees");

export const startSession = async (
  projectId: string,
  directory: string,
  title?: string,
  prompt?: string
): Promise<string> => {
  const created = await postJson<{ sessionId: string }>(
    projectId,
    "sessions",
    { directory, prompt, title },
    "start session"
  );
  return created.sessionId;
};

export const openInEditor = (
  projectId: string,
  editor: string,
  directory: string
): Promise<unknown> =>
  postJson(projectId, "open", { directory, editor }, "open editor");

/** "gone": the item was already answered elsewhere (e.g. in the opencode tab); drop it without an error. */
export type ReplyOutcome = "done" | "gone";

const reply = async (
  projectId: string,
  route: string,
  method: "POST" | "DELETE",
  body: unknown,
  what: string
): Promise<ReplyOutcome> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${route}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }
  );
  if (res.status === 409) {
    return "gone";
  }
  if (!res.ok) {
    throw await failure(res, what);
  }
  return "done";
};

export const replyPermission = (
  projectId: string,
  requestId: string,
  decision: PermissionDecision,
  message?: string
): Promise<ReplyOutcome> =>
  reply(
    projectId,
    `permissions/${encodeURIComponent(requestId)}`,
    "POST",
    { decision, message },
    "reply"
  );

export const replyForm = (
  projectId: string,
  formId: string,
  answer: FormAnswer
): Promise<ReplyOutcome> =>
  reply(
    projectId,
    `forms/${encodeURIComponent(formId)}`,
    "POST",
    { answer },
    "answer"
  );

/** Cancels a form. opencode takes no reason, so there is none to send. */
export const dismissForm = (
  projectId: string,
  formId: string
): Promise<ReplyOutcome> =>
  reply(
    projectId,
    `forms/${encodeURIComponent(formId)}`,
    "DELETE",
    undefined,
    "dismiss"
  );

export const fetchReview = async (
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
): Promise<ReviewData> => {
  const query = new URLSearchParams({
    directory,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.file ? { file: opts.file } : {}),
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.from ? { from: opts.from } : {}),
  });
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/review?${query}`,
    signal ? { signal } : undefined
  );
  if (!res.ok) {
    throw await failure(res, "review");
  }
  return (await res.json()) as ReviewData;
};

/** Where the review loads one version of a changed image in a checkout. */
export const reviewImageUrl = (
  projectId: string,
  directory: string,
  opts: { file: string; side: ImageSide; mode?: ReviewMode; base?: string }
): string => {
  const query = new URLSearchParams({
    directory,
    file: opts.file,
    side: opts.side,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  return `/api/projects/${encodeURIComponent(projectId)}/review/image?${query}`;
};

export const suggestCommitMessage = async (
  projectId: string,
  directory: string
): Promise<string> => {
  const suggested = await postJson<{ message: string }>(
    projectId,
    "review/commit-message",
    { directory },
    "commit message"
  );
  return suggested.message;
};

export const commitChanges = async (
  projectId: string,
  directory: string,
  message: string
): Promise<void> => {
  await postJson(projectId, "review/commit", { directory, message }, "commit");
};

export const updateFromBase = (
  projectId: string,
  directory: string,
  base: string
): Promise<UpdateResult> =>
  postJson(projectId, "review/update", { base, directory }, "update from base");

export const mergeIntoBase = (
  projectId: string,
  directory: string,
  base: string,
  ffOnly: boolean
): Promise<{ branch: string }> =>
  postJson(
    projectId,
    "review/merge",
    { base, directory, ffOnly },
    "merge into base"
  );

export const bringHome = (
  projectId: string,
  directory: string
): Promise<{ branch: string }> =>
  postJson(projectId, "review/bring-home", { directory }, "bring home");

export const sendPrompt = async (
  projectId: string,
  sessionId: string,
  text: string
): Promise<void> => {
  await postJson(
    projectId,
    `sessions/${encodeURIComponent(sessionId)}/prompt`,
    { text },
    "send to agent"
  );
};

/** Deletes a session with its subagent sessions, stopping it first if it's busy. */
export const removeSession = async (
  projectId: string,
  sessionId: string
): Promise<void> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    throw await failure(res, "remove session");
  }
};

/** A session's turns, token usage and subagents. */
export const fetchSessionDetail = async (
  projectId: string,
  sessionId: string
): Promise<SessionDetail> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`
  );
  if (!res.ok) {
    throw await failure(res, "load the session");
  }
  return (await res.json()) as SessionDetail;
};

export const rescan = async (): Promise<DashboardSnapshot> => {
  const res = await fetch("/api/projects/rescan", { method: "POST" });
  if (!res.ok) {
    throw await failure(res, "rescan");
  }
  return (await res.json()) as DashboardSnapshot;
};

/** Replaces the folders scanned for projects; the server rescans before answering. */
export const saveRoots = async (
  roots: string[]
): Promise<DashboardSnapshot> => {
  const res = await fetch("/api/settings/roots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roots }),
  });
  if (!res.ok) {
    throw await failure(res, "save folders");
  }
  return (await res.json()) as DashboardSnapshot;
};

export const fetchUsage = async (day?: string): Promise<UsageReport> => {
  const res = await fetch(
    `/api/usage${day ? `?day=${encodeURIComponent(day)}` : ""}`
  );
  if (!res.ok) {
    throw await failure(res, "usage");
  }
  return (await res.json()) as UsageReport;
};

export const fetchLogs = async (projectId: string): Promise<string[]> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/logs`
  );
  if (!res.ok) {
    throw await failure(res, "logs");
  }
  return ((await res.json()) as { lines: string[] }).lines;
};

export const fetchPublishInfo = async (
  projectId: string,
  directory: string,
  remote?: string,
  signal?: AbortSignal
): Promise<PublishInfo> => {
  const query = new URLSearchParams({
    directory,
    ...(remote ? { remote } : {}),
  });
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/publish?${query}`,
    signal ? { signal } : undefined
  );
  if (!res.ok) {
    throw await failure(res, "publish info");
  }
  return (await res.json()) as PublishInfo;
};

export const suggestPublish = (
  projectId: string,
  directory: string
): Promise<{ title: string; description: string }> =>
  postJson(projectId, "publish/suggest", { directory }, "suggest");

export const publishChanges = (
  projectId: string,
  directory: string,
  req: PublishRequest
): Promise<PublishResult> =>
  postJson(projectId, "publish", { directory, ...req }, "publish");

export const fetchChecks = async (
  projectId: string,
  directory?: string,
  signal?: AbortSignal
): Promise<ChecksView> => {
  const query =
    directory === undefined ? "" : `?${new URLSearchParams({ directory })}`;
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/checks${query}`,
    signal ? { signal } : undefined
  );
  if (!res.ok) {
    throw await failure(res, "checks");
  }
  return (await res.json()) as ChecksView;
};

export const fetchCheckRun = async (
  projectId: string,
  directory: string,
  signal?: AbortSignal
): Promise<CheckRun | undefined> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/checks/run?${new URLSearchParams({ directory })}`,
    signal ? { signal } : undefined
  );
  if (!res.ok) {
    throw await failure(res, "checks");
  }
  return ((await res.json()) as { run?: CheckRun }).run;
};

/** Runs all checks, or the named ones; `approve` lists host commands the user just approved. */
export const runChecks = (
  projectId: string,
  directory: string,
  opts: { names?: string[]; approve?: string[] } = {}
): Promise<CheckRun> =>
  postJson(projectId, "checks/run", { directory, ...opts }, "run checks");

/** Saves the project's own list of checks, or goes back to devcontainer.json's with null. */
export const saveChecks = (
  projectId: string,
  checks: CheckDef[] | null
): Promise<ChecksConfig> =>
  postJson(projectId, "checks/settings", { checks }, "save checks");

export const subscribe = (handlers: {
  onSnapshot: (s: DashboardSnapshot) => void;
  onLog: (e: LogEvent) => void;
  onConnection: (connected: boolean) => void;
}): (() => void) => {
  const source = new EventSource("/api/events");
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

export const createEnv = (
  projectId: string,
  path: string
): Promise<{ envId: string }> =>
  postJson(projectId, "envs", { path }, "create container");

export const envAction = async (
  projectId: string,
  envId: string,
  action: Action
): Promise<void> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/envs/${encodeURIComponent(envId)}/${action}`,
    { method: "POST" }
  );
  if (!res.ok) {
    throw await failure(res, `${action} container`);
  }
};

export const removeEnv = (projectId: string, envId: string): Promise<unknown> =>
  postJson(
    projectId,
    `envs/${encodeURIComponent(envId)}/remove`,
    {},
    "remove container"
  );

export const fetchCandidates = async (): Promise<CandidateList> => {
  const res = await fetch("/api/onboarding/candidates");
  if (!res.ok) {
    throw await failure(res, "list repos");
  }
  return (await res.json()) as CandidateList;
};

export const addProject = async (
  path: string,
  stack: StackId
): Promise<AddProjectResult> => {
  const res = await fetch("/api/onboarding", {
    body: JSON.stringify({ path, stack }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "add project");
  }
  return (await res.json()) as AddProjectResult;
};

export const fetchCleanup = async (): Promise<CleanupPlan> => {
  const res = await fetch("/api/cleanup");
  if (!res.ok) {
    throw await failure(res, "cleanup scan");
  }
  return (await res.json()) as CleanupPlan;
};

export const applyCleanup = async (
  items: CleanupItem[]
): Promise<CleanupResult> => {
  const res = await fetch("/api/cleanup", {
    body: JSON.stringify({ items }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "cleanup");
  }
  return (await res.json()) as CleanupResult;
};

export const addNode = async (
  ssh: string,
  label?: string
): Promise<NodeView> => {
  const res = await fetch("/api/nodes", {
    body: JSON.stringify({ ssh, ...(label ? { label } : {}) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "add node");
  }
  return (await res.json()) as NodeView;
};

export const removeNode = async (id: string): Promise<void> => {
  const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw await failure(res, "remove node");
  }
};

/** Forgets a starting task's variants that failed. */
export const dismissStarting = async (
  projectId: string,
  task: string
): Promise<void> => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task)}/starting`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    throw await failure(res, "dismiss");
  }
};

export const sendForgejoReview = async (
  owner: string,
  repo: string,
  number: string,
  input: ForgejoReviewInput
): Promise<void> => {
  const res = await fetch(
    `/api/forgejo/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/reviews`,
    {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  if (!res.ok) {
    throw await failure(res, "send review");
  }
};
export const createForgejoWorktree = async (
  owner: string,
  repo: string,
  number: string,
  projectId: string,
  branch: string,
  commitId: string
): Promise<{ worktree: Worktree }> => {
  const res = await fetch(
    `/api/forgejo/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/worktree`,
    {
      body: JSON.stringify({ branch, commitId, projectId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  if (!res.ok) {
    throw await failure(res, "create PR worktree");
  }
  return res.json();
};

/** Where a pull request's review loads one version of a changed image. */
export const forgejoImageUrl = (
  owner: string,
  repo: string,
  number: string,
  file: string,
  side: ImageSide
): string =>
  `/api/forgejo/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}/image?${new URLSearchParams({ file, side })}`;

const aiReviewRoute = (owner: string, repo: string, number: string) =>
  `/api/forgejo/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}/ai-review`;

/** Starts a session that reviews the pull request in a checkout of it; collect its findings once it is idle. */
export const startAiReviewSession = async (
  owner: string,
  repo: string,
  number: string,
  input: { projectId: string; directory: string; commitId: string }
): Promise<string> => {
  const res = await fetch(`${aiReviewRoute(owner, repo, number)}/session`, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "start AI review");
  }
  return ((await res.json()) as { sessionId: string }).sessionId;
};

/** Findings from a finished review session, or without one, from the diff alone. */
export const collectAiReview = async (
  owner: string,
  repo: string,
  number: string,
  input: {
    projectId: string;
    directory: string;
    commitId: string;
    sessionId?: string;
  }
): Promise<AiReviewResult> => {
  const res = await fetch(aiReviewRoute(owner, repo, number), {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw await failure(res, "collect AI review");
  }
  return res.json();
};
