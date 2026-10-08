import preview from "../../../.storybook/preview";
import { App } from "../app";

const meta = preview.meta({
  component: App,
  parameters: { route: "/does-not-exist" },
  title: "Pages/Not found",
});

export const Default = meta.story();
