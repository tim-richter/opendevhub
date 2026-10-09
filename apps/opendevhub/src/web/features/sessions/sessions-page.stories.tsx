import preview from "../../../../.storybook/preview";
import { App } from "../../app";
import { emptySnapshot } from "../../mocks/fixtures";
import { mockApi } from "../../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/sessions" },
  title: "Pages/Sessions",
});

/** Every session across projects, waiting ones first. */
export const Default = meta.story();

export const NoSessions = meta.story({
  beforeEach: mockApi({ snapshot: emptySnapshot }),
});
