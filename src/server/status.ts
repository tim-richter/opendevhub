import type { SessionStatus, SessionSummary } from "../shared/types";
import type { RawForm, RawPermissionRequest, RawSession } from "./opencode/client";

export interface StatusInput {
  sessions: RawSession[];
  active: Set<string>;
  permissions: RawPermissionRequest[];
  forms: RawForm[];
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

export function deriveSessions(projectId: string, input: StatusInput): SessionSummary[] {
  const parents = new Map(input.sessions.map((s) => [s.id, s.parentID]));
  const flags = new Map<string, SessionStatus>();
  const raise = (sessionId: string, status: SessionStatus) => {
    const root = rootOf(sessionId, parents);
    const current = flags.get(root);
    if (!current || RANK[status] < RANK[current]) flags.set(root, status);
  };
  for (const id of input.active) raise(id, "running");
  for (const f of input.forms) raise(f.sessionID, "needs-answer");
  for (const p of input.permissions) raise(p.sessionID, "needs-permission");

  return input.sessions
    .filter((s) => !s.parentID && s.time.archived === undefined)
    .map((s) => ({
      id: s.id,
      projectId,
      title: s.title?.trim() || "Untitled session",
      directory: s.location.directory,
      updatedAt: s.time.updated,
      status: flags.get(s.id) ?? "idle",
    }))
    .sort(compareSessions);
}
