import { Button } from "@opendevhub/ui/button";
import { Skeleton } from "@opendevhub/ui/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, GitBranchIcon, PlayIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type {
  ChecksView,
  ContainerState,
  ProjectView,
  ReviewData,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { taskHref } from "../../../shared/urls";
import { Empty, muted } from "../../components/page";
import { StatusDot, STATE_LABEL } from "../../components/status";
import { envOfDirectory } from "../../derive";
import type { Tone } from "../../derive";
import { Link } from "../../routing";
import { checkoutOf, checkoutRuntime } from "../checkouts/checkouts";
import { checksState, failedNames, resultOf } from "../checks/checks";
import { ChecksIcon, useChecks } from "../checks/checks-panel";
import { checksQuery } from "../checks/checks-queries";
import { localAiReviewRunning } from "../review/local-ai-review";
import { reviewQuery } from "../review/review-queries";
import { useTaskPage } from "./task-context";
import { diffStats } from "./tasks";

/**
 * Where a variant's checkout stands: its branch and base, the environment it runs in, its changes and its checks.
 * The review and checks queries are shared with the Changes tab, the stepper and the sidebar's cards. `review` and
 * `checks` are undefined while loading and null when they couldn't be read.
 */
export const useVariantStatus = (view: ProjectView, variant: VariantView) => {
  const queryClient = useQueryClient();
  const projectId = view.project.id;
  const directory = variant.directory ?? "";
  const checkout = directory ? checkoutOf(view, directory) : undefined;
  const review = useQuery({
    ...reviewQuery(projectId, directory),
    enabled: !!checkout,
  });
  // Checks run where the checkout is; a remote node's aren't offered (as before, in the header).
  const checks = useQuery({
    ...checksQuery(queryClient, projectId, directory),
    enabled: !!checkout && !variant.node,
  });
  const read = <T,>(q: {
    data?: T;
    isError: boolean;
  }): T | null | undefined => {
    if (q.data !== undefined) {
      return q.data;
    }
    return q.isError ? null : undefined;
  };
  const reviewData: ReviewData | null | undefined = read(review);
  const checksData: ChecksView | null | undefined = read(checks);
  const env = checkout ? envOfDirectory(view, directory) : undefined;
  const runtime = checkout ? checkoutRuntime(view, directory) : undefined;
  return {
    aiReviewRunning: checkout
      ? localAiReviewRunning(projectId, directory)
      : false,
    base: reviewData?.base?.name,
    branch: reviewData?.branch ?? variant.branch,
    checkout,
    checks: checksData,
    containerState: runtime?.containerState,
    env,
    failing: checksData ? failedNames(checksData.run).length : 0,
    node: variant.node,
    review: reviewData,
    stats: reviewData ? diffStats(reviewData) : undefined,
  };
};

export type VariantStatus = ReturnType<typeof useVariantStatus>;

/** The task's Review page for a variant. */
export const reviewHref = (
  view: ProjectView,
  task: TaskView,
  variant: VariantView
): string =>
  taskHref(view.project.id, task.id, { tab: "review", v: variant.n });

const RailSection = (props: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-2 border-b pb-4 last:border-b-0">
    <header className="flex items-center gap-2">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
        {props.title}
      </h3>
      <span className="ml-auto">{props.action}</span>
    </header>
    {props.children}
  </section>
);

const loading = <Skeleton className="h-4 w-24" />;

const CONTAINER_TONE: Record<ContainerState, Tone> = {
  error: "error",
  running: "ok",
  starting: "running",
  stopped: "off",
  stopping: "running",
};

const Target = ({ status }: { status: VariantStatus }) => {
  const state = status.containerState;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">Branch</dt>
      <dd className="truncate font-mono text-xs leading-5">
        {status.branch ?? "—"}
      </dd>
      <dt className="text-muted-foreground">Base</dt>
      <dd className="truncate font-mono text-xs leading-5">
        {status.review === undefined && status.checkout
          ? loading
          : (status.base ?? "—")}
      </dd>
      <dt className="text-muted-foreground">Container</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        {state && <StatusDot tone={CONTAINER_TONE[state]} />}
        <span className="truncate">
          {status.env ? "Own" : "Shared"}
          {state && ` · ${STATE_LABEL[state]}`}
        </span>
      </dd>
      <dt className="text-muted-foreground">Runs</dt>
      <dd>{status.node ? `on ${status.node}` : "Locally"}</dd>
    </dl>
  );
};

const RESULT_TONE = {
  error: "error",
  failed: "error",
  passed: "ok",
  queued: "off",
  running: "running",
} as const;

