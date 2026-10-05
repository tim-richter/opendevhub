import type { ContainerState, SessionStatus } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

const DOT: Record<Tone, string> = {
  attention: "bg-attention ring-3 ring-attention/25 animate-pulse",
  error: "bg-destructive",
  busy: "bg-warn animate-pulse",
  running: "bg-running",
  ok: "bg-ok",
  off: "bg-off",
};

export const TONE_TEXT: Record<Tone, string> = {
  attention: "text-attention",
  error: "text-destructive",
  busy: "text-warn",
  running: "text-running",
  ok: "text-ok",
  off: "text-muted-foreground",
};

export function StatusDot({ tone, label, className }: { tone: Tone; label?: string; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full motion-reduce:animate-none", DOT[tone], className)}
      role="img"
      aria-label={label ?? TONE_LABEL[tone]}
    />
  );
}

const SESSION_BADGE: Record<SessionStatus, string> = {
  "needs-permission": "bg-attention text-white",
  "needs-answer": "bg-attention text-white",
  running: "bg-running/15 text-running",
  idle: "bg-muted text-muted-foreground",
};

export function SessionBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge variant="secondary" className={cn("rounded-md", SESSION_BADGE[status])}>
      {SESSION_LABEL[status]}
    </Badge>
  );
}

export function Count({ n, tone }: { n: number; tone?: "attention" | "muted" }) {
  if (n <= 0) return null;
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 min-w-5 rounded-full px-1.5 tabular-nums",
        tone === "attention" ? "bg-attention text-white" : "bg-muted text-muted-foreground",
      )}
    >
      {n}
    </Badge>
  );
}
