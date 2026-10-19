import preview from "../../../.storybook/preview";
import { AccessPage } from "./access-gate";

const meta = preview.meta({
  component: AccessPage,
  parameters: { layout: "fullscreen" },
  title: "Pages/No access",
});

export const Default = meta.story();
