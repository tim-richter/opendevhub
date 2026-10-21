import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type {
  ProjectView,
  SessionSummary,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { Link } from "../../routing";
import { reviewHref, useVariantStatus } from "./task-status";
import { taskSteps } from "./tasks";
import type { TaskStep } from "./tasks";

const StepLabel = ({ step, n }: { step: TaskStep; n: number }) => (
  <>
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border text-[0.6875rem] font-semibold tabular-nums",
        step.state === "done" && "border-ok bg-ok/15 text-ok",
        step.state === "current" &&
          "border-foreground bg-foreground text-background",
        step.state === "todo" && "text-muted-foreground"
      )}
      aria-hidden
    >
      {step.state === "done" ? <CheckIcon className="size-3" /> : n}
    </span>
    <span
      className={cn(
        "whitespace-nowrap",
        step.state === "todo" && "text-muted-foreground",
        step.state === "current" && "font-medium"
      )}
    >
      {step.label}
      {step.state === "done" && <span className="sr-only"> (done)</span>}
    </span>
  </>
);

/**
 * The task's progress under its title: the steps in order, done ones checked and the current one marked. When
 * Review & checks is current it links to the Review page. Phones show "Step n of m · label" instead.
 */
export const TaskStepper = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  sessions: SessionSummary[];
}) => {
  const { view, task, variant } = props;
  const status = useVariantStatus(view, variant);
  const steps = taskSteps(task, variant, {
    aiReviewRunning: status.aiReviewRunning,
    checks: status.checks,
    review: status.review,
    sessions: props.sessions,
  });
  if (steps.length === 0) {
    return null;
  }
  const index = steps.findIndex((s) => s.state === "current");
  const current = index === -1 ? steps.length - 1 : index;
  return (
    <>
      <ol
        aria-label="Task progress"
        className="hidden flex-wrap items-center gap-x-2 gap-y-1 text-sm md:flex"
      >
        {steps.map((step, i) => {
          const linked =
            step.state === "current" && step.id === "review" && status.checkout;
          return (
            <li
              key={step.id}
              aria-current={step.state === "current" ? "step" : undefined}
              className="flex items-center gap-2"
            >
              {i > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px w-4 lg:w-8",
                    steps[i - 1].state === "done" ? "bg-ok/60" : "bg-border"
                  )}
                />
              )}
              {linked ? (
                <Link
                  to={reviewHref(view, task, variant)}
                  className="flex items-center gap-1.5 rounded-sm hover:underline"
                >
                  <StepLabel step={step} n={i + 1} />
                </Link>
              ) : (
                <span className="flex items-center gap-1.5">
                  <StepLabel step={step} n={i + 1} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-muted-foreground text-sm md:hidden">
        Step {current + 1} of {steps.length} ·{" "}
        <span className="text-foreground font-medium">
          {steps[current].label}
        </span>
      </p>
    </>
  );
};
