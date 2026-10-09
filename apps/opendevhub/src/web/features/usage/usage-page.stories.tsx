import preview from "../../../../.storybook/preview";
import { App } from "../../app";
import { failing, pending } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/usage" },
  title: "Pages/Usage",
});

/** Thirty days of spend with today selected. */
export const Default = meta.story();

export const Loading = meta.story({
  beforeEach: mockApi({}, pending("get", "/api/usage")),
});

export const LedgerError = meta.story({
  beforeEach: mockApi(
    {},
    failing("get", "/api/usage", "usage ledger is locked by another process")
  ),
});
