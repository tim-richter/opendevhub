import type { NodeState, NodeStats, NodeView } from "../../../shared/types";
import type { ChoiceOption } from "../../components/choice";
import { formatMemory } from "../../lib/resources";

const LABELS: Record<NodeState, string> = {
  connecting: "Connecting…",
  error: "Needs setup",
  online: "Online",
  unreachable: "Unreachable",
};

export const nodeStateLabel = (state: NodeState): string => LABELS[state];

/** Classes for the state chip. */
export const nodeStateClass = (state: NodeState): string => {
  if (state === "online") {
    return "text-muted-foreground";
  }
  if (state === "connecting") {
    return "border-attention/50 text-attention";
  }
  return "border-destructive/50 text-destructive";
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "8 CPUs · 12.5 GiB free of 32.0 GiB · 3 containers". */
export const formatNodeStats = (
  stats: NodeStats | undefined
): string | undefined => {
  if (!stats) {
    return undefined;
  }
  return [
    plural(stats.cpus, "CPU"),
    `${formatMemory(stats.memAvailable)} free of ${formatMemory(stats.memTotal)}`,
    plural(stats.containers, "container"),
  ].join(" · ");
};

export const nodesNeedingAttention = (nodes: NodeView[] | undefined): number =>
  (nodes ?? []).filter((n) => n.state === "unreachable" || n.state === "error")
    .length;

/** The task form's Node options, in the snapshot's order (this machine first). */
export const nodeChoices = (nodes: NodeView[] | undefined): ChoiceOption[] =>
  (nodes ?? []).map((n) => {
    let extra;
    if (n.state === "online") {
      if (n.stats) {
        extra = ` · ${formatMemory(n.stats.memAvailable)} free`;
      } else {
        extra = "";
      }
    } else {
      extra = ` · ${nodeStateLabel(n.state).toLowerCase()}`;
    }
    return { label: `${n.label}${extra}`, value: n.id };
  });

/** The node a remote environment runs on, and whether it's reachable right now; undefined for this machine. */
export const envNode = (
  nodeId: string | undefined,
  nodes: NodeView[] | undefined
): { label: string; offline: boolean } | undefined => {
  if (!nodeId || nodeId === "local") {
    return undefined;
  }
  const node = nodes?.find((n) => n.id === nodeId);
  return { label: node?.label ?? nodeId, offline: node?.state !== "online" };
};
