import { Badge } from "@/components/ui/badge";

import type { EnvironmentView } from "../../shared/types";
import { useDash } from "../DashboardContext";
import { envTone } from "../derive";
import { envNode } from "../nodes";
import { STATE_LABEL, StatusDot } from "./Status";

/** A worktree's own container: a dot and its state, and its node when that's another machine. */
export const EnvBadge = ({ env }: { env: EnvironmentView }) => {
  const { snapshot } = useDash();
  const { containerState, opencode, error } = env.runtime;
  const node = envNode(env.node, snapshot?.nodes);
  let label;
  if (node?.offline) {
    label = "offline";
  } else if (containerState === "running" && opencode === "unhealthy") {
    label = "opencode down";
  } else {
    label = STATE_LABEL[containerState];
  }
  const where = node ? `On ${node.label}` : "Own container";
  return (
    <Badge
      variant="outline"
      className="text-muted-foreground gap-1.5 font-normal"
      title={error ?? `${where} (${env.id})`}
    >
      <StatusDot tone={node?.offline ? "off" : envTone(env)} label={label} />{" "}
      {where} · {label}
    </Badge>
  );
};
