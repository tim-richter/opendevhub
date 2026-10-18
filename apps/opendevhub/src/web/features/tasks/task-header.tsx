import { Button } from "@opendevhub/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@opendevhub/ui/dropdown-menu";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  ColumnsIcon,
  GitCompareIcon,
  HistoryIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type {
  ProjectView,
  SessionSummary,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { taskHref } from "../../../shared/urls";
import { archiveTask } from "../../api";
import { Chip, muted } from "../../components/page";
import { TONE_TEXT, StatusDot } from "../../components/status";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { ActivityDialog } from "../activity/activity-button";
import { checkoutOf } from "../checkouts/checkouts";
import { OpenInSubmenu } from "../checkouts/open-in-menu";
import { PullRequestBadge } from "../forgejo/pull-request-badge";
import { formatUsage, taskUsage } from "../usage/usage";
import { reviewHref } from "./task-status";
import { ATTENTION, comparesVariants, taskAttention } from "./tasks";

export const KIND_LABEL: Record<TaskView["kind"], string> = {
  review: "AI review",
  task: "Task",
};

/** The task's one attention pill: Needs you, Working, Starting, Ended or Idle. */
const AttentionPill = (props: {
  task: TaskView;
  sessions: SessionSummary[];
}) => {
  const { label, tone } = ATTENTION[taskAttention(props.task, props.sessions)];
  return (
    <span
      className={cn(
        "bg-muted inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        TONE_TEXT[tone]
      )}
    >
      <StatusDot tone={tone} label={label} />
      {label}
    </span>
  );
};

/** Activity, Open in (for a local checkout) and Archive (for an ended task). */
const TaskActions = (props: {
  view: ProjectView;
  task: TaskView;
  variant?: VariantView;
  label: string;
  className?: string;
}) => {
  const { view, task, variant } = props;
  const { report } = useDash();
  const [activity, setActivity] = useState(false);
  const checkout = variant?.directory
    ? checkoutOf(view, variant.directory)
    : undefined;
  const local = checkout && !checkout.worktree?.node ? checkout : undefined;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label={props.label}
            title={props.label}
            className={cn("max-md:size-11", props.className)}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onSelect={() => setActivity(true)}>
            <HistoryIcon /> Activity
          </DropdownMenuItem>
          {local && (
            <OpenInSubmenu
              view={view}
              directory={local.directory}
              hostPath={local.hostPath}
            />
          )}
          {task.state === "ended" && (
            <DropdownMenuItem
              title="Hide this task; its conversations and worktrees stay as they are"
              onSelect={() =>
                void archiveTask(view.project.id, task.id).catch(report)
              }
            >
              <ArchiveIcon /> Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ActivityDialog
        open={activity}
        onOpenChange={setActivity}
        filter={{ taskId: task.id }}
        subject={task.title || "Task"}
        empty="Nothing recorded for this task yet."
      />
    </>
  );
};

/**
 * The top of the task page: the breadcrumb, the title with its attention pill, Compare variants (with two or more
 * active variants), Review changes (for an AI review) and More task actions; then the secondary metadata. Phones get a
 * back link and the title instead.
 */
export const TaskHeader = (props: {
  view: ProjectView;
  task: TaskView;
  variant?: VariantView;
  sessions: SessionSummary[];
}) => {
  const { view, task, variant, sessions } = props;
  const { snapshot } = useDash();
  const total = taskUsage(snapshot, task.id);
  const projectPath = `/p/${encodeURIComponent(view.project.id)}`;
  const title = task.title || "Task";
  const reviewable =
    task.kind === "review" &&
    variant?.directory &&
    checkoutOf(view, variant.directory);
  const actions = (
    <>
      {comparesVariants(task) && (
        <Button asChild variant="outline" size="sm" className="max-md:hidden">
          <Link to={taskHref(view.project.id, task.id, { tab: "compare" })}>
            <ColumnsIcon /> Compare variants
          </Link>
        </Button>
      )}
      {reviewable && variant && (
        <Button asChild variant="outline" size="sm" className="max-md:hidden">
          <Link to={reviewHref(view, task, variant)}>
            <GitCompareIcon /> Review changes
          </Link>
        </Button>
      )}
    </>
  );

  return (
    <header className="flex flex-col gap-1.5">
      <nav
        aria-label="Breadcrumb"
        className="text-muted-foreground hidden items-center gap-1 text-sm md:flex"
      >
        <Link
          to={projectPath}
          className="hover:text-foreground hover:underline"
        >
          {view.project.name}
        </Link>
        <ChevronRightIcon className="size-3.5" /> {KIND_LABEL[task.kind]}
        {task.ticket && (
          <>
            <ChevronRightIcon className="size-3.5" />
            <Link
              to={`/jira/${encodeURIComponent(task.ticket.key)}`}
              className="hover:text-foreground font-mono hover:underline"
            >
              {task.ticket.key}
            </Link>
          </>
        )}
      </nav>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="-ml-2 size-11 shrink-0 md:hidden"
        >
          <Link to={projectPath} aria-label={`Back to ${view.project.name}`}>
            <ArrowLeftIcon />
          </Link>
        </Button>
        <h2 className="min-w-0 truncate text-lg font-semibold" title={title}>
          {title}
        </h2>
        <AttentionPill task={task} sessions={sessions} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {actions}
          <TaskActions
            view={view}
            task={task}
            variant={variant}
            label="More task actions"
            className="max-md:hidden"
          />
          <TaskActions
            view={view}
            task={task}
            variant={variant}
            label="Task actions"
            className="md:hidden"
          />
        </span>
      </div>
      <div className="hidden flex-wrap items-center gap-2 text-sm md:flex">
        {(task.pullRequests ?? []).map((p) => (
          <PullRequestBadge key={p.url} pull={p} />
        ))}
        {task.fromChat && (
          <Chip variant="outline" title="Made from a chat, its variant 1">
            from chat
          </Chip>
        )}
        {task.reviewOf && (
          <span className={cn(muted, "flex items-center gap-1.5")}>
            Review of{" "}
            {task.reviewOf.number === undefined
              ? "a pull request"
              : `PR #${task.reviewOf.number}`}
            {task.reviewOf.title && `: ${task.reviewOf.title}`}
            <PullRequestBadge pull={task.reviewOf} />
          </span>
        )}
        {total && (
          <span className={cn(muted, "tabular-nums")}>
            Total {formatUsage(total)}
          </span>
        )}
      </div>
    </header>
  );
};
