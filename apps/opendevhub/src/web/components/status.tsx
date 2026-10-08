import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { ContainerState, SessionStatus } from "../../shared/types";
import type { Tone } from "../derive";

export const STATE_LABEL: Record<ContainerState, string> = {
  error: "Error",
  running: "Running",
  starting: "Starting…",
  stopped: "Stopped",
  stopping: "Stopping…",
};

export const SESSION_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  "needs-answer": "Question waiting",
  "needs-permission": "Needs permission",
  running: "Running",
};

export const TONE_LABEL: Record<Tone, string> = {
  attention: "Needs you",
  busy: "Working…",
  error: "Error",
  off: "Stopped",
  ok: "Ready",
  running: "Agent running",
};

const DOT: Record<Tone, string> = {
  attention: "bg-attention ring-3 ring-attention/25",
  busy: "bg-warn animate-pulse",
  error: "bg-destructive",
  off: "bg-off",
  ok: "bg-ok",
  running: "bg-running",
};

export const TONE_TEXT: Record<Tone, string> = {
  attention: "text-attention",
  busy: "text-warn",
  error: "text-destructive",
  off: "text-muted-foreground",
  ok: "text-ok",
  running: "text-running",
};

export const StatusDot = ({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label?: string;
  className?: string;
}) => (
  <span
    className={cn(
      "inline-block size-2 shrink-0 rounded-full motion-reduce:animate-none",
      DOT[tone],
      className
    )}
    role="img"
    aria-label={label ?? TONE_LABEL[tone]}
  />
);

const SESSION_BADGE: Record<SessionStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  "needs-answer": "bg-attention text-attention-foreground",
  "needs-permission": "bg-attention text-attention-foreground",
  running: "bg-running/15 text-running",
};

export const SessionBadge = ({ status }: { status: SessionStatus }) => (
  <Badge
    variant="secondary"
    className={cn("rounded-md", SESSION_BADGE[status])}
  >
    {SESSION_LABEL[status]}
  </Badge>
);

export const Count = ({
  n,
  tone,
}: {
  n: number;
  tone?: "attention" | "muted";
}) => {
  if (n <= 0) {
    return null;
  }
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 min-w-5 rounded-full px-1.5 tabular-nums",
        tone === "attention"
          ? "bg-attention text-attention-foreground"
          : "bg-muted text-muted-foreground"
      )}
    >
      {n}
    </Badge>
  );
};
