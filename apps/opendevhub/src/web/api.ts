import type { JiraSettings, JiraSettingsInput, JiraTicket, JiraTickets } from "../shared/jira";
import type { StackId } from "../shared/stacks";
import type { ForgejoReviewInput, ForgejoChecks, ForgejoComment, ForgejoConnection, ForgejoPage, ForgejoPullDetails, ForgejoPullFilter, ForgejoPullQuery, ForgejoPulls, ForgejoReview, ForgejoSettings, ForgejoSettingsInput } from "../shared/forgejo";
import type { AddProjectResult, CandidateList, CheckDef, CheckRun, ChecksConfig, ChecksView, CleanupItem, CleanupPlan, CleanupResult, DashboardSnapshot, FormAnswer, LogEvent, ModelsInfo, NodeView, PermissionDecision, PickResult, PublishInfo, PublishRequest, PublishResult, ReviewData, ReviewMode, TaskRequest, TaskResult, UpdateResult, UsageReport, Worktree } from "../shared/types";

export type Action = "start" | "stop" | "rebuild" | "restart-opencode";

async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `${what} failed (${res.status})`);
}

export async function fetchForgejoSettings(): Promise<ForgejoSettings> {
  const res = await fetch("/api/forgejo/settings", { cache: "no-store" });
  if (!res.ok) throw await failure(res, "Forgejo settings");
  return res.json();
}

export async function saveForgejoSettings(input: ForgejoSettingsInput): Promise<ForgejoSettings> {
  const res = await fetch("/api/forgejo/settings", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res, "save Forgejo settings");
  return res.json();
}

export async function fetchForgejoPulls(input: ForgejoPullQuery | ForgejoPullFilter = "all", signal?: AbortSignal): Promise<ForgejoPulls> {
  const options = typeof input === "string" ? { state: input } : input;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) if (value !== undefined && value !== "") query.set(key, String(value));
  return forgejoGet(`pulls?${query}`, signal);
}

function forgejoPullRoute(owner: string, repo: string, number: string) {
  return `pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
}
async function forgejoGet<T>(route: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/forgejo/${route}`, { signal, cache: "no-store" });
  if (!res.ok) throw await failure(res, "Forgejo request");
  return res.json();
}
export function fetchForgejoDetails(owner: string, repo: string, number: string, signal?: AbortSignal): Promise<ForgejoPullDetails> {
  return forgejoGet(forgejoPullRoute(owner, repo, number), signal);
}
export function fetchForgejoDiff(owner: string, repo: string, number: string, signal?: AbortSignal): Promise<{ patch: string }> {
  return forgejoGet(`${forgejoPullRoute(owner, repo, number)}/patch`, signal);
}
export function fetchForgejoComments(owner: string, repo: string, number: string, page: number, signal?: AbortSignal): Promise<ForgejoPage<ForgejoComment>> {
  return forgejoGet(`${forgejoPullRoute(owner, repo, number)}/comments?page=${page}`, signal);
}
export function fetchForgejoReviews(owner: string, repo: string, number: string, page: number, signal?: AbortSignal): Promise<ForgejoPage<ForgejoReview>> {
  return forgejoGet(`${forgejoPullRoute(owner, repo, number)}/reviews?page=${page}`, signal);
}
export function fetchForgejoReviewComments(owner: string, repo: string, number: string, id: number, signal?: AbortSignal): Promise<ForgejoComment[]> {
  return forgejoGet(`${forgejoPullRoute(owner, repo, number)}/reviews/${id}/comments`, signal);
}
export function fetchForgejoChecks(owner: string, repo: string, sha: string, page: number, signal?: AbortSignal): Promise<ForgejoChecks> {
  return forgejoGet(`checks/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}?page=${page}`, signal);
}
export async function testForgejoConnection(input: { url: string; token?: string }): Promise<ForgejoConnection> {
  const res = await fetch("/api/forgejo/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw await failure(res, "test Forgejo connection");
  return res.json();
}

export async function fetchJiraSettings(): Promise<JiraSettings> {
  const res = await fetch("/api/jira/settings", { cache: "no-store" });
  if (!res.ok) throw await failure(res, "Jira settings");
  return res.json();
}

export async function saveJiraSettings(input: JiraSettingsInput): Promise<JiraSettings> {
  const res = await fetch("/api/jira/settings", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res, "save Jira settings");
  return res.json();
}

export async function fetchJiraTickets(search = "", startAt = 0, signal?: AbortSignal): Promise<JiraTickets> {
  const res = await fetch(`/api/jira/tickets?${new URLSearchParams({ search, startAt: String(startAt) })}`, { signal, cache: "no-store" });
  if (!res.ok) throw await failure(res, "Jira tickets");
  return res.json();
}

export async function fetchJiraTicket(key: string, signal?: AbortSignal): Promise<JiraTicket> {
  const res = await fetch(`/api/jira/tickets/${encodeURIComponent(key)}`, { signal, cache: "no-store" });
  if (!res.ok) throw await failure(res, "Jira ticket");
  return res.json();
}

export async function postAction(projectId: string, action: Action): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${action}`, { method: "POST" });
  if (!res.ok) throw await failure(res, action);
}

async function postJson<T>(projectId: string, route: string, body: unknown, what: string): Promise<T> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, what);
  return (await res.json()) as T;
}

export function createWorktree(
  projectId: string,
  req: { branch: string; base?: string; startSession?: boolean; prompt?: string },
): Promise<{ worktree: Worktree; sessionId?: string }> {
  return postJson(projectId, "worktrees", req, "create worktree");
}

export async function fetchModels(projectId: string): Promise<ModelsInfo> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/models`);
  if (!res.ok) throw await failure(res, "models");
  return (await res.json()) as ModelsInfo;
}

