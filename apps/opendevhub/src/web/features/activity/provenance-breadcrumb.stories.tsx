import preview from "../../../../.storybook/preview";
import { provenanceOf, removedTrail } from "../../mocks/fixtures";
import { ProvenanceTrail } from "./provenance-breadcrumb";

const meta = preview.meta({
  args: { provenance: provenanceOf("session", "ses_perm01") ?? removedTrail },
  component: ProvenanceTrail,
  parameters: { layout: "padded" },
  title: "Components/ProvenanceTrail",
});

/** A session of a ticket's task, from the ticket down, with the pull request and review it led to. */
export const SessionOfTicketTask = meta.story();

/** A removed worktree and its container stay in the trail, struck through and without links. */
export const RemovedWorktree = meta.story({
  args: { provenance: removedTrail },
});

/** A worktree made outside opendevhub has only its project. */
export const Unmanaged = meta.story({
  args: { provenance: provenanceOf("worktree", "2") ?? removedTrail },
});

/** A ticket, and the task and pull request it led to. */
export const Ticket = meta.story({
  args: { provenance: provenanceOf("ticket", "3") ?? removedTrail },
});
