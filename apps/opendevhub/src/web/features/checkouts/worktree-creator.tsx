import type { Worktree } from "../../../shared/types";
import { CreatedByChip } from "../activity/created-by-chip";
import { WorktreeOrigin } from "./worktree-origin";

/**
 * Where a worktree (with its branch and its own container) came from: the task variant that made it, the checkouts
 * page, a pull request checkout, or outside opendevhub; and the ticket or pull request it was made for.
 */
export const WorktreeCreator = ({
  projectId,
  worktree,
}: {
  projectId: string;
  worktree: Worktree;
}) => {
  const { createdBy, origin } = worktree;
  return (
    <>
      {createdBy && <CreatedByChip origin={createdBy} projectId={projectId} />}
      {origin && createdBy?.by !== "pull" && <WorktreeOrigin origin={origin} />}
    </>
  );
};
