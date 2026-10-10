import { http, HttpResponse } from "msw";

import preview from "../../../../.storybook/preview";
import { App } from "../../app";
import { failing, pending } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/activity" },
  title: "Pages/Activity",
});

/** Everything across projects, newest first: tasks started, a variant failing, a branch published, a review run. */
export const AllProjects = meta.story();

export const OneProject = meta.story({
  parameters: { route: "/activity?project=acme-web" },
});

export const Empty = meta.story({
  beforeEach: mockApi(
    {},
    http.get("/api/activity", () => HttpResponse.json({ events: [] }))
  ),
});

export const Loading = meta.story({
  beforeEach: mockApi({}, pending("get", "/api/activity")),
});

export const LoadError = meta.story({
  beforeEach: mockApi(
    {},
    failing("get", "/api/activity", "the activity log is not available")
  ),
});
