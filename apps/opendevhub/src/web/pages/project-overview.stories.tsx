import preview from "../../../.storybook/preview";
import { App } from "../app";

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

/** Two variants of one task side by side. */
export const Task = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** A task whose variants are still being set up; one failed. */
export const TaskStarting = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_search" },
});
