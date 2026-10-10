import preview from "../../../../.storybook/preview";
import type { Origin } from "./activity";
import { CreatedByChip } from "./created-by-chip";

const variant: Origin = {
  by: "variant",
  n: 1,
  task: "tsk_rate",
  title: "Add burst limit to the login rate limiter",
};
const manual: Origin = { by: "manual" };
const pull: Origin = {
  by: "pull",
  url: "https://git.acme.dev/acme/web/pulls/42",
};
const unmanaged: Origin = { by: "unmanaged" };

const meta = preview.meta({
  args: { origin: variant, projectId: "acme-web" },
  component: CreatedByChip,
  parameters: { layout: "centered" },
  title: "Components/CreatedByChip",
});

/** Made by variant 1 of a task; links to the task page. */
export const TaskVariant = meta.story();

export const Manual = meta.story({ args: { origin: manual } });

export const PullRequestCheckout = meta.story({ args: { origin: pull } });

export const OutsideOpendevhub = meta.story({ args: { origin: unmanaged } });
