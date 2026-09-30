import type { DashboardSnapshot, LogEvent } from "../shared/types";

export type Action = "start" | "stop" | "rebuild" | "restart-opencode";

async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `${what} failed (${res.status})`);
}

export async function postAction(projectId: string, action: Action): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${action}`, { method: "POST" });
  if (!res.ok) throw await failure(res, action);
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
