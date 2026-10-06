import type { NodeState, NodeStats, NodeView } from "../shared/types";
import type { ChoiceOption } from "./components/Choice";
import { formatMemory } from "./resources";

const LABELS: Record<NodeState, string> = {
  online: "Online",
  connecting: "Connecting…",
  unreachable: "Unreachable",
  error: "Needs setup",
};

export function nodeStateLabel(state: NodeState): string {
  return LABELS[state];
}

/** Classes for the state chip. */
export function nodeStateClass(state: NodeState): string {
  if (state === "online") return "text-muted-foreground";
  if (state === "connecting") return "border-attention/50 text-attention";
  return "border-destructive/50 text-destructive";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "8 CPUs · 12.5 GiB free of 32.0 GiB · 3 containers". */
export function formatNodeStats(stats: NodeStats | undefined): string | undefined {
  if (!stats) return undefined;
  return [
    plural(stats.cpus, "CPU"),
    `${formatMemory(stats.memAvailable)} free of ${formatMemory(stats.memTotal)}`,
    plural(stats.containers, "container"),
  ].join(" · ");
}

export function nodesNeedingAttention(nodes: NodeView[] | undefined): number {
  return (nodes ?? []).filter((n) => n.state === "unreachable" || n.state === "error").length;
}

/** The task form's Node options, in the snapshot's order (this machine first). */
export function nodeChoices(nodes: NodeView[] | undefined): ChoiceOption[] {
  return (nodes ?? []).map((n) => {
    const extra =
      n.state !== "online" ? ` · ${nodeStateLabel(n.state).toLowerCase()}` : n.stats ? ` · ${formatMemory(n.stats.memAvailable)} free` : "";
    return { value: n.id, label: `${n.label}${extra}` };
  });
}

/** The node a remote environment runs on, and whether it's reachable right now; undefined for this machine. */
export function envNode(nodeId: string | undefined, nodes: NodeView[] | undefined): { label: string; offline: boolean } | undefined {
  if (!nodeId || nodeId === "local") return undefined;
  const node = nodes?.find((n) => n.id === nodeId);
  return { label: node?.label ?? nodeId, offline: node?.state !== "online" };
}