export function createTask(projectId: string, req: TaskRequest): Promise<TaskResult> {
  return postJson(projectId, "tasks", req, "start task");
}

export function pickVariant(projectId: string, task: string, sessionId: string, removeWorktrees: boolean): Promise<PickResult> {
  return postJson(projectId, `tasks/${encodeURIComponent(task)}/pick`, { sessionId, removeWorktrees }, "pick variant");
}

export function removeWorktree(projectId: string, path: string, force: boolean, deleteBranch = false): Promise<unknown> {
  return postJson(projectId, "worktrees/remove", { path, force, deleteBranch }, "remove worktree");
}

export function refreshWorktrees(projectId: string): Promise<{ worktrees: Worktree[] }> {
  return postJson(projectId, "worktrees/refresh", {}, "refresh worktrees");
}

export async function startSession(projectId: string, directory: string, title?: string, prompt?: string): Promise<string> {
  return (await postJson<{ sessionId: string }>(projectId, "sessions", { directory, title, prompt }, "start session")).sessionId;
}

export function openInEditor(projectId: string, editor: string, directory: string): Promise<unknown> {
  return postJson(projectId, "open", { editor, directory }, "open editor");
}

/** "gone": the item was already answered elsewhere (e.g. in the opencode tab); drop it without an error. */
export type ReplyOutcome = "done" | "gone";

async function reply(projectId: string, route: string, method: "POST" | "DELETE", body: unknown, what: string): Promise<ReplyOutcome> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.status === 409) return "gone";
  if (!res.ok) throw await failure(res, what);
  return "done";
}

export function replyPermission(projectId: string, requestId: string, decision: PermissionDecision, message?: string): Promise<ReplyOutcome> {
  return reply(projectId, `permissions/${encodeURIComponent(requestId)}`, "POST", { decision, message }, "reply");
}

export function replyForm(projectId: string, formId: string, answer: FormAnswer): Promise<ReplyOutcome> {
  return reply(projectId, `forms/${encodeURIComponent(formId)}`, "POST", { answer }, "answer");
}