/** Each check's state, with Run all. Failures aren't handed to the agent from here. */
const Checks = ({
  directory,
  view,
}: {
  directory: string;
  view: ProjectView;
}) => {
  const checks = useChecks(view.project.id, directory);
  const { view: data } = checks;
  if (!data) {
    return checks.error ? (
      <p className="text-destructive text-sm">{checks.error}</p>
    ) : (
      loading
    );
  }
  if (data.checks.length === 0) {
    return <p className={muted}>No checks set up.</p>;
  }
  const stale = checksState(data) === "stale";
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1 text-sm">
        {data.checks.map((c) => {
          const result = resultOf(data.run, c);
          const tone = result ? RESULT_TONE[result.status] : "off";
          return (
            <li
              key={`${c.where}:${c.name}:${c.command}`}
              className="flex min-w-0 items-center gap-2"
            >
              <StatusDot
                tone={tone}
                label={result ? result.status : "not run"}
              />
              <span className="truncate">{c.name}</span>
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                {result ? result.status : "not run"}
              </span>
            </li>
          );
        })}
      </ul>
      {stale && <p className="text-warn text-xs">Ran on an older commit.</p>}
      {checks.error && (
        <p className="text-destructive text-xs">{checks.error}</p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={checks.state === "running"}
        onClick={() => void checks.start()}
      >
        <PlayIcon /> Run all
      </Button>
    </div>
  );
};

const Changes = (props: { status: VariantStatus; href: string }) => {
  const { stats, review } = props.status;
  return (
    <div className="flex flex-col gap-2">
      {stats ? (
        <p className="text-sm tabular-nums">
          {stats.files} file{stats.files === 1 ? "" : "s"}{" "}
          <span className="text-ok">+{stats.additions}</span>{" "}
          <span className="text-destructive">−{stats.deletions}</span>
          {review?.dirty && (
            <span className="text-muted-foreground"> · uncommitted</span>
          )}
        </p>
      ) : (
        loading
      )}
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link to={props.href}>
          Review changes <ArrowRightIcon />
        </Link>
      </Button>
    </div>
  );
};

/** The selected variant's Target, Checks and Changes; the rail on wide screens and the Checks tab on phones. */
export const TaskStatusPanel = ({ className }: { className?: string }) => {
  const { view, task, variant } = useTaskPage();
  const status = useVariantStatus(view, variant);
  if (!status.checkout) {
    return (
      <aside className={className} aria-label="Variant status">
        <p className={muted}>No checkout yet.</p>
      </aside>
    );
  }
  return (
    <aside
      aria-label="Variant status"
      className={cn("flex min-w-0 flex-col gap-4", className)}
    >
      <RailSection title="Target">
        <Target status={status} />
      </RailSection>
      <RailSection
        title="Checks"
        action={
          status.checks && <ChecksIcon state={checksState(status.checks)} />
        }
      >
        {variant.node ? (
          <p className={muted}>Checks run on this machine only.</p>
        ) : (
          <Checks view={view} directory={status.checkout.directory} />
        )}
      </RailSection>
      <RailSection title="Changes">
        <Changes status={status} href={reviewHref(view, task, variant)} />
      </RailSection>
    </aside>
  );
};

/** The end of the tab bar row from 768px up to 1440px: branch · environment · failing checks · Review. */
export const TaskStatusStrip = ({ className }: { className?: string }) => {
  const { view, task, variant } = useTaskPage();
  const status = useVariantStatus(view, variant);
  if (!status.checkout) {
    return null;
  }
  return (
    <div
      className={cn(
        "text-muted-foreground flex min-w-0 items-center gap-2 text-xs",
        className
      )}
    >
      <GitBranchIcon className="size-3.5 shrink-0" />
      <span className="max-w-48 truncate font-mono">
        {status.branch ?? "—"}
      </span>
      <span aria-hidden>·</span>
      <span className="shrink-0">
        {status.env ? "own container" : "shared"}
        {status.node && ` on ${status.node}`}
      </span>
      {status.failing > 0 && (
        <>
          <span aria-hidden>·</span>
          <span className="text-destructive shrink-0">
            {status.failing} failing
          </span>
        </>
      )}
      <Link
        to={reviewHref(view, task, variant)}
        className="text-foreground ml-1 inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
      >
        Review <ArrowRightIcon className="size-3.5" />
      </Link>
    </div>
  );
};

/** The Checks tab, listed on phones: the rail's content, full width. */
export const TaskChecks = () => {
  const { variant } = useTaskPage();
  if (!variant.directory) {
    return (
      <Empty title="Not ready yet">
        <p className={muted}>This variant has no checkout yet.</p>
      </Empty>
    );
  }
  return <TaskStatusPanel className="max-w-xl" />;
};
