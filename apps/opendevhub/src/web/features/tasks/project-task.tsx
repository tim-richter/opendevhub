import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  TicketIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { confirm } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import type {
  ChecksView,
  ProjectView,
  ReviewData,
  SessionSummary,
  SpecView,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { archiveTask, dismissStarting, pickVariant } from "../../api";
import { EnvBadge } from "../../components/env-badge";
import { Chip, Empty, muted, Section } from "../../components/page";
import { SessionBadge } from "../../components/status";
import { useDash } from "../../dashboard-context";
import { envOfDirectory, sessionHref } from "../../derive";
import { Link, useSearchParams } from "../../routing";
import { ActivityFeed } from "../activity/activity-feed";
import { ProvenanceBreadcrumb } from "../activity/provenance-breadcrumb";
import { checkoutOf, checkoutPath } from "../checkouts/checkouts";
import { checksState, failedNames } from "../checks/checks";
import type { ChecksState } from "../checks/checks";
import { checksQuery } from "../checks/checks-queries";
import { PullRequestBadge } from "../forgejo/pull-request-badge";
import { JiraSourceCard } from "../jira/jira-source-card";
import { useProjectView } from "../projects/project-layout";
import { reviewQuery } from "../review/review-queries";
import { TaskProgress } from "../specs/spec-approve";
import { SpecSection } from "../specs/spec-panel";
import { specQuery } from "../specs/spec-queries";
import { PHASE_LABEL, specSessions, taskProgress } from "../specs/specs";
import { formatUsage, taskUsage } from "../usage/usage";
import { SpecChain, TaskReviews, VariantTable } from "./task-hub";
import {
  diffStats,
  fileMatrix,
  formatCost,
  formatTokens,
  pickPrompts,
  removals,
  startingVariants,
  startStepLabel,
  taskOf,
  taskSessions,
  variantName,
} from "./tasks";

/** Results by checkout: undefined while loading, null when it couldn't be read. */
const byDirectory = <T,>(
  directories: string[],
  results: UseQueryResult<T>[]
): Record<string, T | null> => {
  const all: Record<string, T | null> = {};
  for (const [i, result] of results.entries()) {
    if (result.data !== undefined) {
      all[directories[i]] = result.data;
    } else if (result.isError) {
      all[directories[i]] = null;
    }
  }
  return all;
};

/** A variant that is still being set up: where it is, and the last lines its setup wrote. */
const StartingCard = (props: {
  variant: VariantView;
  onDismiss: () => void;
}) => {
  const { variant: v } = props;
  const failed = v.step === "failed";
  return (
    <Card
      className={cn(
        "min-w-0 gap-3 px-4 py-3",
        failed && "border-destructive/50"
      )}
    >
      <header className="flex min-w-0 items-center gap-2">
        {failed ? null : (
          <LoaderCircleIcon className="text-muted-foreground size-4 shrink-0 animate-spin" />
        )}
        <strong className="truncate">{v.branch ?? `#${v.n}`}</strong>
        {v.node && <span className={cn(muted, "truncate")}>on {v.node}</span>}
        <span
          className={cn(
            "ml-auto shrink-0 text-sm",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {startStepLabel(v.step)}
        </span>
      </header>
      {v.error && (
        <p className="text-destructive text-sm break-words">{v.error}</p>
      )}
      {v.log && v.log.length > 0 && (
        <pre className="bg-muted/50 text-muted-foreground max-h-48 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {v.log.join("\n")}
        </pre>
      )}
      {failed && (
        <div>
          <Button variant="outline" size="sm" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </Card>
  );
};

/** The pull requests a variant's branch was published as. */
const VariantPulls = (props: { task: TaskView; n: number | undefined }) => {
  const pulls = (props.task.pullRequests ?? []).filter(
    (p) => p.variant === props.n
  );
  if (pulls.length === 0) {
    return null;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {pulls.map((p) => (
        <PullRequestBadge key={p.url} pull={p} />
      ))}
    </span>
  );
};

/** Hides an ended task from the dashboard; its record stays. */
const ArchiveButton = (props: { view: ProjectView; task: TaskView }) => {
  const { report } = useDash();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      title="Hide this task; its sessions and worktrees stay as they are"
      onClick={() => {
        setBusy(true);
        void archiveTask(props.view.project.id, props.task.id)
          .catch(report)
          .finally(() => setBusy(false));
      }}
    >
      Archive
    </Button>
  );
};

export const ProjectTask = () => {
  const view = useProjectView();
  const { task = "" } = useParams({ strict: false });
  const { report, snapshot } = useDash();
  const [params, setParams] = useSearchParams();
  const total = taskUsage(snapshot, task);
  const record = taskOf(view, task);
  const sessions = taskSessions(view, task);
  const starting = record ? startingVariants(record) : [];
  const jiraSource = record?.jira;
  const queryClient = useQueryClient();
  const directories = [...new Set(sessions.map((s) => s.directory))];
  const specVariants = record ? specSessions(record, sessions) : [];
  // Shared with each checkout's Review, and refreshed when an agent there finishes a turn.
  const reviews = byDirectory(
    directories,
    useQueries({
      queries: directories.map((d) => reviewQuery(view.project.id, d)),
    })
  );
  const specDirectories = specVariants.map((s) => s.directory);
  // The same queries as each checkout's Spec panel, for the tasks done in Compare.
  const specs = byDirectory(
    specDirectories,
    useQueries({
      queries: specDirectories.map((d) => specQuery(view.project.id, d)),
    })
  );
  const checks = byDirectory(
    directories,
    useQueries({
      queries: directories.map((d) =>
        checksQuery(queryClient, view.project.id, d)
      ),
    })
  );
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const projectPath = `/p/${encodeURIComponent(view.project.id)}`;

  const pick = async (keep: SessionSummary) => {
    if (picking) {
      return;
    }
    const others = sessions.filter((s) => s.id !== keep.id);
    const name = variantName(keep);
    const running = others.some((s) => s.status !== "idle");
    const confirmed = await confirm({
      confirmLabel: "Keep and discard others",
      description: pickPrompts(name, others.length, [], running).discard,
      title: `Keep ${name}?`,
    });
    if (!confirmed) {
      return;
    }
    setPicking(true);
    setNotice(undefined);
    try {
      // Re-read the others' changes: the cached ones may predate edits made while this page was open.
      const dirs = [...new Set(others.map((s) => s.directory))];
      const fresh = await Promise.allSettled(
        dirs.map((d) =>
          queryClient.fetchQuery({
            ...reviewQuery(view.project.id, d),
            staleTime: 0,
          })
        )
      );
      if (!mounted.current) {
        return;
      }
      const dirty: Record<string, boolean> = {};
      for (const [i, r] of fresh.entries()) {
        if (r.status === "fulfilled") {
          dirty[dirs[i]] = r.value.dirty;
        }
      }
      const prompts = pickPrompts(
        name,
        others.length,
        removals(view, task, keep.id, dirty),
        running
      );
      const removeWorktrees = prompts.remove
        ? await confirm({
            confirmLabel: "Remove worktrees",
            description: prompts.remove,
            destructive: true,
            title: "Remove their worktrees too?",
          })
        : false;
      const r = await pickVariant(
        view.project.id,
        task,
        keep.id,
        removeWorktrees
      );
      const removed =
        r.removed.length > 0
          ? `, removed ${r.removed.length} worktree${r.removed.length === 1 ? "" : "s"}`
          : "";
      if (mounted.current) {
        setNotice(`Kept ${name}. Discarded ${r.discarded.length}${removed}.`);
      }
      if (r.errors.length > 0) {
        report(new Error(r.errors.join("; ")));
      }
    } catch (error) {
      report(error);
    } finally {
      if (mounted.current) {
        setPicking(false);
      }
    }
  };

  if (!record) {
    return (
      <Empty title="No such task">
        <p className={muted}>It was archived, or never existed here.</p>
        <Button asChild variant="link">
          <Link to={projectPath}>Back to {view.project.name}</Link>
        </Button>
      </Empty>
    );
  }
  const variantCount = record.variants.length;
  const comparable = record.kind === "task";
  const tab =
    comparable && params.get("tab") === "compare" ? "compare" : "overview";
  const crumbs = (
    <nav
      aria-label="Breadcrumb"
      className="text-muted-foreground flex items-center gap-1 text-sm"
    >
      <Link to={projectPath} className="hover:text-foreground hover:underline">
        {view.project.name}
      </Link>
      <ChevronRightIcon className="size-3.5" /> {KIND_LABEL[record.kind]}
    </nav>
  );

  const overview = (
    <div className="flex flex-col gap-4">
      {jiraSource && (
        <JiraSourceCard
          source={jiraSource}
          {...(record.ticket ? { ticket: record.ticket } : {})}
        />
      )}
      {starting.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
          {starting.map((v) => (
            <StartingCard
              key={`starting-${v.n}`}
              variant={v}
              onDismiss={() =>
                void dismissStarting(view.project.id, task).catch(report)
              }
            />
          ))}
        </div>
      )}
      <VariantTable view={view} task={record} />
      {specVariants.length > 0 && (
        <SpecSection
          projectId={view.project.id}
          task={record}
          sessions={specVariants}
          reviews={reviews}
        />
      )}
      <SpecChain view={view} task={record} />
      <TaskReviews task={record} />
      <ActivityFeed
        filter={{ taskId: record.id }}
        empty="Nothing recorded for this task yet."
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <ProvenanceBreadcrumb type="task" id={record.id} fallback={crumbs} />
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="text-lg font-semibold">{record.title || "Task"}</h2>
        <Chip>{KIND_LABEL[record.kind]}</Chip>
        <Chip variant={record.state === "running" ? "secondary" : "outline"}>
          {record.state}
        </Chip>
        {record.ticket && (
          <Chip variant="outline" asChild>
            <Link to={`/jira/${encodeURIComponent(record.ticket.key)}`}>
              <TicketIcon className="size-3" /> {record.ticket.key}
              {record.ticket.status && ` · ${record.ticket.status}`}
            </Link>
          </Chip>
        )}
        <span className={muted}>
          {comparable && (
            <>
              {variantCount} variant
              {variantCount === 1 ? "" : "s"}
            </>
          )}
          {starting.some((v) => v.step !== "failed") && " · starting"}
          {total && (
            <span className="tabular-nums">
              {comparable ? " · " : ""}Total {formatUsage(total)}
            </span>
          )}
        </span>
        <span className="ml-auto">
          {record.state === "ended" && (
            <ArchiveButton view={view} task={record} />
          )}
        </span>
      </div>
      {record.reviewOf && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className={muted}>
            Review of{" "}
            {record.reviewOf.number === undefined
              ? "a pull request"
              : `PR #${record.reviewOf.number}`}
            {record.reviewOf.title && `: ${record.reviewOf.title}`}
          </span>
          <PullRequestBadge pull={record.reviewOf} />
        </p>
      )}
      {notice && (
        <Alert className="border-ok/40 bg-ok/10">
          <AlertDescription className="text-ok">{notice}</AlertDescription>
        </Alert>
      )}
      {comparable ? (
        <Tabs
          value={tab}
          onValueChange={(next) =>
            setParams(
              (prev) => {
                const out = new URLSearchParams(prev);
                if (next === "compare") {
                  out.set("tab", "compare");
                } else {
                  out.delete("tab");
                }
                return out;
              },
              { replace: true }
            )
          }
        >
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="compare">
              {sessions.length > 1 ? "Compare variants" : "Changes"}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-2">
            {overview}
          </TabsContent>
          <TabsContent value="compare" className="mt-2 flex flex-col gap-4">
            {sessions.length > 0 ? (
              <Compare
                view={view}
                task={record}
                sessions={sessions}
                reviews={reviews}
                checks={checks}
                specs={specs}
                picking={picking}
                onPick={(s) => void pick(s)}
              />
            ) : (
              <Empty title="No live sessions">
                <p className={muted}>
                  The variants&apos; sessions are gone, so there is nothing to
                  compare.
                </p>
              </Empty>
            )}
          </TabsContent>
        </Tabs>
      ) : (
        overview
      )}
    </div>
  );
};

const KIND_LABEL: Record<TaskView["kind"], string> = {
  manual: "Session",
  review: "AI review",
  task: "Task",
};

const CHECK_TONE: Record<ChecksState, string> = {
  failed: "text-destructive",
  idle: "text-muted-foreground",
  none: "text-muted-foreground",
  passed: "text-ok",
  running: "text-running",
  stale: "text-warn",
};

const CHECK_TEXT: Record<ChecksState, string> = {
  failed: "Failed",
  idle: "Not run",
  none: "None set up",
  passed: "Passed",
  running: "Running…",
  stale: "Ran on an older commit",
};

const loading = <Skeleton className="h-4 w-20" />;

/** The variants side by side: one column each, then the files they change. */
const Compare = (props: {
  view: ProjectView;
  task: TaskView;
  sessions: SessionSummary[];
  reviews: Record<string, ReviewData | null>;
  checks: Record<string, ChecksView | null>;
  specs: Record<string, SpecView | null>;
  picking: boolean;
  onPick: (s: SessionSummary) => void;
}) => {
  const { view, task, sessions, reviews, checks, specs } = props;
  const several = sessions.length > 1;
  const specOf = (s: SessionSummary) =>
    task.variants.find((v) => v.sessionId === s.id)?.spec;
  const files = fileMatrix(sessions.map((s) => reviews[s.directory]));
  const differ = files.filter((f) => !f.same).length;
  const row = (label: string, cell: (s: SessionSummary) => ReactNode) => (
    <tr className="border-t">
      <th
        scope="row"
        className="text-muted-foreground bg-card sticky left-0 px-4 py-2 text-left align-top font-normal whitespace-nowrap"
      >
        {label}
      </th>
      {sessions.map((s) => (
        <td key={s.id} className="px-4 py-2 align-top">
          {cell(s)}
        </td>
      ))}
    </tr>
  );
  return (
    <>
      <Section title={several ? "Compare variants" : "Variant"}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr>
                <th className="bg-card sticky left-0 w-28" />
                {sessions.map((s) => (
                  <th
                    key={s.id}
                    scope="col"
                    className="min-w-52 px-4 py-3 text-left align-top font-normal"
                  >
                    <div className="flex items-center gap-2">
                      <strong className="font-semibold">
                        {variantName(s)}
                      </strong>
                      <SessionBadge status={s.status} />
                    </div>
                    <div className="text-muted-foreground mt-0.5 font-mono text-xs">
                      {reviews[s.directory] === undefined
                        ? loading
                        : (reviews[s.directory]?.branch ?? "—")}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sessions.some((s) => specOf(s)) &&
                row("Spec", (s) => {
                  const phase = specOf(s)?.phase;
                  if (!phase) {
                    return "—";
                  }
                  const progress =
                    phase === "implement" && !task.spec?.implementedIn
                      ? taskProgress(specs[s.directory])
                      : undefined;
                  return (
                    <span className="flex flex-col gap-1">
                      {PHASE_LABEL[phase]}
                      {progress && <TaskProgress {...progress} />}
                    </span>
                  );
                })}
              {!!task.pullRequests?.length &&
                row("Pull request", (s) => (
                  <VariantPulls
                    task={task}
                    n={task.variants.find((v) => v.sessionId === s.id)?.n}
                  />
                ))}
              {row("Checks", (s) => {
                const c = checks[s.directory];
                if (c === undefined) {
                  return loading;
                }
                if (c === null) {
                  return "—";
                }
                const state = checksState(c);
                const failed = failedNames(c.run);
                return (
                  <span className={CHECK_TONE[state]}>
                    {CHECK_TEXT[state]}
                    {failed.length > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        ({failed.join(", ")})
                      </span>
                    )}
                  </span>
                );
              })}
              {row("Changes", (s) => {
                const review = reviews[s.directory];
                if (review === undefined) {
                  return loading;
                }
                if (review === null) {
                  return "—";
                }
                const stats = diffStats(review);
                return (
                  <span className="tabular-nums">
                    {stats.files} file{stats.files === 1 ? "" : "s"}{" "}
                    <span className="text-ok">+{stats.additions}</span>{" "}
                    <span className="text-destructive">−{stats.deletions}</span>
                    {review.dirty && (
                      <span className="text-muted-foreground">
                        {" "}
                        · uncommitted
                      </span>
                    )}
                  </span>
                );
              })}
              {row("Cost", (s) => (
                <span className="tabular-nums">
                  {formatCost(s.cost)}{" "}
                  <span className="text-muted-foreground">
                    · {formatTokens(s.tokens)} tokens
                  </span>
                </span>
              ))}
              {row("Context", (s) => (
                <span className="tabular-nums">
                  {formatTokens(s.context)} tokens
                </span>
              ))}
              {row("Container", (s) => {
                const env = envOfDirectory(view, s.directory);
                return env ? <EnvBadge env={env} /> : "Shared";
              })}
              <tr className="border-t">
                <th className="bg-card sticky left-0" />
                {sessions.map((s) => {
                  const checkout = checkoutOf(view, s.directory);
                  const working = s.status !== "idle";
                  return (
                    <td key={s.id} className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {several && (
                          <Button
                            size="sm"
                            variant={working ? "outline" : "default"}
                            disabled={props.picking}
                            title={
                              working
                                ? "Still working: picking it now stops the others"
                                : "Keep this variant and discard the others"
                            }
                            onClick={() => props.onPick(s)}
                          >
                            Pick this one
                          </Button>
                        )}
                        {checkout && (
                          <Button asChild variant="outline" size="sm">
                            <Link
                              to={checkoutPath(
                                view.project.id,
                                checkout.target,
                                "review"
                              )}
                            >
                              Review
                            </Link>
                          </Button>
                        )}
                        <Button asChild variant="ghost" size="sm">
                          <a
                            href={sessionHref(view, s)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open <ExternalLinkIcon />
                          </a>
                        </Button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {several && files.length > 0 && (
        <Section
          title="Files"
          hint={
            differ === 0
              ? "every variant changes the same files the same amount"
              : `${differ} of ${files.length} differ between variants`
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <tbody>
                {files.map((f) => (
                  <tr
                    key={f.file}
                    className={cn(
                      "border-t first:border-t-0",
                      f.same && "text-muted-foreground"
                    )}
                  >
                    <th
                      scope="row"
                      className="bg-card sticky left-0 max-w-96 truncate px-4 py-1.5 text-left font-mono text-xs font-normal"
                      title={f.file}
                    >
                      {f.file}
                    </th>
                    {f.cells.map((c, i) => (
                      <td
                        key={sessions[i].id}
                        className="min-w-52 px-4 py-1.5 font-mono text-xs tabular-nums"
                      >
                        {c ? (
                          <>
                            {c.status === "added" && "new "}
                            {c.status === "deleted" && "deleted "}
                            <span className={f.same ? "" : "text-ok"}>
                              +{c.additions}
                            </span>{" "}
                            <span className={f.same ? "" : "text-destructive"}>
                              −{c.deletions}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            untouched
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
};