/** Cancels a form. opencode takes no reason, so there is none to send. */
export function dismissForm(projectId: string, formId: string): Promise<ReplyOutcome> {
  return reply(projectId, `forms/${encodeURIComponent(formId)}`, "DELETE", undefined, "dismiss");
}

export async function fetchReview(
  projectId: string,
  directory: string,
  opts: { base?: string; mode?: ReviewMode; file?: string } = {},
): Promise<ReviewData> {
  const query = new URLSearchParams({
    directory,
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.file ? { file: opts.file } : {}),
  });
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/review?${query}`);
  if (!res.ok) throw await failure(res, "review");
  return (await res.json()) as ReviewData;
}

export async function suggestCommitMessage(projectId: string, directory: string): Promise<string> {
  return (await postJson<{ message: string }>(projectId, "review/commit-message", { directory }, "commit message")).message;
}

export async function commitChanges(projectId: string, directory: string, message: string): Promise<void> {
  await postJson(projectId, "review/commit", { directory, message }, "commit");
}

export function updateFromBase(projectId: string, directory: string, base: string): Promise<UpdateResult> {
  return postJson(projectId, "review/update", { directory, base }, "update from base");
}

export function mergeIntoBase(projectId: string, directory: string, base: string, ffOnly: boolean): Promise<{ branch: string }> {
  return postJson(projectId, "review/merge", { directory, base, ffOnly }, "merge into base");
}

export function bringHome(projectId: string, directory: string): Promise<{ branch: string }> {
  return postJson(projectId, "review/bring-home", { directory }, "bring home");
}

export async function sendPrompt(projectId: string, sessionId: string, text: string): Promise<void> {
  await postJson(projectId, `sessions/${encodeURIComponent(sessionId)}/prompt`, { text }, "send to agent");
}

/** Deletes a session with its subagent sessions, stopping it first if it's busy. */
export async function removeSession(projectId: string, sessionId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (!res.ok) throw await failure(res, "remove session");
}

export async function rescan(): Promise<DashboardSnapshot> {
  const res = await fetch("/api/projects/rescan", { method: "POST" });
  if (!res.ok) throw await failure(res, "rescan");
  return (await res.json()) as DashboardSnapshot;
}

export async function fetchUsage(day?: string): Promise<UsageReport> {
  const res = await fetch(`/api/usage${day ? `?day=${encodeURIComponent(day)}` : ""}`);
  if (!res.ok) throw await failure(res, "usage");
  return (await res.json()) as UsageReport;
}

export async function fetchLogs(projectId: string): Promise<string[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/logs`);
  if (!res.ok) throw await failure(res, "logs");
  return ((await res.json()) as { lines: string[] }).lines;
}

export async function fetchPublishInfo(projectId: string, directory: string, remote?: string, signal?: AbortSignal): Promise<PublishInfo> {
  const query = new URLSearchParams({ directory, ...(remote ? { remote } : {}) });
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/publish?${query}`, signal ? { signal } : undefined);
  if (!res.ok) throw await failure(res, "publish info");
  return (await res.json()) as PublishInfo;
}

export function suggestPublish(projectId: string, directory: string): Promise<{ title: string; description: string }> {
  return postJson(projectId, "publish/suggest", { directory }, "suggest");
}

export function publishChanges(projectId: string, directory: string, req: PublishRequest): Promise<PublishResult> {
  return postJson(projectId, "publish", { directory, ...req }, "publish");
}

export async function fetchChecks(projectId: string, directory?: string): Promise<ChecksView> {
  const query = directory === undefined ? "" : `?${new URLSearchParams({ directory })}`;
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/checks${query}`);
  if (!res.ok) throw await failure(res, "checks");
  return (await res.json()) as ChecksView;
}

