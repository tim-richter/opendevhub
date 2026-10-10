import { useQueries } from "@tanstack/react-query";
import { ExternalLinkIcon, SparklesIcon } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { modelShortName } from "../../../shared/tasks";
import type {
  ProjectView,
  PullRequestRef,
  StoredAiReview,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { fetchPullLinks } from "../../api";
import { EnvBadge } from "../../components/env-badge";
import { Chip, muted, Section } from "../../components/page";
import { StatusDot } from "../../components/status";
import { When } from "../../components/when";
import { useDash } from "../../dashboard-context";
import { envOfDirectory } from "../../derive";
import { Link } from "../../routing";
import {
  checkoutOf,
  checkoutPath,
  sessionPagePath,
} from "../checkouts/checkouts";
import { forgejoRoute } from "../forgejo/forgejo";
import { PullRequestBadge } from "../forgejo/pull-request-badge";
import { PHASE_LABEL } from "../specs/specs";
import { formatCost, formatTokens, taskPath, variantStatus } from "./tasks";

const dash = <span className="text-muted-foreground">—</span>;

/** Where a variant runs: its checkout (linking to it) and, when it has one, its own container. */
const VariantCheckout = (props: { view: ProjectView; v: VariantView }) => {
  const { view, v } = props;
  if (!v.directory) {
    return dash;
  }
  const checkout = checkoutOf(view, v.directory);
  const env = envOfDirectory(view, v.directory);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {checkout ? (
        <Link
          to={checkoutPath(view.project.id, checkout.target)}
          className="hover:underline"
        >
          {checkout.target || "Main checkout"}
        </Link>
      ) : (
        <span className="text-muted-foreground line-through" title="Removed">
          {v.directory.split("/").findLast(Boolean)}
        </span>
      )}
      {env && <EnvBadge env={env} />}
    </span>
  );
};

