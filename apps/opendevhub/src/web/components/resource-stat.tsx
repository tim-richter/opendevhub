import { cn } from "@/lib/utils";

import { formatCpu, formatMemory } from "../lib/resources";
import { Tip } from "./tip";

/** Two tags, CPU and memory; the tooltips have the container count and the memory limit. */
export const ResourceStat = (props: {
  cpu: number;
  memory: number;
  memoryLimit?: number;
  count?: number;
  className?: string;
}) => {
  const { cpu, memory, memoryLimit, count } = props;
  const containers =
    count === undefined
      ? ""
      : ` · ${count} ${count === 1 ? "container" : "containers"}`;
  const value = "text-foreground/80 font-medium";
  return (
    <span
      className={cn(
        "text-muted-foreground inline-flex items-center gap-3 text-xs whitespace-nowrap tabular-nums",
        props.className
      )}
    >
      <Tip label={`CPU ${formatCpu(cpu)}${containers}`}>
        <span tabIndex={0}>
          CPU <span className={value}>{formatCpu(cpu)}</span>
        </span>
      </Tip>
      <Tip
        label={
          memoryLimit === undefined
            ? `Memory ${formatMemory(memory)}${containers}`
            : `Memory ${formatMemory(memory)} of ${formatMemory(memoryLimit)}`
        }
      >
        <span tabIndex={0}>
          RAM <span className={value}>{formatMemory(memory)}</span>
        </span>
      </Tip>
    </span>
  );
};
