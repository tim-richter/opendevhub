import { fn } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { usageReport } from "../../mocks/fixtures";
import { UsageChart } from "./lazy-usage-chart";

const meta = preview.meta({
  args: {
    days: usageReport.days,
    metric: "cost" as const,
    onSelect: fn(),
    selected: usageReport.day,
  },
  argTypes: {
    metric: { control: "inline-radio", options: ["cost", "tokens"] },
  },
  component: UsageChart,
  parameters: { layout: "padded" },
  title: "Components/UsageChart",
});

export const Cost = meta.story();

export const Tokens = meta.story({ args: { metric: "tokens" as const } });

export const EarlierDaySelected = meta.story({
  args: { selected: usageReport.days[10].day },
});
