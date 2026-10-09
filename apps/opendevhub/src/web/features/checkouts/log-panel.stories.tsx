import preview from "../../../../.storybook/preview";
import { logLines } from "../../mocks/fixtures";
import { LogPanel } from "./log-panel";

const meta = preview.meta({
  args: { lines: logLines },
  component: LogPanel,
  parameters: { layout: "padded" },
  title: "Components/LogPanel",
});

export const Default = meta.story();

export const Empty = meta.story({ args: { lines: [] } });

export const Long = meta.story({
  args: {
    lines: Array.from(
      { length: 300 },
      (_, i) => `[build] step ${i + 1}/300: compiling module ${i + 1}`
    ),
  },
});
