import { CpuIcon, MemoryStickIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { formatCpu, formatMemory } from "../resources";
import { Tip } from "./Tip";

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
  const tag = "gap-1 font-normal text-muted-foreground tabular-nums";
  return (
    <span className={cn("inline-flex items-center gap-1.5", props.className)}>
      <Tip label={`CPU ${formatCpu(cpu)}${containers}`}>
        <Badge variant="outline" className={tag}>
          <CpuIcon aria-label="CPU" /> {formatCpu(cpu)}
        </Badge>
      </Tip>
      <Tip
        label={
          memoryLimit === undefined
            ? `Memory ${formatMemory(memory)}${containers}`
            : `Memory ${formatMemory(memory)} of ${formatMemory(memoryLimit)}`
        }
      >
        <Badge variant="outline" className={tag}>
          <MemoryStickIcon aria-label="Memory" /> {formatMemory(memory)}
        </Badge>
      </Tip>
    </span>
  );
};
