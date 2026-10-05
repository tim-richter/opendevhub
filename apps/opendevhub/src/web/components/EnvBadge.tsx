import type { EnvironmentView } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { envTone } from "../derive";
import { STATE_LABEL, StatusDot } from "./Status";

/** A worktree's own container: a dot and its state. */
export function EnvBadge({ env }: { env: EnvironmentView }) {
  const { containerState, opencode, error } = env.runtime;
  const label = containerState === "running" && opencode === "unhealthy" ? "opencode down" : STATE_LABEL[containerState];
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground" title={error ?? `Own container (${env.id})`}>
      <StatusDot tone={envTone(env)} label={label} /> Own container · {label}
    </Badge>
  );
}
