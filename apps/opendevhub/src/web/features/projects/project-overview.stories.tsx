import { http, HttpResponse } from "msw";

import preview from "../../../../.storybook/preview";
import { App } from "../../app";
import { mockApi } from "../../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/p/acme-web" },
  title: "Pages/Project",
});

/** Main checkout, two worktrees (one in its own container) and a task still starting. */
export const Overview = meta.story();

export const ArchivedTasks = meta.story({
  parameters: { route: "/p/acme-web?tasks=archived" },
  beforeEach: mockApi(
    {},
    http.get("/api/projects/:id/tasks/archived", () =>
      HttpResponse.json([
        {
          id: "tsk_archived",
          title: "Finish the migration",
          kind: "task",
          variants: 2,
          archivedAt: Date.now(),
        },
      ])
    )
  ),
});

/** A task with two variants to compare and pick from. */
export const WithVariants = meta.story({
  parameters: { route: "/p/billing-api" },
});

export const Stopped = meta.story({ parameters: { route: "/p/legacy-cms" } });

export const ContainerError = meta.story({
  parameters: { route: "/p/ml-pipeline" },
});

/** A task with two variants: the variant switcher above its tabs, on variant 1's conversation. */
export const Task = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** Two variants of one task side by side, in the Compare tab. */
export const TaskCompare = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round/compare" },
});

/** A task's terminal and runtime, from its variant's worktree. */
export const TaskRuntime = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate/runtime" },
});

/** A task made from a chat: one variant, so no variant switcher and no Compare tab. */
export const TaskFromChat = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** A draft: its brief, ticket and plan instead of the tabs, with Start and Edit. */
export const DraftTask = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_sso" },
});

/** A task whose variants are still being set up; one failed. */
export const TaskStarting = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_search" },
});

/**
 * A task started from a Jira ticket, with the ticket's status and the pull request its variant was published as; its
 * Conversation tab waits on a permission.
 */
export const TaskFromTicket = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate" },
});

/** An AI review task, headed by the pull request it reviewed. */
export const ReviewTask = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_review42" },
});
