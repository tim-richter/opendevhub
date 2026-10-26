import { Button } from "@opendevhub/ui/button";
import { Skeleton } from "@opendevhub/ui/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  GitBranchIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type {
  BasePosition,
  CheckDef,
  CheckResult,
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
import { Tip } from "../../components/tip";
import { envOfDirectory, relativeTime } from "../../derive";
import type { Tone } from "../../derive";
import { Link } from "../../routing";
import { checkoutOf, checkoutRuntime } from "../checkouts/checkouts";
import {
  checkSections,
  checksState,
  failedNames,
  resultOf,
} from "../checks/checks";
import { ChecksIcon, useChecks } from "../checks/checks-panel";
import { checksQuery } from "../checks/checks-queries";
import { localAiReviewRunning } from "../review/local-ai-review";
import { reviewQuery } from "../review/review-queries";
import { basePositionQuery, useFetchBase, usePullBase } from "./base-queries";
import { positionRows, pullBlocked, upstreamCounts } from "./base-status";
import { BranchPosition } from "./branch-position";
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
  const mainCheckout = checkout?.target === "";
  const baseName = reviewData?.base?.name ?? "";
  // A node's branch isn't in this machine's repository, so only its base is placed against the upstream.
  const positionBranch =
    mainCheckout || variant.node ? undefined : reviewData?.branch;
  const position = useQuery({
    ...basePositionQuery(projectId, baseName, positionBranch),
    enabled: !!checkout && !!baseName,
  });
  const positionData: BasePosition | null | undefined = read(position);
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
    mainCheckout,
    node: variant.node,
    position: positionData,
    positionBranch,
    positionError: position.error?.message,
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

