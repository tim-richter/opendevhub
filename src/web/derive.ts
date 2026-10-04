import type { DashboardSnapshot, ProjectView, SessionStatus, SessionSummary } from "../shared/types";

export interface Notice {
  key: string;
  title: string;
  body: string;
  projectId: string;
  sessionId: string;
}

const MESSAGES: Partial<Record<SessionStatus, string>> = {
  "needs-permission": "permission needed",
  "needs-answer": "question waiting",
};

/** What a session is waiting on, as plain text: "wants bash: npm test" or "asks: Which DB?". */
export function pendingSummary(session: SessionSummary): string | undefined {
  const p = session.pending?.permissions[0];
  if (p) {
    const first = p.resources[0] ? `: ${p.resources[0]}` : "";
    const more = p.resources.length > 1 ? ` (+${p.resources.length - 1} more)` : "";
    return `wants ${p.action}${first}${more}`;
  }
  const f = session.pending?.forms[0];
  return f ? `asks: ${f.title}` : undefined;
}

export function diffForNotifications(prev: DashboardSnapshot | undefined, next: DashboardSnapshot): Notice[] {
  if (!prev) return [];
  const before = new Map<string, SessionSummary>();
  for (const view of prev.projects) for (const s of view.sessions) before.set(s.id, s);

  const notices: Notice[] = [];
  for (const view of next.projects) {
    for (const s of view.sessions) {
      const old = before.get(s.id)?.status;
      let what: string | undefined;
      if (MESSAGES[s.status] && old !== s.status) what = MESSAGES[s.status];
      else if (s.status === "idle" && old === "running") what = "finished";
      if (!what) continue;
      const ask = MESSAGES[s.status] ? pendingSummary(s) : undefined;
      notices.push({
        key: `${s.id}:${s.status}`,
        title: ask ? `${view.project.name} · ${ask}` : `${view.project.name}: ${what}`,
        body: s.title,
        projectId: view.project.id,
        sessionId: s.id,
      });
    }
  }
  return notices;
}

export function attentionCounts(snapshot: DashboardSnapshot): { attention: number; running: number } {
  let attention = 0;
  let running = 0;
  for (const view of snapshot.projects) {
    for (const s of view.sessions) {
      if (s.status === "needs-permission" || s.status === "needs-answer") attention++;
      else if (s.status === "running") running++;
    }
  }
  return { attention, running };
}

export function relativeTime(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function needsAttention(status: SessionStatus): boolean {
  return status === "needs-permission" || status === "needs-answer";
}

const STATUS_RANK: Record<SessionStatus, number> = {
  "needs-permission": 0,
  "needs-answer": 0,
  running: 1,
  idle: 2,
};

/** Attention first, then running, then idle; most recently updated first within each. */
export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.updatedAt - a.updatedAt;
}

export interface ProjectCounts {
  attention: number;
  running: number;
  idle: number;
  ports: number;
}

export function projectCounts(view: ProjectView): ProjectCounts {
  const counts = { attention: 0, running: 0, idle: 0, ports: 0 };
  for (const s of view.sessions) {
    if (needsAttention(s.status)) counts.attention++;
    else if (s.status === "running") counts.running++;
    else counts.idle++;
  }
  counts.ports = view.runtime.ports?.filter((p) => p.status === "forwarded").length ?? 0;
  return counts;
}

export type Tone = "attention" | "error" | "busy" | "running" | "ok" | "off";

/** One colour for a project, worst signal wins. */
export function projectTone(view: ProjectView): Tone {
  const { runtime } = view;
  if (view.sessions.some((s) => needsAttention(s.status))) return "attention";
  if (runtime.containerState === "error" || runtime.opencode === "unhealthy") return "error";
  if (runtime.containerState === "starting" || runtime.containerState === "stopping" || runtime.opencode === "starting")
    return "busy";
  if (view.sessions.some((s) => s.status === "running")) return "running";
  if (runtime.containerState === "running") return "ok";
  return "off";
}

export interface SessionEntry {
  session: SessionSummary;
  view: ProjectView;
}

export function allSessions(snapshot: DashboardSnapshot): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const view of snapshot.projects) for (const session of view.sessions) entries.push({ session, view });
  return entries.sort((a, b) => compareSessions(a.session, b.session));
}

export function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}

/** Where the project is checked out inside its container (mirrors the server's fallback). */
export function workspaceFolderOf(view: ProjectView): string {
  const base = view.project.path.split("/").filter(Boolean).at(-1) ?? "";
  return view.runtime.workspaceFolder ?? `/workspaces/${base}`;
}

/** A short name for the worktree a session works in; undefined for the main checkout. */
export function worktreeLabel(view: ProjectView, directory: string): string | undefined {
  if (directory === workspaceFolderOf(view)) return undefined;
  const wt = view.runtime.worktrees?.find((w) => w.path === directory);
  return wt?.branch ?? directory.split("/").filter(Boolean).at(-1) ?? directory;
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A shell inside the container at `directory`, as the dev container's user, preferring bash. */
export function containerShellCommand(view: ProjectView, directory: string): string | undefined {
  const { containerName, remoteUser } = view.runtime;
  if (!containerName) return undefined;
  const user = remoteUser ? ` -u ${shellQuote(remoteUser)}` : "";
  const shell = "command -v bash >/dev/null && exec bash -l || exec sh -l";
  return `docker exec -it${user} -w ${shellQuote(directory)} ${shellQuote(containerName)} sh -c ${shellQuote(shell)}`;
}
