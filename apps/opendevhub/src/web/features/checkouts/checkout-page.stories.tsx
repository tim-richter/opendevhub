import { http, HttpResponse } from "msw";
import { expect, userEvent, within } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { App } from "../../app";
import { failing, pending } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/p/acme-web/w/dark-mode" },
  title: "Pages/Checkout",
});

/** A worktree no task created: the tasks whose conversations run there. */
export const Tasks = meta.story();

export const MainCheckout = meta.story({
  parameters: { route: "/p/acme-web/main" },
});

/** Changed files, diffs, checks and the commit / publish actions. */
export const Changes = meta.story({
  parameters: { route: "/p/acme-web/main/review" },
});

/** One conversation: its transcript with the composer pinned to the bottom, and the usage button in its header. */
export const Conversation = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate" },
});

/** The Turns panel beside the transcript, the newest turn with its changes open. */
export const ConversationTurns = meta.story({
  beforeEach: () => {
    localStorage.setItem("opendevhub.conversation.panel", "turns");
    return () => localStorage.removeItem("opendevhub.conversation.panel");
  },
  parameters: { route: "/p/acme-web/t/tsk_rate" },
});

export const ConversationLoading = meta.story({
  beforeEach: mockApi(
    {},
    pending("get", "/api/projects/:id/sessions/:session")
  ),
  parameters: { route: "/p/acme-web/t/tsk_rate" },
});

export const ChangesLoading = meta.story({
  beforeEach: mockApi({}, pending("get", "/api/projects/:id/review")),
  parameters: { route: "/p/acme-web/main/review" },
});

export const ChangesError = meta.story({
  beforeEach: mockApi(
    {},
    failing("get", "/api/projects/:id/review", "fatal: bad revision 'main'")
  ),
  parameters: { route: "/p/acme-web/main/review" },
});

/** An old session link: lands on the session's task, variant selected. */
export const OldSessionLink = meta.story({
  parameters: { route: "/p/acme-web/w/rate-limit/s/ses_perm01" },
});

/** The project's shared container: its controls (Stop and Rebuild name the checkouts they affect), ports and logs. */
export const Runtime = meta.story({
  parameters: { route: "/p/acme-web/main/runtime" },
});

/** A worktree's own container: it can also be removed, and Setup shows only its own lines. */
export const RuntimeOwnContainer = meta.story({
  parameters: { route: "/p/acme-web/w/dark-mode/runtime" },
});

/** A stopped container: Start instead of Stop, opencode's log says why it can't be read, and Saved permissions asks to start it. */
export const RuntimeStopped = meta.story({
  beforeEach: mockApi(
    {},
    http.get("/api/projects/:id/envs/:env/logs", ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("source") === "opencode"
          ? {
              lines: [],
              unavailable:
                "The container is stopped, so opencode's log can't be read.",
            }
          : { lines: [{ at: 0, text: "environment: stopped" }] }
      )
    )
  ),
  parameters: { route: "/p/legacy-cms/main/runtime" },
});

/** Saved permissions with none saved yet. */
export const SavedPermissionsEmpty = meta.story({
  beforeEach: mockApi({ savedPermissions: { canEdit: true, rules: [] } }),
  parameters: { route: "/p/acme-web/main/runtime" },
});

/** Editing a saved rule inline: a pattern that allows everything asks first. */
export const SavedPermissionsEdit = meta.story({
  parameters: { route: "/p/acme-web/main/runtime" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [edit] = await canvas.findAllByRole("button", { name: "Edit" });
    await userEvent.click(edit);
    const pattern = await canvas.findByRole("textbox", { name: "Pattern" });
    await userEvent.clear(pattern);
    await userEvent.type(pattern, "pnpm test:unit *");
    await expect(pattern).toHaveValue("pnpm test:unit *");
  },
});

/** On opencode 2.0.x rules can only be removed. */
export const SavedPermissionsOldOpencode = meta.story({
  beforeEach: mockApi({
    savedPermissions: {
      canEdit: false,
      rules: [
        {
          action: "bash",
          createdAt: Date.now() - 3_600_000,
          id: "per_old",
          resource: "pnpm *",
          updatedAt: Date.now() - 3_600_000,
        },
      ],
    },
  }),
  parameters: { route: "/p/acme-web/main/runtime" },
});

/** A worktree that runs in its own container. */
export const IsolatedWorktree = meta.story({
  parameters: { route: "/p/acme-web/w/dark-mode" },
});
