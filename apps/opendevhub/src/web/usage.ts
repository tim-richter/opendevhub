import type { DashboardSnapshot, Usage } from "../shared/types";
import { formatCost, formatTokens } from "./tasks";

const NONE: Usage = { cost: 0, tokens: 0 };

export const formatUsage = (u: Usage): string =>
  `${formatCost(u.cost)} · ${formatTokens(u.tokens)} tokens`;

/** A project's spend today and all time; undefined when there's no ledger, zeros when it spent nothing. */
export const projectUsage = (
  snapshot: DashboardSnapshot | undefined,
  projectId: string
): { today: Usage; total: Usage } | undefined => {
  if (!snapshot?.usage) {
    return undefined;
  }
  return snapshot.usage.projects[projectId] ?? { today: NONE, total: NONE };
};

/** A task's spend, discarded variants included; undefined when there's no ledger or nothing was booked. */
export const taskUsage = (
  snapshot: DashboardSnapshot | undefined,
  task: string
): Usage | undefined => snapshot?.usage?.tasks[task];

/** The YYYY-MM-DD `n` days after `day` (before, when negative), in local time. */
export const shiftDay = (day: string, n: number): string => {
  const [y, m, d] = day.split("-").map(Number);
  // Noon keeps a DST change from pushing the date across midnight.
  const t = new Date(y, m - 1, d + n, 12);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
};

/** "Mon, Oct 5" for a YYYY-MM-DD day. */
const DEFAULT_DAY_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  weekday: "short",
};

export const dayLabel = (
  day: string,
  opts: Intl.DateTimeFormatOptions = DEFAULT_DAY_FORMAT
): string => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, opts);
};

/** A project's name, or its id once it's no longer on the dashboard. */
export const projectName = (
  snapshot: DashboardSnapshot | undefined,
  projectId: string
): string =>
  snapshot?.projects.find((v) => v.project.id === projectId)?.project.name ??
  projectId;

/** `part` as a whole percentage of `whole`. */
export const share = (part: number, whole: number): string => {
  if (whole <= 0) {
    return "—";
  }
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
};