/** Every variant of the task in one row each: model, state, usage, branch, checkout, session and pull request. */
export const VariantTable = (props: { view: ProjectView; task: TaskView }) => {
  const { view, task } = props;
  const single = task.kind !== "task";
  return (
    <Section
      title={single ? "Session" : "Variants"}
      hint={single ? undefined : task.variants.length}
    >
      <div className="overflow-x-auto">
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              {!single && <TableHead className="pl-4">Variant</TableHead>}
              <TableHead className={single ? "pl-4" : undefined}>
                State
              </TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Checkout</TableHead>
              <TableHead>Session</TableHead>
              <TableHead className="pr-4">Pull request</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {task.variants.map((v) => {
              const session = v.sessionId
                ? view.sessions.find((s) => s.id === v.sessionId)
                : undefined;
              const status = variantStatus(v, session);
              const checkout = session && checkoutOf(view, session.directory);
              const pulls = (task.pullRequests ?? []).filter(
                (p) => p.variant === v.n
              );
              return (
                <TableRow
                  key={v.n}
                  id={`variant-${v.n}`}
                  className={v.discarded ? "text-muted-foreground" : undefined}
                >
                  {!single && (
                    <TableCell className="pl-4">
                      <strong className="font-semibold">#{v.n}</strong>{" "}
                      {v.model ? modelShortName(v.model) : "default model"}
                      {v.node && <span className={muted}> · on {v.node}</span>}
                    </TableCell>
                  )}
                  <TableCell className={single ? "pl-4" : undefined}>
                    <span
                      className="inline-flex items-center gap-1.5"
                      title={v.error}
                    >
                      <StatusDot tone={status.tone} />
                      {status.label}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {session ? (
                      <>
                        {formatCost(session.cost)}{" "}
                        <span className="text-muted-foreground">
                          · {formatTokens(session.tokens)} tokens
                        </span>
                      </>
                    ) : (
                      dash
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {v.branch ?? dash}
                  </TableCell>
                  <TableCell>
                    <VariantCheckout view={view} v={v} />
                  </TableCell>
                  <TableCell>
                    {session && checkout ? (
                      <Link
                        to={sessionPagePath(
                          view.project.id,
                          checkout.target,
                          session.id
                        )}
                        className="hover:underline"
                      >
                        {session.title || "Open"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {v.sessionId ? "gone" : "—"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4">
                    {pulls.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {pulls.map((p) => (
                          <PullRequestBadge key={p.url} pull={p} />
                        ))}
                      </span>
                    ) : (
                      dash
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
};

/** The pull requests whose reviews the hub shows: the task's own, or the one a review task reviews. */
const reviewedPulls = (task: TaskView): PullRequestRef[] => {
  const all = [
    ...(task.pullRequests ?? []),
    ...(task.reviewOf ? [task.reviewOf] : []),
  ];
  return all.filter((p, i) => all.findIndex((q) => q.url === p.url) === i);
};

/**
 * The AI reviews of the task's pull requests, or for a review task the reviews it ran, newest first. Read from each
 * pull request's links, fetched again when anything is recorded.
 */
export const TaskReviews = (props: { task: TaskView }) => {
  const { task } = props;
  const { forgejo, snapshot } = useDash();
  const latestId = snapshot?.activity?.latestId;
  const pulls = reviewedPulls(task);
  const results = useQueries({
    queries: pulls.map((p) => ({
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchPullLinks(p.url, signal),
      queryKey: ["links", "pull", p.url, "hub", latestId],
    })),
  });
  if (pulls.length === 0) {
    return null;
  }
  const reviews: (StoredAiReview & { pull: PullRequestRef })[] = results
    .flatMap((r, i) =>
      (r.data?.reviews ?? []).map((review) => ({ ...review, pull: pulls[i] }))
    )
    .filter((r) => task.kind !== "review" || r.taskId === task.id)
    .toSorted((a, b) => b.createdAt - a.createdAt);
  const loading = results.some((r) => r.isPending);
  return (
    <Section title="AI reviews" hint={reviews.length || undefined}>
      {reviews.length === 0 ? (
        <p className={`${muted} px-4 py-3`}>
          {loading ? "Loading…" : "No AI reviews yet."}
        </p>
      ) : (
        <ul className="divide-y">
          {reviews.map((r) => {
            const internal = forgejo?.enabled
              ? forgejoRoute(r.pull.url, forgejo.url)
              : undefined;
            const pr =
              r.pull.number === undefined
                ? "Pull request"
                : `PR #${r.pull.number}`;
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
              >
                <SparklesIcon className="text-primary size-4 shrink-0" />
                {internal ? (
                  <Link to={internal} className="hover:underline">
                    {pr}
                  </Link>
                ) : (
                  <a
                    href={r.pull.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:underline"
                  >
                    {pr} <ExternalLinkIcon className="size-3" />
                  </a>
                )}
                <span className="text-muted-foreground">
                  {r.mode === "quick" ? "quick" : "agent"} · {r.findings.length}{" "}
                  finding{r.findings.length === 1 ? "" : "s"}
                </span>
                <span className="min-w-0 flex-1 truncate" title={r.summary}>
                  {r.summary}
                </span>
                <When
                  at={r.createdAt}
                  className="text-muted-foreground text-xs"
                />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
};

const TaskRef = (props: { view: ProjectView; id: string }) => {
  const other = props.view.tasks.find((t) => t.id === props.id);
  return (
    <Link
      to={taskPath(props.view.project.id, props.id)}
      className="hover:underline"
    >
      {other?.title || "another task"}
    </Link>
  );
};

/** For a spec-first task: the task that proposed its change, the one implementing it, and each variant's phase. */
export const SpecChain = (props: { view: ProjectView; task: TaskView }) => {
  const { view, task } = props;
  const phases = task.variants.filter((v) => v.spec);
  if (!task.spec && phases.length === 0) {
    return null;
  }
  return (
    <Section title="Spec chain">
      <dl className="[&_dt]:text-muted-foreground grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <dt>Proposed in</dt>
        <dd>
          {task.spec?.proposedIn ? (
            <TaskRef view={view} id={task.spec.proposedIn} />
          ) : (
            "this task"
          )}
        </dd>
        <dt>Implemented in</dt>
        <dd>
          {task.spec?.implementedIn ? (
            <TaskRef view={view} id={task.spec.implementedIn} />
          ) : (
            <span className="text-muted-foreground">not yet</span>
          )}
        </dd>
        {phases.map((v) => (
          <div key={v.n} className="contents">
            <dt>Variant {v.n}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {v.spec && PHASE_LABEL[v.spec.phase]}
              {v.spec?.change && (
                <Chip className="font-mono">
                  {v.spec.archived ?? v.spec.change}
                </Chip>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
};
