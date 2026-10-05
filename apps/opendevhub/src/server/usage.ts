import type { ProjectId } from "../shared/types";
import type { RawSession } from "./opencode/client";
import { rollUp } from "./status";
import { parseTaskMeta } from "./tasks";

/** A root session's spend so far, its subagents included. */
export interface Observed {
  sessionId: string;
  projectId: ProjectId;
  task?: string;
  cost: number;
  tokens: number;
  /** The latest update in the session's tree; decides the day spend is booked to. */
  updatedAt: number;
}

export interface Seen {
  cost: number;
  tokens: number;
}

export interface Booking {
  /** YYYY-MM-DD, local time. */
  day: string;
  sessionId: string;
  projectId: ProjectId;
  task?: string;
  cost: number;
  tokens: number;
}

/** YYYY-MM-DD in the local time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Each root session among `sessions`, with its subagents rolled in and its task, if any. */
export function observe(projectId: ProjectId, sessions: RawSession[]): Observed[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return [...rollUp(sessions)].map(([sessionId, t]) => {
    const task = parseTaskMeta(byId.get(sessionId)?.metadata)?.task;
    return { sessionId, projectId, ...(task ? { task } : {}), cost: t.cost ?? 0, tokens: t.tokens ?? 0, updatedAt: t.updatedAt };
  });
}

/**
 * What each session spent since it was last seen, booked to the day it was last updated. A session never seen
 * books everything; a decrease (opencode reverting messages) books nothing, since the spend happened.
 */
export function book(observed: Observed[], seen: Map<string, Seen>): Booking[] {
  return observed.flatMap((o) => {
    const before = seen.get(o.sessionId) ?? { cost: 0, tokens: 0 };
    const cost = Math.max(0, o.cost - before.cost);
    const tokens = Math.max(0, o.tokens - before.tokens);
    if (cost === 0 && tokens === 0) return [];
    return [{ day: localDay(o.updatedAt), sessionId: o.sessionId, projectId: o.projectId, ...(o.task ? { task: o.task } : {}), cost, tokens }];
  });
}
