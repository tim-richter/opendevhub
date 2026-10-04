import type { PendingForm, PendingItems, PendingPermission, SessionStatus, SessionSummary } from "../shared/types";
import type { RawForm, RawPermissionRequest, RawSession } from "./opencode/client";

export interface StatusInput {
  sessions: RawSession[];
  active: Set<string>;
  permissions: RawPermissionRequest[];
  forms: RawForm[];
  /** When the monitor first saw each pending item, by item id. */
  firstSeen?: Map<string, number>;
}

const RANK: Record<SessionStatus, number> = { "needs-permission": 0, "needs-answer": 1, running: 2, idle: 3 };

export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  return RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt;
}

function rootOf(id: string, parents: Map<string, string | undefined>): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (!parent) return current;
    current = parent;
  }
  return current;
}

function toPermission(p: RawPermissionRequest, createdAt: number | undefined): PendingPermission {
  const diff = [p.metadata?.diff, p.metadata?.patch].find((v): v is string => typeof v === "string");
  return {
    id: p.id,
    sessionId: p.sessionID,
    action: p.action,
    resources: Array.isArray(p.resources) ? p.resources.filter((r): r is string => typeof r === "string") : [],
    ...(p.save?.length ? { save: p.save } : {}),
    ...(p.message ? { message: p.message } : {}),
    ...(diff ? { diff } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

function toForm(f: RawForm, createdAt: number | undefined): PendingForm {
  return {
    id: f.id,
    sessionId: f.sessionID,
    title: f.title,
    fields: Array.isArray(f.fields) ? f.fields : [],
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

const byAge = (a: { createdAt?: number }, b: { createdAt?: number }) => (a.createdAt ?? 0) - (b.createdAt ?? 0);

export function deriveSessions(projectId: string, input: StatusInput): SessionSummary[] {
  const parents = new Map(input.sessions.map((s) => [s.id, s.parentID]));
  const flags = new Map<string, SessionStatus>();
  const pending = new Map<string, PendingItems>();
  const raise = (sessionId: string, status: SessionStatus) => {
    const root = rootOf(sessionId, parents);
    const current = flags.get(root);
    if (!current || RANK[status] < RANK[current]) flags.set(root, status);
  };
  const itemsOf = (sessionId: string): PendingItems => {
    const root = rootOf(sessionId, parents);
    let items = pending.get(root);
    if (!items) pending.set(root, (items = { permissions: [], forms: [] }));
    return items;
  };
  const seen = (id: string) => input.firstSeen?.get(id);

  for (const id of input.active) raise(id, "running");
  for (const f of input.forms) {
    raise(f.sessionID, "needs-answer");
    itemsOf(f.sessionID).forms.push(toForm(f, seen(f.id)));
  }
  for (const p of input.permissions) {
    raise(p.sessionID, "needs-permission");
    itemsOf(p.sessionID).permissions.push(toPermission(p, seen(p.id)));
  }

  return input.sessions
    .filter((s) => !s.parentID && s.time.archived === undefined)
    .map((s) => {
      const items = pending.get(s.id);
      return {
        id: s.id,
        projectId,
        title: s.title?.trim() || "Untitled session",
        directory: s.location.directory,
        updatedAt: s.time.updated,
        status: flags.get(s.id) ?? "idle",
        ...(items
          ? { pending: { permissions: items.permissions.sort(byAge), forms: items.forms.sort(byAge) } }
          : {}),
      };
    })
    .sort(compareSessions);
}
