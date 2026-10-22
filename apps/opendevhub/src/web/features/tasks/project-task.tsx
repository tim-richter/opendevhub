import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import { Skeleton } from "@opendevhub/ui/skeleton";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { Outlet, useChildMatches, useParams } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  FileTextIcon,
  GitCompareIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MessagesSquareIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { confirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";

import { FIRST_TURN_SENDING } from "../../../shared/tasks";
import type {
  ChecksView,
  ProjectView,
  ReviewData,
  SessionSummary,
  SpecView,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { taskHref } from "../../../shared/urls";
import type { TaskTab } from "../../../shared/urls";
import { dismissStarting, pickVariant } from "../../api";
import { EnvBadge } from "../../components/env-badge";
import {
  Chip,
  Empty,
  muted,
  Section,
  TabBar,
  TabLink,
} from "../../components/page";
import { SessionBadge } from "../../components/status";
import { useDash } from "../../dashboard-context";
import { envOfDirectory, sessionHref } from "../../derive";
import { Link, Navigate, useSearchParams } from "../../routing";
import { checkoutOf } from "../checkouts/checkouts";
import { checksState, failedNames } from "../checks/checks";
import type { ChecksState } from "../checks/checks";
import { checksQuery } from "../checks/checks-queries";
import { PullRequestBadge } from "../forgejo/pull-request-badge";
import { useProjectView } from "../projects/project-layout";
import { reviewQuery } from "../review/review-queries";
import { TaskProgress } from "../specs/spec-approve";
import { SpecSection } from "../specs/spec-panel";
import { specQuery } from "../specs/spec-queries";
import { PHASE_LABEL, specSessions, taskProgress } from "../specs/specs";
import { DraftTask } from "./draft-task";
import { TaskPageCtx, useTaskPage } from "./task-context";
import { TaskHeader } from "./task-header";
import { SpecChain, TaskReviews, VariantTable } from "./task-hub";
import { PhoneThreadSelect, PhoneVariants, TaskSidebar } from "./task-sidebar";
import {
  TaskStatusPanel,
  TaskStatusStrip,
  useVariantStatus,
} from "./task-status";
import { TaskStepper } from "./task-stepper";
import {
  diffStats,
  fileMatrix,
  formatCost,
  formatTokens,
  pickPrompts,
  removals,
  selectedVariant,
  startingVariants,
  startStepLabel,
  taskOf,
  taskSessions,
  taskTabs,
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

/** A variant still being set up, or that failed to: where it is, the last lines its setup wrote, and Dismiss. */
const VariantSetup = (props: {
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
        <pre className="bg-muted/50 text-muted-foreground max-h-[60vh] overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
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

type BarTab = Exclude<TaskTab, "compare">;

const TAB_LABEL: Record<
  BarTab,
  { icon: typeof GitCompareIcon; label: string }
> = {
  changes: { icon: GitCompareIcon, label: "Changes" },
  checks: { icon: ListChecksIcon, label: "Checks" },
  conversation: { icon: MessagesSquareIcon, label: "Conversation" },
  runtime: { icon: ServerIcon, label: "Runtime" },
  spec: { icon: FileTextIcon, label: "Spec" },
  terminal: { icon: TerminalIcon, label: "Terminal" },
};

/** A tab's label, with the number of changed files on Changes and of failing checks on Checks. */
const TabLabel = (props: { tab: BarTab }) => {
  const { view, variant } = useTaskPage();
  const status = useVariantStatus(view, variant);
  const { icon: Icon, label } = TAB_LABEL[props.tab];
  let count: number | undefined;
  if (props.tab === "changes") {
    count = status.stats?.files;
  } else if (props.tab === "checks" && status.failing > 0) {
    count = status.failing;
  }
  return (
    <>
      <Icon className="size-4" /> {label}
      {count !== undefined && (
        <span
          className={cn(
            "text-xs tabular-nums",
            props.tab === "checks"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {count}
        </span>
      )}
    </>
  );
};

/**
 * The task page: the header and progress stepper, then the variants and conversations on the left, the selected
 * variant's tabs in the middle, and its status on the right (or at the end of the tab bar row below 1440px).
 */
export const ProjectTask = () => {
  const view = useProjectView();
  const { task = "" } = useParams({ strict: false });
  // The tab route the router rendered, not the URL: while it navigates to the Review page (a sibling route), the URL
  // already reads `/review` but this page is still mounted, and must not take that for an unknown tab.
  const tabRoute: string | undefined = useChildMatches()[0]?.routeId;
  const { report } = useDash();
  const [params] = useSearchParams();
  const record = taskOf(view, task);
  const sessions = taskSessions(view, task).filter((session) =>
    record?.variants.some((v) => v.sessionId === session.id)
  );
  const projectPath = `/p/${encodeURIComponent(view.project.id)}`;

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
  if (record.state === "draft") {
    return <DraftTask view={view} task={record} />;
  }
  const variant = selectedVariant(record, params.get("v"));
  const tabs = taskTabs(record);
  const current = (tabRoute?.split("/").pop() || "conversation") as TaskTab;
  const v = params.get("v");
  const hrefOf = (tab: TaskTab) =>
    taskHref(view.project.id, record.id, {
      tab,
      ...(v ? { v: Number(v) } : {}),
    });
  // The Overview/Compare tabs of earlier versions, and tabs this task doesn't have.
  if (params.get("tab") === "compare" && tabs.includes("compare")) {
    return <Navigate replace to={hrefOf("compare")} />;
  }
  if (tabRoute && !tabs.includes(current)) {
    return <Navigate replace to={hrefOf("conversation")} />;
  }

  const header = (
    <TaskHeader
      view={view}
      task={record}
      variant={variant}
      sessions={sessions}
    />
  );
  if (!variant) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Empty title="No variants">
          <p className={muted}>This task has nothing to show yet.</p>
        </Empty>
      </div>
    );
  }

  // A variant still being set up (or that failed to) shows its setup log instead of its tabs' content.
  const setup =
    startingVariants(record).some((s) => s.n === variant.n) &&
    current !== "compare" &&
    current !== "spec";
  const barTabs = tabs.filter((tab): tab is BarTab => tab !== "compare");
  const frame = { current, task: record, variant, view };

  return (
    <TaskPageCtx value={{ sessions, task: record, variant, view }}>
      {/* Fills a workspace tab's height, so the composer or terminal sits at the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {header}
        <TaskStepper
          view={view}
          task={record}
          variant={variant}
          sessions={sessions}
        />
        <PhoneVariants {...frame} />
        <TaskReviews task={record} />
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[3.5rem_minmax(0,1fr)] lg:grid-cols-[14rem_minmax(0,1fr)] min-[90rem]:grid-cols-[14rem_minmax(0,1fr)_17rem]">
          <div className="hidden min-h-0 flex-col border-r pr-3 md:flex">
            <TaskSidebar {...frame} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
              <div className="max-w-full min-w-0 flex-[1_0_auto]">
                <TabBar label="Task">
                  {barTabs.map((tab) => {
                    const link = (
                      <TabLink
                        key={tab}
                        to={hrefOf(tab)}
                        end={tab === "conversation"}
                      >
                        <TabLabel tab={tab} />
                      </TabLink>
                    );
                    // Checks is the rail's content; it's listed only on phones, which have no rail or strip.
                    return tab === "checks" ? (
                      <span key={tab} className="contents md:hidden">
                        {link}
                      </span>
                    ) : (
                      link
                    );
                  })}
                </TabBar>
              </div>
              <TaskStatusStrip className="ml-auto hidden md:flex min-[90rem]:hidden" />
            </div>
            {variant.branch && (
              <Chip className="self-start font-mono md:hidden">
                {variant.branch}
              </Chip>
            )}
            {current === "conversation" && !setup && (
              <PhoneThreadSelect {...frame} />
            )}
            {!setup &&
              current === "conversation" &&
              variant.sessionId &&
              variant.error &&
              variant.error !== FIRST_TURN_SENDING && (
                <Alert className="border-warn/40 bg-warn/10">
                  <AlertDescription className="text-warn">
                    {variant.error}
                  </AlertDescription>
                </Alert>
              )}
            {setup ? (
              <VariantSetup
                variant={variant}
                onDismiss={() =>
                  void dismissStarting(view.project.id, task).catch(report)
                }
              />
            ) : (
              <Outlet />
            )}
          </div>
          <TaskStatusPanel className="hidden overflow-y-auto border-l pl-4 min-[90rem]:flex" />
        </div>
      </div>
    </TaskPageCtx>
  );
};

/** The spec chain, and the selected variant's OpenSpec change. */
export const TaskSpec = () => {
  const { view, task, variant, sessions } = useTaskPage();
  const all = specSessions(task, sessions);
  const own = all.filter((s) => s.id === variant.sessionId);
  const shown = own.length > 0 ? own : all;
  const reviews = byDirectory(
    shown.map((s) => s.directory),
    useQueries({
      queries: shown.map((s) => reviewQuery(view.project.id, s.directory)),
    })
  );
  return (
    <div className="flex flex-col gap-4">
      {shown.length > 0 ? (
        <SpecSection
          projectId={view.project.id}
          task={task}
          sessions={shown}
          reviews={reviews}
        />
      ) : (
        <Empty title="No change yet">
          <p className={muted}>This variant has no OpenSpec change to show.</p>
        </Empty>
      )}
      <SpecChain view={view} task={task} />
    </div>
  );
};

/** Every variant, then their live sessions side by side, with Pick. */
export const TaskCompare = () => {
  const { view, task: record, sessions } = useTaskPage();
  const { report } = useDash();
  const task = record.id;
  const queryClient = useQueryClient();
  const directories = [...new Set(sessions.map((s) => s.directory))];
  const specVariants = specSessions(record, sessions);
  // Shared with each checkout's Changes, and refreshed when an agent there finishes a turn.
  const reviews = byDirectory(
    directories,
    useQueries({
      queries: directories.map((d) => reviewQuery(view.project.id, d)),
    })
  );
  const specDirectories = specVariants.map((s) => s.directory);
  const specs = byDirectory(
    specDirectories,
    useQueries({
      queries: specVariants.map((s) =>
        specQuery(view.project.id, s.directory, s.id)
      ),
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

  return (
    <div className="flex flex-col gap-4">
      {notice && (
        <Alert className="border-ok/40 bg-ok/10">
          <AlertDescription className="text-ok">{notice}</AlertDescription>
        </Alert>
      )}
      <VariantTable view={view} task={record} />
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
        <Empty title="No live conversations">
          <p className={muted}>
            The variants&apos; conversations are gone, so there is nothing to
            compare.
          </p>
        </Empty>
      )}
    </div>
  );
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
                  const n = task.variants.find((v) => v.sessionId === s.id)?.n;
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
                        {checkout && n !== undefined && (
                          <Button asChild variant="outline" size="sm">
                            <Link
                              to={taskHref(view.project.id, task.id, {
                                tab: "changes",
                                v: n,
                              })}
                            >
                              Changes
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
