import { fn } from "storybook/test";

import preview from "../../../.storybook/preview";
import { CommandPalette } from "./command-palette";

const meta = preview.meta({
  args: { onClose: fn(), open: true },
  component: CommandPalette,
  title: "Components/CommandPalette",
});

/** Pages, projects, checkouts and sessions from the mocked snapshot, plus actions. */
export const Open = meta.story();
