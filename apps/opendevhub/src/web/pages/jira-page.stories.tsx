import preview from "../../../.storybook/preview";
import { App } from "../app";
import { integrationOff } from "../mocks/fixtures";
import { failing } from "../mocks/handlers";
import { mockApi } from "../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/jira" },
  title: "Pages/Jira",
});

export const Tickets = meta.story();

export const Ticket = meta.story({ parameters: { route: "/jira/ACME-118" } });

export const NotConfigured = meta.story({
  beforeEach: mockApi({ jira: integrationOff }),
});

export const SearchFailed = meta.story({
  beforeEach: mockApi(
    {},
    failing("get", "/api/jira/tickets", "Jira answered 401: token expired", 502)
  ),
});
