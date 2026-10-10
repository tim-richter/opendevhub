import preview from "../../../../.storybook/preview";
import { App } from "../../app";

const meta = preview.meta({
  component: App,
  parameters: { route: "/p/acme-web" },
  title: "Pages/Project",
});

/** Main checkout, two worktrees (one in its own container) and a task still starting. */
export const Overview = meta.story();

/** A task with two variants to compare and pick from. */
export const WithVariants = meta.story({
  parameters: { route: "/p/billing-api" },
});

export const Stopped = meta.story({ parameters: { route: "/p/legacy-cms" } });

export const ContainerError = meta.story({
  parameters: { route: "/p/ml-pipeline" },
});

/** A task's hub: its variants, reviews and activity. */
export const Task = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** Two variants of one task side by side, in the hub's Compare tab. */
export const TaskCompare = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round?tab=compare" },
});

/** A session started on its own: one row, no comparison. */
export const ManualTask = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_dark" },
});

/** A task whose variants are still being set up; one failed. */
export const TaskStarting = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_search" },
});

/** A task started from a Jira ticket, with the ticket's status and the pull request its variant was published as. */
export const TaskFromTicket = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate" },
});

/** An AI review task, headed by the pull request it reviewed. */
export const ReviewTask = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_review42" },
});
