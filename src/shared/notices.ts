import type { DashboardSnapshot, PendingPermission, SessionSummary } from "./types";

/** Something worth a notification, computed on the server and delivered by Web Push. */
export interface Notice {
  /** Notification tag: a re-sent notice replaces the old notification. */
  tag: string;
  title: string;
  body: string;
  /** Dashboard path: /p/<projectId>?session=<sessionId>. */
  url: string;
  projectId: string;
  sessionId: string;
  /** Present: the notification gets Allow once / Reject. */
  permission?: { requestId: string };
}

function permissionSummary(p: PendingPermission): string {
  const first = p.resources[0] ? `: ${p.resources[0]}` : "";
  const more = p.resources.length > 1 ? ` (+${p.resources.length - 1} more)` : "";
  return `wants ${p.action}${first}${more}`;
}

/** What a session is waiting on, as plain text: "wants bash: npm test" or "asks: Which DB?". */
export function pendingSummary(session: SessionSummary): string | undefined {
  const p = session.pending?.permissions[0];
  if (p) return permissionSummary(p);
  const f = session.pending?.forms[0];
  return f ? `asks: ${f.title}` : undefined;
}

/** One notice per permission or question that wasn't pending before, and per root session that finished. */
export function diffForNotifications(prev: DashboardSnapshot | undefined, next: DashboardSnapshot): Notice[] {
  if (!prev) return [];
  const before = new Map<string, SessionSummary>();
  const pendingBefore = new Set<string>();
  for (const view of prev.projects) {
    for (const s of view.sessions) {
      before.set(s.id, s);
      for (const p of s.pending?.permissions ?? []) pendingBefore.add(`perm:${p.id}`);
      for (const f of s.pending?.forms ?? []) pendingBefore.add(`form:${f.id}`);
    }
  }

  const notices: Notice[] = [];
  for (const view of next.projects) {
    const name = view.project.name;
    for (const s of view.sessions) {
      const base = {
        body: s.title,
        url: `/p/${encodeURIComponent(view.project.id)}?session=${encodeURIComponent(s.id)}`,
        projectId: view.project.id,
        sessionId: s.id,
      };
      for (const p of s.pending?.permissions ?? []) {
        const tag = `perm:${p.id}`;
        if (pendingBefore.has(tag)) continue;
        notices.push({ tag, title: `${name} · ${permissionSummary(p)}`, ...base, permission: { requestId: p.id } });
      }
      for (const f of s.pending?.forms ?? []) {
        const tag = `form:${f.id}`;
        if (pendingBefore.has(tag)) continue;
        notices.push({ tag, title: `${name} · asks: ${f.title}`, ...base });
      }
      if (s.status === "idle" && before.get(s.id)?.status === "running") {
        notices.push({ tag: `done:${s.id}`, title: `${name}: finished`, ...base });
      }
    }
  }
  return notices;
}
