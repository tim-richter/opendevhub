import preview from "../../../../.storybook/preview";
import { RATE_LIMIT_PATCH } from "../../mocks/fixtures";
import { PatchView } from "./lazy-patch-view";

const meta = preview.meta({
  args: { name: "src/server/rate-limit.ts", patch: RATE_LIMIT_PATCH },
  component: PatchView,
  parameters: { layout: "padded" },
  title: "Components/PatchView",
});

export const Unified = meta.story();

export const Split = meta.story({ args: { split: true } });

export const Collapsed = meta.story({ args: { collapsed: true } });
