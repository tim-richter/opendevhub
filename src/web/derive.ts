import type { DashboardSnapshot, SessionStatus, SessionSummary } from "../shared/types";

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
