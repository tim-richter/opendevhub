import preview from "../../../.storybook/preview";
import { App } from "../app";
import { integrationOff } from "../mocks/fixtures";
import { pending } from "../mocks/handlers";
import { mockApi } from "../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/forgejo" },
  title: "Pages/Forgejo",
});

/** The pull request inbox, with a stacked PR under its parent. */
export const PullRequests = meta.story();

/** One pull request: description, stack, approvals, CI checks, reviews and the diff. */
export const PullRequest = meta.story({
  parameters: { route: "/forgejo/acme/web/42" },
});

export const PullRequestLoading = meta.story({
  beforeEach: mockApi(
    {},
    pending("get", "/api/forgejo/pulls/:owner/:repo/:number")
  ),
  parameters: { route: "/forgejo/acme/web/42" },
});

export const NotConfigured = meta.story({
  beforeEach: mockApi({ forgejo: integrationOff }),
});
