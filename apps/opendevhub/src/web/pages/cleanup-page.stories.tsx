import preview from "../../../.storybook/preview";
import { App } from "../app";
import { failing, pending } from "../mocks/handlers";
import { mockApi } from "../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/cleanup" },
  title: "Pages/Cleanup",
});

/** Merged branches, an orphaned container, a superseded image and a discarded session. */
export const Default = meta.story();

export const Scanning = meta.story({
  beforeEach: mockApi({}, pending("get", "/api/cleanup")),
});

export const ScanFailed = meta.story({
  beforeEach: mockApi(
    {},
    failing("get", "/api/cleanup", "docker: permission denied")
  ),
});
