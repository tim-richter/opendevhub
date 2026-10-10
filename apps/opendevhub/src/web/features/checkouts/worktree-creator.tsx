import { ListTodoIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import type { Worktree } from "../../../shared/types";
import { Link } from "../../routing";
import { taskPath } from "../tasks/tasks";
import { WorktreeOrigin } from "./worktree-origin";

/**
 * Where a worktree came from: the task variant that made it (linking to the task), the pull request or ticket it
 * was made for, or that it was made outside opendevhub. Nothing for one made from the checkouts page for no PR.
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
      {createdBy?.by === "variant" && (
        <Badge
          variant="outline"
          asChild
          className="max-w-64 gap-1 font-sans font-normal"
          title={`Created by variant ${createdBy.n} of task ${createdBy.title}`}
        >
          <Link to={taskPath(projectId, createdBy.task)}>
            <ListTodoIcon className="size-3 shrink-0" />
            <span className="truncate">
              Task <em>{createdBy.title || createdBy.task}</em>
            </span>
            <span className="shrink-0">· variant {createdBy.n}</span>
          </Link>
        </Badge>
      )}
      {origin && <WorktreeOrigin origin={origin} />}
      {createdBy?.by === "unmanaged" && (
        <span className="text-muted-foreground font-sans text-xs">
          Created outside opendevhub
        </span>
      )}
    </>
  );
};
