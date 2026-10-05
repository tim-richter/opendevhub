import { cn } from "@/lib/utils";
import { formatCpu, formatMemory } from "../resources";

/** `CPU 12% · 1.3 GiB`; the tooltip has the container count or the memory limit. */
export function ResourceStat(props: { cpu: number; memory: number; memoryLimit?: number; count?: number; className?: string }) {
  const { cpu, memory, memoryLimit, count } = props;
  const title = [
    count !== undefined ? `${count} ${count === 1 ? "container" : "containers"}` : undefined,
    memoryLimit !== undefined ? `${formatMemory(memory)} of ${formatMemory(memoryLimit)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={cn("tabular-nums", props.className)} title={title || undefined}>
      CPU {formatCpu(cpu)} · {formatMemory(memory)}
    </span>
  );
}
