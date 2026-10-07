import type {
  DashboardSnapshot,
  ProjectView,
  ResourceStats,
} from "../shared/types";
import type { Checkout } from "./checkouts";
import { envOfDirectory } from "./derive";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Percent of one core, as `docker stats` shows it. */
export const formatCpu = (cpu: number): string => `${cpu}%`;

export const formatMemory = (bytes: number): string =>
  bytes < GiB
    ? `${Math.round(bytes / MiB)} MiB`
    : `${(bytes / GiB).toFixed(1)} GiB`;

/** No limit: a container without one reports the host's memory, so a sum would count the host once per container. */
export interface ProjectResources {
  cpu: number;
  memory: number;
  /** Containers with stats. */
  count: number;
}

/** The project's main and task containers added up; undefined when none has stats. */
export const projectResources = (
  snapshot: DashboardSnapshot | undefined,
  view: ProjectView
): ProjectResources | undefined => {
  const all = snapshot?.resources;
  if (!all) {
    return undefined;
  }
  const found = [view.project.id, ...view.environments.map((e) => e.id)]
    .map((id) => all[id])
    .filter((s): s is ResourceStats => s !== undefined);
  if (found.length === 0) {
    return undefined;
  }
  return {
    count: found.length,
    cpu: found.reduce((n, s) => n + s.cpu, 0),
    memory: found.reduce((n, s) => n + s.memory, 0),
  };
};

/** The numbers of the container a checkout runs in; undefined for a worktree sharing the main one, already counted there. */
export const checkoutResources = (
  snapshot: DashboardSnapshot | undefined,
  view: ProjectView,
  checkout: Checkout
): ResourceStats | undefined => {
  if (!checkout.worktree) {
    return snapshot?.resources?.[view.project.id];
  }
  const env = envOfDirectory(view, checkout.directory);
  return env ? snapshot?.resources?.[env.id] : undefined;
};
