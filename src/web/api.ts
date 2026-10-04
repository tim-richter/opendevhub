import type { DashboardSnapshot, FormAnswer, LogEvent, PermissionDecision, Worktree } from "../shared/types";

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
  req: { branch: string; base?: string; startSession?: boolean },
): Promise<{ worktree: Worktree; sessionId?: string }> {
  return postJson(projectId, "worktrees", req, "create worktree");
}

export function removeWorktree(projectId: string, path: string, force: boolean): Promise<unknown> {
  return postJson(projectId, "worktrees/remove", { path, force }, "remove worktree");
}

export function refreshWorktrees(projectId: string): Promise<{ worktrees: Worktree[] }> {
  return postJson(projectId, "worktrees/refresh", {}, "refresh worktrees");
}

export async function startSession(projectId: string, directory: string, title?: string): Promise<string> {
  return (await postJson<{ sessionId: string }>(projectId, "sessions", { directory, title }, "start session")).sessionId;
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

export async function rescan(): Promise<DashboardSnapshot> {
  const res = await fetch("/api/projects/rescan", { method: "POST" });
  if (!res.ok) throw await failure(res, "rescan");
  return (await res.json()) as DashboardSnapshot;
}

export async function fetchLogs(projectId: string): Promise<string[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/logs`);
  if (!res.ok) throw await failure(res, "logs");
  return ((await res.json()) as { lines: string[] }).lines;
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
