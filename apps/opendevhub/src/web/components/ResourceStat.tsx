import { formatCpu, formatMemory } from "../resources";

/** `CPU 12% · 1.3 GiB`; the tooltip has the container count or the memory limit. */
export function ResourceStat({ cpu, memory, memoryLimit, count }: { cpu: number; memory: number; memoryLimit?: number; count?: number }) {
  const title = [
    count !== undefined ? `${count} ${count === 1 ? "container" : "containers"}` : undefined,
    memoryLimit !== undefined ? `${formatMemory(memory)} of ${formatMemory(memoryLimit)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="tabular-nums" title={title || undefined}>
      CPU {formatCpu(cpu)} · {formatMemory(memory)}
    </span>
  );
}
