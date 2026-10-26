import { cn } from "@/lib/utils";

import type { PositionRow } from "./base-status";

const ROW_H = 28;
const LANE_X = [8, 24] as const;
const COUNT_GAP = 6;
const GRAPH_W = 52;
const DOT_R = 4;
const MAX_COUNT = 999;

const countLabel = (n: number): string =>
  n > MAX_COUNT ? `${MAX_COUNT}+` : String(n);

const centre = (i: number): number => i * ROW_H + ROW_H / 2;

/** The line from row `i - 1` down to row `i`: straight within a lane, a curve where the branch leaves the base. */
const edgePath = (from: PositionRow, to: PositionRow, i: number): string => {
  const x1 = LANE_X[from.lane];
  const x2 = LANE_X[to.lane];
  const y1 = centre(i - 1);
  const y2 = centre(i);
  if (x1 === x2) {
    return `M${x1} ${y1}V${y2}`;
  }
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
};

/**
 * Where a branch stands, one row per ref with the commits between neighbours counted on their edge, so it is as tall
 * whatever the number of commits. Drawn without a mount animation: it's seen many times a day.
 */
export const BranchPosition = ({
  rows,
  label,
}: {
  rows: PositionRow[];
  label: string;
}) => {
  const height = rows.length * ROW_H;
  return (
    <figure aria-label={label} className="m-0 flex min-w-0 gap-1">
      <svg
        aria-hidden
        width={GRAPH_W}
        height={height}
        viewBox={`0 0 ${GRAPH_W} ${height}`}
        className="shrink-0 overflow-visible"
      >
        {rows.map((row, i) => {
          const prev = rows[i - 1];
          if (!prev) {
            return null;
          }
          const count = row.edge;
          const x = Math.max(LANE_X[prev.lane], LANE_X[row.lane]) + COUNT_GAP;
          return (
            <g key={`edge-${row.key}`}>
              <path
                d={edgePath(prev, row, i)}
                fill="none"
                strokeWidth={1.5}
                className={cn(
                  "stroke-border transition-[stroke] duration-150",
                  count !== undefined && count > 0 && "stroke-muted-foreground"
                )}
              />
              {count !== undefined && count > 0 && (
                <text
                  x={x}
                  y={i * ROW_H + 3}
                  className="fill-muted-foreground font-mono text-[10px] tabular-nums transition-opacity duration-150"
                >
                  {countLabel(count)}
                </text>
              )}
            </g>
          );
        })}
        {rows.map((row, i) => (
          <circle
            key={`dot-${row.key}`}
            cx={LANE_X[row.lane]}
            cy={centre(i)}
            r={DOT_R}
            strokeWidth={1.5}
            className={cn(
              "transition-[fill,stroke] duration-150",
              row.key === "head"
                ? "fill-primary stroke-primary"
                : "fill-background stroke-muted-foreground",
              row.key === "branched" && "stroke-border"
            )}
          />
        ))}
      </svg>
      <ol className="flex min-w-0 flex-1 flex-col">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex min-w-0 items-baseline gap-2 text-xs"
            style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}
          >
            <span
              title={row.label}
              className={cn(
                "min-w-[10ch] truncate",
                row.mono ? "font-mono" : "text-muted-foreground",
                row.key === "head" && "font-medium"
              )}
            >
              {row.label}
            </span>
            {row.note && (
              <span
                title={row.note}
                className={cn(
                  "ml-auto shrink-0 tabular-nums transition-colors duration-150",
                  row.tone === "warn" && "text-warn",
                  row.tone === "ok" && "text-ok",
                  !row.tone && "text-muted-foreground"
                )}
              >
                {row.note}
              </span>
            )}
          </li>
        ))}
      </ol>
    </figure>
  );
};
