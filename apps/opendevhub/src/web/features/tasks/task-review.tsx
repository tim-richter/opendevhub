import { Button } from "@opendevhub/ui/button";
import { useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { modelShortName } from "../../../shared/tasks";
import type { TaskView, VariantView } from "../../../shared/types";
import { taskHref } from "../../../shared/urls";
import { Chip, Empty, muted } from "../../components/page";
import { Link, useSearchParams } from "../../routing";
import { checkoutOf } from "../checkouts/checkouts";
import { useProjectView } from "../projects/project-layout";
import { ProjectReview } from "../review/project-review";
import { VariantCheckout } from "./task-checkout-tabs";
import { TaskPageCtx } from "./task-context";
import { TaskReviews } from "./task-hub";
import { useVariantStatus } from "./task-status";
import { selectedVariant, showsVariants, taskOf, taskSessions } from "./tasks";

const ReviewHeader = (props: {
  task: TaskView;
  variant: VariantView;
  back: string;
}) => {
  const view = useProjectView();
  const { task, variant } = props;
  const status = useVariantStatus(view, variant);
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={props.back}>
          <ArrowLeftIcon /> Back to task
        </Link>
      </Button>
      <h2 className="min-w-0 truncate text-lg font-semibold">
        {task.title || "Task"}
      </h2>
      {showsVariants(task) && (
        <Chip>
          V{variant.n}
          {variant.model && ` · ${modelShortName(variant.model)}`}
        </Chip>
      )}
      {status.branch && (
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <span className="truncate">{status.branch}</span>
          {status.base && (
            <>
              <ArrowRightIcon
                className="size-3 shrink-0"
                aria-label="against"
              />
              <span className="truncate">{status.base}</span>
            </>
          )}
        </span>
      )}
    </header>
  );
};

/**
 * A task variant's full review, outside the task's frame: every diff with line comments, the AI review and Open Code
 * Review, publishing and merging. Its header links back to the variant's conversation.
 */
export const TaskReviewPage = () => {
  const view = useProjectView();
  const { task = "" } = useParams({ strict: false });
  const [params] = useSearchParams();
  const record = taskOf(view, task);
  if (!record) {
    return (
      <Empty title="No such task">
        <p className={muted}>It was archived, or never existed here.</p>
      </Empty>
    );
  }
  const variant = selectedVariant(record, params.get("v"));
  const back = taskHref(
    view.project.id,
    record.id,
    variant ? { v: variant.n } : {}
  );
  const checkout = variant?.directory && checkoutOf(view, variant.directory);
  if (!variant || !checkout) {
    return (
      <Empty title="Worktree removed">
        <p className={muted}>
          {variant?.directory
            ? "This variant's worktree is gone, so there is nothing to review."
            : "This variant has no worktree yet."}
        </p>
        <Button asChild variant="link">
          <Link to={back}>Back to the task</Link>
        </Button>
      </Empty>
    );
  }
  const sessions = taskSessions(view, record.id).filter((s) =>
    record.variants.some((v) => v.sessionId === s.id)
  );
  return (
    <div className="flex flex-col gap-4">
      <ReviewHeader task={record} variant={variant} back={back} />
      <TaskPageCtx value={{ sessions, task: record, variant, view }}>
        {record.kind === "review" && <TaskReviews task={record} />}
        <VariantCheckout>
          <ProjectReview />
        </VariantCheckout>
      </TaskPageCtx>
    </div>
  );
};
