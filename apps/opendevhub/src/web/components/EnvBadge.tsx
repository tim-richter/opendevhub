import type { EnvironmentView } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { useDash } from "../DashboardContext";
import { envTone } from "../derive";
import { envNode } from "../nodes";
import { STATE_LABEL, StatusDot } from "./Status";

/** A worktree's own container: a dot and its state, and its node when that's another machine. */
export function EnvBadge({ env }: { env: EnvironmentView }) {
  const { snapshot } = useDash();
  const { containerState, opencode, error } = env.runtime;
  const node = envNode(env.node, snapshot?.nodes);
  const label = node?.offline ? "offline" : containerState === "running" && opencode === "unhealthy" ? "opencode down" : STATE_LABEL[containerState];
  const where = node ? `On ${node.label}` : "Own container";
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground" title={error ?? `${where} (${env.id})`}>
      <StatusDot tone={node?.offline ? "off" : envTone(env)} label={label} /> {where} · {label}
    </Badge>
  );
}
