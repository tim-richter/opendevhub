import { JiraSourceCard } from "../components/JiraSourceCard";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { ReviewData, SessionSummary, StartingVariant } from "../../shared/types";
import { dismissStarting, fetchReview, pickVariant } from "../api";
import { ChevronRightIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Empty, muted } from "../components/Page";
import { SessionBadge } from "../components/Status";
import { useDash } from "../DashboardContext";
import { checkoutOf, checkoutPath } from "../checkouts";
import { envOfDirectory, sessionHref } from "../derive";
import { EnvBadge } from "../components/EnvBadge";
import { useProjectView } from "./ProjectLayout";
import { formatUsage, taskUsage } from "../usage";
import { diffStats, formatCost, formatTokens, pickPrompts, removals, startStepLabel, taskSessions, variantName } from "../tasks";

/** A variant that is still being set up: where it is, and the last lines its setup wrote. */
function StartingCard(props: { variant: StartingVariant; onDismiss: () => void }) {
  const { variant: v } = props;
  const failed = v.step === "failed";
  return (
    <Card className={cn("min-w-0 gap-3 px-4 py-3", failed && "border-destructive/50")}>
      <header className="flex min-w-0 items-center gap-2">
        {failed ? null : <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        <strong className="truncate">{v.branch ?? `#${v.variant}`}</strong>
        {v.node && <span className={cn(muted, "truncate")}>on {v.node}</span>}
        <span className={cn("ml-auto shrink-0 text-sm", failed ? "text-destructive" : "text-muted-foreground")}>{startStepLabel(v.step)}</span>
      </header>
      {v.error && <p className="text-sm break-words text-destructive">{v.error}</p>}
      {v.log.length > 0 && (
        <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
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
}

export function ProjectTask() {
  const view = useProjectView();
  const { task = "" } = useParams();
  const { report, snapshot } = useDash();
  const total = taskUsage(snapshot, task);
  const sessions = taskSessions(view, task);
  const starting = view.starting?.find((t) => t.task === task);
  const jiraSource = starting?.jira ?? sessions.find((s) => s.task?.jira)?.task?.jira;
  // null: the changes couldn't be read.
  const [reviews, setReviews] = useState<Record<string, ReviewData | null>>({});
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

  // Reload a variant's changes when its session changes state (e.g. it finished a turn).
  const reloadKey = sessions.map((s) => `${s.id}:${s.status}:${s.directory}`).join("|");
  useEffect(() => {
    let live = true;
    for (const s of sessions) {
      fetchReview(view.project.id, s.directory).then(
        (r) => live && setReviews((all) => ({ ...all, [s.directory]: r })),
        () => live && setReviews((all) => ({ ...all, [s.directory]: null })),
      );
    }
    return () => {
      live = false;
    };
    // `sessions` is rebuilt on every snapshot; reloadKey holds what matters.
  }, [view.project.id, reloadKey]);

  const pick = async (keep: SessionSummary) => {
    if (picking) return;
    const others = sessions.filter((s) => s.id !== keep.id);
    const name = variantName(keep);
    const running = others.some((s) => s.status !== "idle");
    if (!confirm(pickPrompts(name, others.length, [], running).discard)) return;
    setPicking(true);
    setNotice(undefined);
    try {
      // Re-read the others' changes: the cached ones may predate edits made while this page was open.
      const dirs = [...new Set(others.map((s) => s.directory))];
      const fresh = await Promise.allSettled(dirs.map((d) => fetchReview(view.project.id, d)));
      if (!mounted.current) return;
      const dirty: Record<string, boolean> = {};
      fresh.forEach((r, i) => {
        if (r.status === "fulfilled") dirty[dirs[i]] = r.value.dirty;
      });
      const prompts = pickPrompts(name, others.length, removals(view, task, keep.id, dirty), running);
      const removeWorktrees = prompts.remove ? confirm(prompts.remove) : false;
      const r = await pickVariant(view.project.id, task, keep.id, removeWorktrees);
      const removed = r.removed.length > 0 ? `, removed ${r.removed.length} worktree${r.removed.length === 1 ? "" : "s"}` : "";
      if (mounted.current) setNotice(`Kept ${name}. Discarded ${r.discarded.length}${removed}.`);
      if (r.errors.length > 0) report(new Error(r.errors.join("; ")));
    } catch (e) {
      report(e);
    } finally {
      if (mounted.current) setPicking(false);
    }
  };

  if (sessions.length === 0 && !starting) {
    return (
      <Empty title="No variants to show">
        <p className={muted}>This task's sessions were discarded, or are older than the sessions opencode lists.</p>
        <Button asChild variant="link">
          <Link to={projectPath}>Back to {view.project.name}</Link>
        </Button>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to={projectPath} className="hover:text-foreground hover:underline">
          {view.project.name}
        </Link>
        <ChevronRightIcon className="size-3.5" /> Task
      </nav>
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-lg font-semibold">{starting?.title || sessions[0]?.task?.title || "Task"}</h2>
        <span className={muted}>
          {starting?.of ?? sessions.length} variant{(starting?.of ?? sessions.length) === 1 ? "" : "s"}
          {starting && starting.variants.some((v) => v.step !== "failed") && " · starting"}
          {total && <span className="tabular-nums"> · Total {formatUsage(total)}</span>}
        </span>
      </div>
      {jiraSource && <JiraSourceCard source={jiraSource} />}
      {notice && (
        <Alert className="border-ok/40 bg-ok/10">
          <AlertDescription className="text-ok">{notice}</AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
        {starting?.variants.map((v) => (
          <StartingCard key={`starting-${v.variant}`} variant={v} onDismiss={() => void dismissStarting(view.project.id, task).catch(report)} />
        ))}
        {sessions.map((s) => {
          const review = reviews[s.directory];
          const stats = review ? diffStats(review) : undefined;
          const checkout = checkoutOf(view, s.directory);
          const env = envOfDirectory(view, s.directory);
          return (
            <Card key={s.id} className="min-w-0 gap-3 px-4 py-3">
              <header className="flex min-w-0 items-center gap-2">
                <SessionBadge status={s.status} />
                <strong className="truncate">{variantName(s)}</strong>
              </header>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm [&_dd]:truncate [&_dt]:text-muted-foreground">
                <dt>Branch</dt>
                <dd className="font-mono text-xs">{review === undefined ? <Skeleton className="h-4 w-24" /> : (review?.branch ?? "—")}</dd>
                <dt>Container</dt>
                <dd>{env ? <EnvBadge env={env} /> : "Shared"}</dd>
                <dt>Cost</dt>
                <dd>{formatCost(s.cost)}</dd>
                <dt>Tokens</dt>
                <dd>{formatTokens(s.tokens)}</dd>
                <dt>Changes</dt>
                <dd>
                  {stats ? (
                    <>
                      {stats.files} file{stats.files === 1 ? "" : "s"} <span className="text-ok">+{stats.additions}</span>{" "}
                      <span className="text-destructive">−{stats.deletions}</span>
                      {review?.dirty ? <span className="text-muted-foreground"> · uncommitted</span> : null}
                    </>
                  ) : review === undefined ? (
                    <Skeleton className="h-4 w-32" />
                  ) : (
                    "—"
                  )}
                </dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                {checkout && (
                  <Button asChild variant="outline" size="sm">
                    <Link to={checkoutPath(view.project.id, checkout.target, "review")}>Review</Link>
                  </Button>
                )}
                <Button asChild variant="outline" size="sm">
                  <a href={sessionHref(view, s)} target="_blank" rel="noreferrer">
                    Open <ExternalLinkIcon />
                  </a>
                </Button>
                {sessions.length > 1 && (
                  <Button size="sm" disabled={picking} onClick={() => pick(s)}>
                    Pick this one
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
