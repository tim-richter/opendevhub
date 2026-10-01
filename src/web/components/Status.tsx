import type { ContainerState, SessionStatus } from "../../shared/types";
import type { Tone } from "../derive";

export const STATE_LABEL: Record<ContainerState, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  error: "Error",
};

export const SESSION_LABEL: Record<SessionStatus, string> = {
  "needs-permission": "Needs permission",
  "needs-answer": "Question waiting",
  running: "Running",
  idle: "Idle",
};

export const TONE_LABEL: Record<Tone, string> = {
  attention: "Needs you",
  error: "Error",
  busy: "Working…",
  running: "Agent running",
  ok: "Ready",
  off: "Stopped",
};

export function StatusDot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot tone-${tone}`} role="img" aria-label={label ?? TONE_LABEL[tone]} />;
}

export function SessionBadge({ status }: { status: SessionStatus }) {
  return <span className={`badge status-${status}`}>{SESSION_LABEL[status]}</span>;
}

export function Count({ n, tone }: { n: number; tone?: "attention" | "muted" }) {
  if (n <= 0) return null;
  return <span className={`count${tone ? ` count-${tone}` : ""}`}>{n}</span>;
}
