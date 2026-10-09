import preview from "../../../.storybook/preview";
import { App } from "../app";
import { emptySnapshot, preflightSnapshot } from "../mocks/fixtures";
import { mockApi } from "../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/" },
  title: "Pages/Overview",
});

/** Four projects: one needing attention, a multi-variant task, a stopped and a broken container. */
export const Default = meta.story();

/** First run: no folders to scan yet; links to Settings. */
export const NoFolders = meta.story({
  beforeEach: mockApi({ snapshot: { ...emptySnapshot, roots: [] } }),
});

/** Folders are set but hold no projects yet. */
export const NoProjects = meta.story({
  beforeEach: mockApi({ snapshot: emptySnapshot }),
});

/** Docker or the devcontainer CLI is missing. */
export const PreflightErrors = meta.story({
  beforeEach: mockApi({ snapshot: preflightSnapshot }),
});

/** The event stream is open but no snapshot has arrived yet. */
export const Connecting = meta.story({
  beforeEach: mockApi({ snapshot: null }),
});
