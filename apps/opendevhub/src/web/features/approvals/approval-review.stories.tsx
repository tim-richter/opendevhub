import preview from "../../../../.storybook/preview";
import {
  configApproval,
  firstConfigApproval,
  webProject,
} from "../../mocks/fixtures";
import { ApprovalBanner, ApprovalReview } from "./approval-review";

const view = { ...webProject, approvals: [configApproval] };

const meta = preview.meta({
  args: { approval: configApproval, view },
  component: ApprovalBanner,
  parameters: { layout: "padded" },
  title: "Features/Config approval",
});

/** On the project overview. */
export const Banner = meta.story();

/** On a worktree row or a variant card. */
export const CompactBanner = meta.story({ args: { compact: true } });

/** The review stays open in its story. */
const keepOpen = (open: boolean) => open;

/** A changed Compose file, a new initializeCommand and a feature's mount against the last approval. */
export const Review = meta.story({
  render: (args) => (
    <ApprovalReview
      view={args.view}
      approval={args.approval}
      open
      onOpenChange={keepOpen}
    />
  ),
});

/** The project's first approval: every setting is added. */
export const FirstReview = meta.story({
  args: { approval: firstConfigApproval },
  render: (args) => (
    <ApprovalReview
      view={args.view}
      approval={args.approval}
      open
      onOpenChange={keepOpen}
    />
  ),
});
