import { barY, defineChart } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
import type { UsageReport } from "../../shared/types";
import { formatCost, formatTokens } from "../tasks";
import { dayLabel } from "../usage";

/**
 * Cost or tokens per day as columns, the chosen day in full color. Clicking a column chooses its day. Import it
 * through `LazyUsageChart` so the chart library loads only on the Usage page.
 */
export default function UsageChart(props: {
  days: UsageReport["days"];
  metric: "cost" | "tokens";
  selected: string;
  onSelect: (day: string) => void;
}) {
  const { days, metric, selected } = props;
  const formatValue = metric === "cost" ? formatCost : formatTokens;
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barY(days, {
            x: "day",
            y: metric,
            fill: (d) => (d.day === selected ? "var(--primary)" : "color-mix(in oklab, var(--primary) 40%, transparent)"),
            radius: { end: 4 },
            maxThickness: 24,
          }),
        ],
        scales: {
          x: {
            scale: () => scaleBand().padding(0.2),
            // A label every week, ending today, so they stay evenly spaced.
            axis: {
              ticks: {
                size: 0,
                values: days.filter((_, i) => (days.length - 1 - i) % 7 === 0).map((d) => d.day),
                format: (day) => dayLabel(day, { month: "short", day: "numeric" }),
              },
            },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { line: false, ticks: { size: 0, format: (v) => formatValue(v) } },
          },
        },
        tooltip: {
          use: tooltip,
          sticky: false,
          format: (point) => `${dayLabel(point.datum.day)}\n${formatCost(point.datum.cost)} · ${formatTokens(point.datum.tokens)} tokens`,
        },
      }),
    [days, metric, selected, formatValue],
  );
  return (
    <Chart
      definition={definition}
      height={220}
      className="text-muted-foreground"
      ariaLabel={`${metric === "cost" ? "Cost" : "Tokens"} per day`}
      ariaDescription={`${metric === "cost" ? "Cost" : "Tokens"} per day for the ${days.length} days ending today. Activate a day to show it below.`}
      onSelect={(point) => {
        if (point) props.onSelect(point.datum.day);
      }}
    />
  );
}
