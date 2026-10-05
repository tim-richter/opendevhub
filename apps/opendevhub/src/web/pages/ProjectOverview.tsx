import { useEffect } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import type { ProjectView } from "../../shared/types";
import { refreshWorktrees } from "../api";
import { CopyButton } from "../components/CopyButton";
import { GitBranchIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Chip, GroupTitle, muted, Note, PageHeader, Section } from "../components/Page";
import { OpenInMenu } from "../components/OpenInMenu";
import { MoreMenu, OpenButton, projectFlags, StartStopButton } from "../components/ProjectActions";
import { SessionList } from "../components/SessionList";
import { STATE_LABEL, StatusDot, TONE_LABEL } from "../components/Status";
import { EnvBadge } from "../components/EnvBadge";
import { checkoutReady, ContainerMenu, NewWorktreeForm, UnmountedNotice, useCheckoutActions } from "../components/Worktrees";
import { type Checkout, checkoutCounts, checkoutOf, checkoutPath, checkouts, checkoutTone, orphanSessions, projectTasks } from "../checkouts";
import { useDash } from "../DashboardContext";
import { formatCost, formatTokens } from "../tasks";
import { projectUsage } from "../usage";
import { compareSessions, envOfDirectory, needsAttention, projectTone, workspaceFolderOf } from "../derive";
import { useProjectView } from "./ProjectLayout";

