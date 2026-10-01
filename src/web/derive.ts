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
      notices.push({
        key: `${s.id}:${s.status}`,
        title: `${view.project.name}: ${what}`,
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
