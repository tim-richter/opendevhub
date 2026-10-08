import preview from "../../../.storybook/preview";
import { App } from "../app";
import { emptySnapshot } from "../mocks/fixtures";
import { mockApi } from "../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/nodes" },
  title: "Pages/Nodes",
});

/** This machine, a build box over ssh and one that can't be reached. */
export const Default = meta.story();

export const LocalOnly = meta.story({
  beforeEach: mockApi({ snapshot: emptySnapshot }),
});
