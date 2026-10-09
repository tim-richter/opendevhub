import type { SessionTurn, TokenBreakdown } from "../shared/types";
import { formatDuration } from "./checks";
import { formatTokens } from "./tasks";

/** How full the context window is, 0 to 1; undefined when either number is unknown. */
export const contextShare = (
  context: number | undefined,
  limit: number | undefined
): number | undefined =>
  context === undefined || !limit ? undefined : Math.min(1, context / limit);

/** "in 12.0k · out 900 · cache 40.1k read, 2.0k written", leaving out the kinds that are zero. */
export const breakdownLabel = (t: TokenBreakdown): string => {
  const parts = [
    t.input > 0 && `in ${formatTokens(t.input)}`,
    t.output > 0 && `out ${formatTokens(t.output)}`,
    t.reasoning > 0 && `reasoning ${formatTokens(t.reasoning)}`,
  ].filter(Boolean);
  const cache = [
    t.cacheRead > 0 && `${formatTokens(t.cacheRead)} read`,
    t.cacheWrite > 0 && `${formatTokens(t.cacheWrite)} written`,
  ].filter(Boolean);
  if (cache.length > 0) {
    parts.push(`cache ${cache.join(", ")}`);
  }
  return parts.join(" · ");
};

/** How long a finished turn took; undefined while it runs. */
export const turnDuration = (
  turn: SessionTurn,
  running: boolean
): string | undefined =>
  running || !turn.completed
    ? undefined
    : formatDuration(Math.max(0, turn.completed - turn.created));

const n = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** "3 steps · 12 tool calls (1 failed) · 4 files", leaving out what is zero. */
export const turnActivity = (turn: SessionTurn): string =>
  [
    turn.steps > 0 && n(turn.steps, "step"),
    turn.tools > 0 &&
      `${n(turn.tools, "tool call")}${turn.failedTools > 0 ? ` (${turn.failedTools} failed)` : ""}`,
    turn.files > 0 && n(turn.files, "file"),
  ]
    .filter(Boolean)
    .join(" · ");
