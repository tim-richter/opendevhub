import type { StackId } from "../shared/stacks";
import type { AddProjectResult, CandidateList, DashboardSnapshot, FormAnswer, LogEvent, ModelsInfo, PermissionDecision, PickResult, PublishInfo, PublishRequest, PublishResult, ReviewData, TaskRequest, TaskResult, UpdateResult, UsageReport, Worktree } from "../shared/types";

export type Action = "start" | "stop" | "rebuild" | "restart-opencode";

async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `${what} failed (${res.status})`);
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

export async function fetchReview(projectId: string, directory: string, opts: { base?: string; file?: string } = {}): Promise<ReviewData> {
  const query = new URLSearchParams({ directory, ...(opts.base ? { base: opts.base } : {}), ...(opts.file ? { file: opts.file } : {}) });
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

export async function sendPrompt(projectId: string, sessionId: string, text: string): Promise<void> {
  await postJson(projectId, `sessions/${encodeURIComponent(sessionId)}/prompt`, { text }, "send to agent");
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

export async function fetchPublishInfo(projectId: string, directory: string, remote?: string): Promise<PublishInfo> {
  const query = new URLSearchParams({ directory, ...(remote ? { remote } : {}) });
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/publish?${query}`);
  if (!res.ok) throw await failure(res, "publish info");
  return (await res.json()) as PublishInfo;
}

export function suggestPublish(projectId: string, directory: string): Promise<{ title: string; description: string }> {
  return postJson(projectId, "publish/suggest", { directory }, "suggest");
}

export function publishChanges(projectId: string, directory: string, req: PublishRequest): Promise<PublishResult> {
  return postJson(projectId, "publish", { directory, ...req }, "publish");
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

export async function envAction(projectId: string, envId: string, action: "start" | "stop"): Promise<void> {
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
