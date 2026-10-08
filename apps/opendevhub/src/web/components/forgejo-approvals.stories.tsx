import { http, HttpResponse } from "msw";

import preview from "../../../.storybook/preview";
import type { ForgejoApprovals as Approvals } from "../../shared/forgejo";
import { forgejoPulls } from "../mocks/fixtures";
import { mockApi } from "../mocks/story";
import { ForgejoApprovals } from "./forgejo-approvals";

const approvals = (body: Approvals) =>
  mockApi(
    {},
    http.get("/api/forgejo/pulls/:owner/:repo/:number/approvals", () =>
      HttpResponse.json(body)
    )
  );

const meta = preview.meta({
  args: { pull: forgejoPulls[0] },
  component: ForgejoApprovals,
  parameters: { layout: "centered" },
  title: "Components/ForgejoApprovals",
});

export const ChangesRequested = meta.story();

export const Approved = meta.story({
  beforeEach: approvals({
    approvedBy: ["alex", "sam"],
    base: "main",
    changesRequestedBy: [],
    required: 2,
  }),
});

export const NeedsMoreApprovals = meta.story({
  beforeEach: approvals({
    approvedBy: ["alex"],
    base: "main",
    changesRequestedBy: [],
    required: 2,
  }),
});

export const UnprotectedBranch = meta.story({
  beforeEach: approvals({
    approvedBy: [],
    base: "main",
    changesRequestedBy: [],
  }),
});
