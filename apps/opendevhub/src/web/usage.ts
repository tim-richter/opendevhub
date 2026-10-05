import type { DashboardSnapshot, Usage } from "../shared/types";
import { formatCost, formatTokens } from "./tasks";

const NONE: Usage = { cost: 0, tokens: 0 };

export function formatUsage(u: Usage): string {
  return `${formatCost(u.cost)} · ${formatTokens(u.tokens)} tokens`;
}

/** A project's spend today and all time; undefined when there's no ledger, zeros when it spent nothing. */
export function projectUsage(snapshot: DashboardSnapshot | undefined, projectId: string): { today: Usage; total: Usage } | undefined {
  if (!snapshot?.usage) return undefined;
  return snapshot.usage.projects[projectId] ?? { today: NONE, total: NONE };
}

/** A task's spend, discarded variants included; undefined when there's no ledger or nothing was booked. */
export function taskUsage(snapshot: DashboardSnapshot | undefined, task: string): Usage | undefined {
  return snapshot?.usage?.tasks[task];
}
