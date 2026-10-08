import preview from "../../../.storybook/preview";
import { App } from "../app";
import { failing, pending } from "../mocks/handlers";
import { mockApi } from "../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/p/acme-web/w/rate-limit" },
  title: "Pages/Checkout",
});

/** A worktree's sessions, one waiting on a permission. */
export const Sessions = meta.story();

export const MainCheckout = meta.story({
  parameters: { route: "/p/acme-web/main" },
});

/** Changed files, diffs, checks and the commit / publish actions. */
export const Review = meta.story({
  parameters: { route: "/p/acme-web/w/rate-limit/review" },
});

export const ReviewLoading = meta.story({
  beforeEach: mockApi({}, pending("get", "/api/projects/:id/review")),
  parameters: { route: "/p/acme-web/w/rate-limit/review" },
});

export const ReviewError = meta.story({
  beforeEach: mockApi(
    {},
    failing("get", "/api/projects/:id/review", "fatal: bad revision 'main'")
  ),
  parameters: { route: "/p/acme-web/w/rate-limit/review" },
});

/** Ports, container state and logs. */
export const Runtime = meta.story({
  parameters: { route: "/p/acme-web/main/runtime" },
});

/** A worktree that runs in its own container. */
export const IsolatedWorktree = meta.story({
  parameters: { route: "/p/acme-web/w/dark-mode" },
});
