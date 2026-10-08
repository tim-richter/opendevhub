import preview from "../../../.storybook/preview";
import { ResourceStat } from "./resource-stat";

const GIB = 1024 ** 3;

const meta = preview.meta({
  args: { cpu: 37, memory: 1.8 * GIB, memoryLimit: 8 * GIB },
  component: ResourceStat,
  parameters: { layout: "centered" },
  title: "Components/ResourceStat",
});

export const OneContainer = meta.story();

/** Summed over several containers: CPU above 100% means more than one core. */
export const SeveralContainers = meta.story({
  args: { count: 3, cpu: 183, memory: 5.1 * GIB, memoryLimit: undefined },
});