/** Where the variant's branch stands against the base's upstream, with fetch, Pull and the checkout's environment. */
const Position = ({
  projectId,
  status,
}: {
  projectId: string;
  status: VariantStatus;
}) => {
  const state = status.containerState;
  const { position, review, base } = status;
  const pull = usePullBase(projectId, base ?? "", status.positionBranch);
  let diagram: ReactNode = loading;
  if (review === null) {
    diagram = <p className={muted}>Couldn&apos;t read the branch.</p>;
  } else if (review && !base) {
    diagram = <p className={muted}>No base to compare with.</p>;
  } else if (review && base && position !== undefined) {
    diagram = (
      <BranchPosition
        label={`Where ${status.branch ?? "the branch"} stands against ${position?.upstream ?? base}`}
        rows={positionRows({
          base,
          mainCheckout: status.mainCheckout,
          ...(position ? { position } : {}),
          review,
          ...(status.branch ? { branch: status.branch } : {}),
        })}
      />
    );
  }
  const blocked = position ? pullBlocked(position) : undefined;
  const pullError = pull.error?.message;
  return (
    <div className="flex flex-col gap-3">
      {diagram}
      {position && position.behind > 0 && (
        <div className="flex flex-col gap-1">
          <Tip
            label={blocked ?? `Fast-forward ${base} to ${position.upstream}`}
          >
            {/* A disabled button gets no pointer events; the span carries the tooltip. */}
            <span className="self-start" tabIndex={blocked ? 0 : undefined}>
              <Button
                variant="outline"
                size="sm"
                disabled={!!blocked || pull.isPending}
                onClick={() => pull.mutate()}
              >
                <ArrowDownToLineIcon /> {pull.isPending ? "Pulling…" : "Pull"}
              </Button>
            </span>
          </Tip>
          {pullError && <p className="text-destructive text-xs">{pullError}</p>}
        </div>
      )}
      {(position?.fetchError ?? status.positionError) && (
        <p className="text-warn text-xs break-words">
          {position?.fetchError
            ? `Couldn't fetch ${position.remote ?? "the remote"}: ${position.fetchError}`
            : status.positionError}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
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
        {position?.remote && (
          <>
            <dt className="text-muted-foreground">Fetched</dt>
            <dd>
              {position.lastFetchAt === undefined
                ? "never"
                : relativeTime(position.lastFetchAt)}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
};

/** Fetches the base's remote now, whatever the last fetch's age. */
const FetchButton = ({
  projectId,
  status,
}: {
  projectId: string;
  status: VariantStatus;
}) => {
  const fetch = useFetchBase(
    projectId,
    status.base ?? "",
    status.positionBranch
  );
  if (!status.base) {
    return null;
  }
  const remote = status.position?.remote ?? "the remote";
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Fetch ${remote}`}
      title={`Fetch ${remote}`}
      disabled={fetch.isPending}
      onClick={() => fetch.mutate()}
    >
      <RefreshCwIcon className={fetch.isPending ? "animate-spin" : undefined} />
    </Button>
  );
};

const RESULT_TONE = {
  cancelled: "off",
  error: "error",
  failed: "error",
  passed: "ok",
  queued: "off",
  running: "running",
} as const;

/** One check and its status; the running one has a button that cancels it. */
const CheckItem = ({
  check,
  result,
  onCancel,
}: {
  check: CheckDef;
  result?: CheckResult;
  onCancel: () => void;
}) => {
  const status = result ? result.status : "not run";
  return (
    <li className="flex min-w-0 items-center gap-2">
      <StatusDot
        tone={result ? RESULT_TONE[result.status] : "off"}
        label={status}
      />
      <span className="truncate">{check.name}</span>
      <span className="text-muted-foreground ml-auto shrink-0 text-xs">
        {status}
      </span>
      {result?.status === "running" && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Cancel ${check.name}`}
          title={`Cancel ${check.name}`}
          onClick={onCancel}
        >
          <SquareIcon className="fill-current" />
        </Button>
      )}
    </li>
  );
};

/** Each check's state, grouped as on the Review page, with Run all and a Run for each group. Failures aren't handed to the agent from here. */
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
  const running = checks.state === "running";
  return (
    <div className="flex flex-col gap-2">
      {checkSections(data.checks).map((section) => {
        const items = (
          <ul className="flex flex-col gap-1 text-sm">
            {section.checks.map((c) => (
              <CheckItem
                key={`${c.where}:${c.name}:${c.command}`}
                check={c}
                result={resultOf(data.run, c)}
                onCancel={() => void checks.cancel(c.name)}
              />
            ))}
          </ul>
        );
        if (!section.group) {
          return <div key="">{items}</div>;
        }
        const names = section.checks.map((c) => c.name);
        return (
          <section
            key={section.group}
            aria-label={section.group}
            className="flex flex-col gap-1"
          >
            <header className="flex min-w-0 items-center gap-2">
              <h4 className="text-muted-foreground truncate text-xs font-medium">
                {section.group}
              </h4>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                aria-label={`Run group ${section.group}`}
                title={`Run group ${section.group}`}
                disabled={running}
                onClick={() => void checks.start({ names })}
              >
                <PlayIcon />
              </Button>
            </header>
            {items}
          </section>
        );
      })}
      {stale && <p className="text-warn text-xs">Ran on an older commit.</p>}
      {checks.error && (
        <p className="text-destructive text-xs">{checks.error}</p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={running}
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

/** The selected variant's Position, Checks and Changes; the rail on wide screens and the Checks tab on phones. */
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
      <RailSection
        title="Position"
        action={<FetchButton projectId={view.project.id} status={status} />}
      >
        <Position projectId={view.project.id} status={status} />
      </RailSection>
      <RailSection
        title="Checks"
        action={
          status.checks && (
            // Clipped so the spinner's rotating corners don't overflow the rail and flash a scrollbar.
            <span className="flex size-4 items-center justify-center overflow-hidden [&_svg]:size-4">
              <ChecksIcon state={checksState(status.checks)} />
            </span>
          )
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

/** The end of the tab bar row from 768px up to 1440px: branch · ↑ahead ↓behind · environment · failing checks · Review. */
export const TaskStatusStrip = ({ className }: { className?: string }) => {
  const { view, task, variant } = useTaskPage();
  const status = useVariantStatus(view, variant);
  if (!status.checkout) {
    return null;
  }
  const counts = upstreamCounts(status.position, status.mainCheckout);
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
      {counts && (
        <Tip
          label={`${counts.ahead} commit${counts.ahead === 1 ? "" : "s"} ahead of ${counts.upstream}, ${counts.behind} behind`}
        >
          <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
            <span className="inline-flex items-center">
              <ArrowUpIcon className="size-3.5" aria-hidden />
              <span className="sr-only">ahead </span>
              {counts.ahead}
            </span>
            <span className="inline-flex items-center">
              <ArrowDownIcon className="size-3.5" aria-hidden />
              <span className="sr-only">behind </span>
              {counts.behind}
            </span>
          </span>
        </Tip>
      )}
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
