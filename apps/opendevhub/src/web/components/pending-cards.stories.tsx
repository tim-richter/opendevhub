import { expect, userEvent, within } from "storybook/test";

import preview from "../../../.storybook/preview";
import type { SessionSummary } from "../../shared/types";
import { webProject } from "../mocks/fixtures";
import { failing } from "../mocks/handlers";
import { mockApi } from "../mocks/story";
import { PendingStack } from "./pending-cards";

const byId = (id: string): SessionSummary => {
  const session = webProject.sessions.find((s) => s.id === id);
  if (!session) {
    throw new Error(`No fixture session ${id}`);
  }
  return session;
};

const permission = byId("ses_perm01");

const meta = preview.meta({
  args: { session: permission, view: webProject },
  component: PendingStack,
  parameters: { layout: "padded" },
  title: "Components/PendingStack",
});

export const Permission = meta.story();

/** An edit request carries its diff. */
export const PermissionWithDiff = meta.story({
  args: {
    session: {
      ...permission,
      pending: {
        forms: [],
        permissions: [
          {
            action: "edit",
            diff: "--- a/src/server/rate-limit.ts\n+++ b/src/server/rate-limit.ts\n@@ -1,2 +1,3 @@\n const WINDOW_MS = 60_000;\n+const MAX_BURST = 20;\n \n",
            id: "per_02",
            resources: ["src/server/rate-limit.ts"],
            sessionId: permission.id,
          },
        ],
      },
    },
  },
});

export const Question = meta.story({ args: { session: byId("ses_form01") } });

/** Answering fails: the card shows the server's error. */
export const ReplyFails = meta.story({
  beforeEach: mockApi(
    {},
    failing(
      "post",
      "/api/projects/:id/permissions/:request",
      "opencode is not reachable"
    )
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /allow once/iu }));
    await expect(
      await canvas.findByText(/opencode is not reachable/iu)
    ).toBeVisible();
  },
});