export function ProjectOverview() {
  const view = useProjectView();
  const { newTask, snapshot } = useDash();
  const [params] = useSearchParams();
  const { runtime, project } = view;
  const usage = projectUsage(snapshot, project.id);
  const { running } = projectFlags(view, false);
  const root = runtime.worktreeRoot;

  // Pick up worktrees made outside opendevhub (by opencode or a shell).
  useEffect(() => {
    if (running) void refreshWorktrees(project.id).catch(() => {});
  }, [project.id, running]);

  // `?session=` (from notifications and new tasks) goes to the session's checkout once it is known.
  const highlight = params.get("session");
  const highlighted = highlight ? view.sessions.find((s) => s.id === highlight) : undefined;
  const target = highlighted && checkoutOf(view, highlighted.directory)?.target;
  if (highlight && target !== undefined) return <Navigate replace to={`${checkoutPath(project.id, target)}?session=${encodeURIComponent(highlight)}`} />;

  const attention = view.sessions.filter((s) => needsAttention(s.status)).sort(compareSessions);
  const tasks = projectTasks(view);
  const orphans = orphanSessions(view).sort(compareSessions);

  return (
    <>
      <PageHeader
        title={
          <>
            <StatusDot tone={projectTone(view)} /> {project.name}
          </>
        }
        description={
          <div className="flex flex-col gap-2">
            <p className="flex min-w-0 items-center gap-1 font-mono text-xs">
              <span className="truncate">{project.path}</span> <CopyButton text={project.path} label="Copy path" />
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className={STATE_PILL[runtime.containerState]}>
                {STATE_LABEL[runtime.containerState]}
              </Badge>
              {running && (
                <Badge variant="outline" className={OPENCODE_PILL[runtime.opencode]}>
                  opencode {runtime.opencode}
                  {runtime.opencodeVersion ? ` · v${runtime.opencodeVersion}` : ""}
                </Badge>
              )}
            </div>
            {usage && (
              <p
                className="text-xs tabular-nums"
                title={`Tokens today ${formatTokens(usage.today.tokens)} · all time ${formatTokens(usage.total.tokens)}`}
              >
                Today {formatCost(usage.today.cost)} · All time {formatCost(usage.total.cost)}
              </p>
            )}
          </div>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => newTask(project.id)} title="New task (n)">
              <PlusIcon /> New task
            </Button>
            <StartStopButton view={view} />
            <OpenButton view={view} />
            <OpenInMenu view={view} directory={workspaceFolderOf(view)} hostPath={project.path} />
            <MoreMenu view={view} />
          </>
        }
      />

      {runtime.error && (
        <Alert variant="destructive">
          <AlertDescription>{runtime.error}</AlertDescription>
        </Alert>
      )}

      {attention.length > 0 && (
        <Section title="Needs you" hint={attention.length} attention>
          <SessionList entries={attention.map((session) => ({ session, view }))} />
        </Section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <GroupTitle className="mb-0 flex-1">Worktrees</GroupTitle>
          {running && (
            <Button variant="ghost" size="sm" onClick={() => void refreshWorktrees(project.id).catch(() => {})}>
              <RefreshCwIcon /> Refresh
            </Button>
          )}
        </div>
        {!running && <Note>Start the project to create worktrees. Worktrees on this machine can still be opened.</Note>}
        <UnmountedNotice view={view} />
        {running && root?.mounted && <NewWorktreeForm view={view} />}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
          {checkouts(view).map((c) => (
            <CheckoutCard key={c.directory} view={view} checkout={c} />
          ))}
        </ul>
        {root?.mounted && (
          <p className={muted}>
            Worktrees live in <code className="font-mono">{root.host}</code>, mounted at <code className="font-mono">{root.container}</code>.
          </p>
        )}
      </section>

      {tasks.length > 0 && (
        <Section title="Tasks" hint="each variant works in its own worktree">
          <ul>
            {tasks.map((t) => (
              <li key={t.task} className="border-t first:border-t-0 hover:bg-muted/50">
                <Link className="flex items-center gap-3 px-4 py-2" to={`/p/${encodeURIComponent(project.id)}/t/${encodeURIComponent(t.task)}`}>
                  <StatusDot tone={t.attention ? "attention" : t.running ? "running" : "ok"} />
                  <span className="flex-1 truncate">{t.title || "Task"}</span>
                  <span className={muted}>
                    {t.variants} variant{t.variants === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {orphans.length > 0 && (
        <Section title="Other sessions" hint="in folders that are no longer a worktree">
          <SessionList entries={orphans.map((session) => ({ session, view }))} highlight={highlight ?? undefined} />
        </Section>
      )}
    </>
  );
}

function CheckoutCard({ view, checkout: c }: { view: ProjectView; checkout: Checkout }) {
  const navigate = useNavigate();
  const { running } = projectFlags(view, false);
  const { pending, newSession, remove } = useCheckoutActions(view);
  const env = envOfDirectory(view, c.directory);
  const tone = checkoutTone(view, c.directory);
  const n = checkoutCounts(view, c.directory);
  const to = checkoutPath(view.project.id, c.target);

  return (
    <li>
      <Card
        className={cn(
          "h-full min-w-0 cursor-pointer gap-2 px-4 py-3 transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-md",
          tone === "attention" && "border-attention/60",
        )}
        onClick={() => void navigate(to)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={tone} label={TONE_LABEL[tone]} />
          <Link to={to} className="flex min-w-0 items-center gap-1.5 font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
            {c.worktree && <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate">{c.label}</span>
          </Link>
          {!c.worktree && <Chip className="ml-auto">main</Chip>}
        </div>
        <p className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground" title={c.hostPath ?? c.directory}>
          {c.hostPath ? (
            <>
              <span className="truncate">{c.hostPath}</span>
              <span onClick={(e) => e.stopPropagation()}>
                <CopyButton text={c.hostPath} label="Copy path" />
              </span>
            </>
          ) : (
            <span className="truncate">only in container ({c.directory})</span>
          )}
        </p>
        <div className="flex min-h-5 flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          {n.attention > 0 && <span className="font-semibold text-attention">{n.attention} need you</span>}
          {n.running > 0 && <span>{n.running} working</span>}
          {n.idle > 0 && <span>{n.idle} idle</span>}
          {n.attention + n.running + n.idle === 0 && <span>No sessions</span>}
        </div>
        {env && (
          <div>
            <EnvBadge env={env} />
          </div>
        )}
        <div className="mt-auto flex cursor-default items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" disabled={!checkoutReady(view, c) || !!pending} onClick={() => newSession(c)}>
            New session
          </Button>
          <OpenInMenu view={view} directory={c.directory} hostPath={c.hostPath} compact />
          <ContainerMenu view={view} checkout={c} compact />
          {c.worktree && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto text-muted-foreground"
              aria-label={`Remove worktree ${c.label}`}
              title="Remove worktree"
              disabled={!running || !!pending}
              onClick={() => remove(c)}
            >
              <XIcon />
            </Button>
          )}
        </div>
      </Card>
    </li>
  );
}

const STATE_PILL: Record<ProjectView["runtime"]["containerState"], string> = {
  running: "border-ok/45 text-ok",
  starting: "border-warn/45 text-warn",
  stopping: "border-warn/45 text-warn",
  error: "border-destructive/45 text-destructive",
  stopped: "text-muted-foreground",
};

const OPENCODE_PILL: Record<ProjectView["runtime"]["opencode"], string> = {
  healthy: "border-ok/45 text-ok",
  starting: "border-warn/45 text-warn",
  unhealthy: "border-destructive/45 text-destructive",
  absent: "text-muted-foreground",
};