export async function fetchCheckRun(projectId: string, directory: string): Promise<CheckRun | undefined> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/checks/run?${new URLSearchParams({ directory })}`);
  if (!res.ok) throw await failure(res, "checks");
  return ((await res.json()) as { run?: CheckRun }).run;
}

/** Runs all checks, or the named ones; `approve` lists host commands the user just approved. */
export function runChecks(projectId: string, directory: string, opts: { names?: string[]; approve?: string[] } = {}): Promise<CheckRun> {
  return postJson(projectId, "checks/run", { directory, ...opts }, "run checks");
}

/** Saves the project's own list of checks, or goes back to devcontainer.json's with null. */
export function saveChecks(projectId: string, checks: CheckDef[] | null): Promise<ChecksConfig> {
  return postJson(projectId, "checks/settings", { checks }, "save checks");
}

export function subscribe(handlers: {
  onSnapshot: (s: DashboardSnapshot) => void;
  onLog: (e: LogEvent) => void;
  onConnection: (connected: boolean) => void;
}): () => void {
  const source = new EventSource("/api/events");
  source.addEventListener("snapshot", (e) => handlers.onSnapshot(JSON.parse((e as MessageEvent<string>).data)));
  source.addEventListener("log", (e) => handlers.onLog(JSON.parse((e as MessageEvent<string>).data)));
  source.onopen = () => handlers.onConnection(true);
  source.onerror = () => handlers.onConnection(false);
  return () => source.close();
}

export function createEnv(projectId: string, path: string): Promise<{ envId: string }> {
  return postJson(projectId, "envs", { path }, "create container");
}

export async function envAction(projectId: string, envId: string, action: "start" | "stop" | "rebuild" | "restart-opencode"): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/envs/${encodeURIComponent(envId)}/${action}`, { method: "POST" });
  if (!res.ok) throw await failure(res, `${action} container`);
}

export function removeEnv(projectId: string, envId: string): Promise<unknown> {
  return postJson(projectId, `envs/${encodeURIComponent(envId)}/remove`, {}, "remove container");
}

export async function fetchCandidates(): Promise<CandidateList> {
  const res = await fetch("/api/onboarding/candidates");
  if (!res.ok) throw await failure(res, "list repos");
  return (await res.json()) as CandidateList;
}

export async function addProject(path: string, stack: StackId): Promise<AddProjectResult> {
  const res = await fetch("/api/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, stack }),
  });
  if (!res.ok) throw await failure(res, "add project");
  return (await res.json()) as AddProjectResult;
}

export async function fetchCleanup(): Promise<CleanupPlan> {
  const res = await fetch("/api/cleanup");
  if (!res.ok) throw await failure(res, "cleanup scan");
  return (await res.json()) as CleanupPlan;
}

export async function applyCleanup(items: CleanupItem[]): Promise<CleanupResult> {
  const res = await fetch("/api/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw await failure(res, "cleanup");
  return (await res.json()) as CleanupResult;
}

export async function addNode(ssh: string, label?: string): Promise<NodeView> {
  const res = await fetch("/api/nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssh, ...(label ? { label } : {}) }),
  });
  if (!res.ok) throw await failure(res, "add node");
  return (await res.json()) as NodeView;
}

export async function removeNode(id: string): Promise<void> {
  const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw await failure(res, "remove node");
}

/** Forgets a starting task's variants that failed. */
export async function dismissStarting(projectId: string, task: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task)}/starting`, { method: "DELETE" });
  if (!res.ok) throw await failure(res, "dismiss");
}

export async function sendForgejoReview(owner: string, repo: string, number: string, input: ForgejoReviewInput): Promise<void> {
  const res = await fetch(`/api/forgejo/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/reviews`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res, "send review");
}
export async function createForgejoWorktree(owner: string, repo: string, number: string, projectId: string, branch: string, commitId: string): Promise<{ worktree: Worktree }> {
  const res = await fetch(`/api/forgejo/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/worktree`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, branch, commitId }),
  });
  if (!res.ok) throw await failure(res, "create PR worktree");
  return res.json();
}
