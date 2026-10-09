import preview from "../../../../.storybook/preview";
import { App } from "../../app";
import { integrationOff } from "../../mocks/fixtures";
import { mockApi } from "../../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/settings" },
  title: "Pages/Settings",
});

/** Jira and Forgejo connected. */
export const Default = meta.story();

export const IntegrationsOff = meta.story({
  beforeEach: mockApi({ forgejo: integrationOff, jira: integrationOff }),
});
