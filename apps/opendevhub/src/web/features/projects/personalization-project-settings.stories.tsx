import { userEvent, within } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { App } from "../../app";

const openSection = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole("button", { name: "Project settings" })
  );
  await userEvent.click(
    await canvas.findByRole("button", { name: /Personalization/u })
  );
};

const meta = preview.meta({
  component: App,
  parameters: { route: "/p/acme-web" },
  play: ({ canvasElement }) => openSection(canvasElement),
  title: "Projects/Personalization settings",
});

/** The project uses the global personalization and adds nothing. */
export const InheritsGlobal = meta.story();

/** A feature row with options that aren't JSON. */
export const InvalidOptions = meta.story({
  play: async ({ canvasElement }) => {
    await openSection(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add feature" })
    );
    await userEvent.type(
      await canvas.findByPlaceholderText("ghcr.io/owner/repo/feature:1"),
      "ghcr.io/devcontainers/features/node:1"
    );
    await userEvent.type(
      await canvas.findByPlaceholderText(/Options as JSON/u),
      "{{version"
    );
  },
});
