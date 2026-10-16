import { userEvent, within } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { ChecksSettings } from "./checks-settings";

const meta = preview.meta({
  args: { projectId: "acme-web" },
  component: ChecksSettings,
  decorators: [
    (Story) => (
      <div className="max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
  title: "Checks/Settings",
});

/** Grouped checks sit under their group's name. */
export const Default = meta.story();

/** Groups are boxes of their own: rename them, add checks to them, drag checks in and out by the handle. */
export const Editing = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit" }));
  },
});

/** Your own checks laid into the team's list, to review before saving to devcontainer.json. */
export const CopyToTeam = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Copy mine to team" })
    );
  },
});

/** A group just added takes the focus for its name. */
export const AddGroup = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add group" })
    );
  },
});
