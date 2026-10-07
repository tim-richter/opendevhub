import {
  GitBranchIcon,
  InfoIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { ProjectView } from "../../shared/types";
import { refreshWorktrees } from "../api";
import {
  checkoutCounts,
  checkoutOf,
  checkoutPath,
  checkouts,
  checkoutTone,
  orphanSessions,
  projectTasks,
} from "../checkouts";
import type { Checkout } from "../checkouts";
import { CopyButton } from "../components/CopyButton";
import { EnvBadge } from "../components/EnvBadge";
import { OpenInMenu } from "../components/OpenInMenu";
import {
  Chip,
  GroupTitle,
  muted,
  Note,
  PageHeader,
  Section,
} from "../components/Page";
import { AllContainersMenu, projectFlags } from "../components/ProjectActions";
import { ProjectSettingsButton } from "../components/ProjectSettingsDialog";
import { ResourceStat } from "../components/ResourceStat";
import { SessionList } from "../components/SessionList";
import { STATE_LABEL, StatusDot, TONE_LABEL } from "../components/Status";
import { Tip } from "../components/Tip";
import {
  checkoutReady,
  ContainerMenu,
  NewWorktreeButton,
  useCheckoutActions,
} from "../components/Worktrees";
import { useDash } from "../DashboardContext";
import {
  compareSessions,
  envOfDirectory,
  needsAttention,
  projectTone,
  workspaceFolderOf,
} from "../derive";
import { checkoutResources } from "../resources";
import { formatCost, formatTokens } from "../tasks";
import { projectUsage } from "../usage";
import { useProjectView } from "./ProjectLayout";

export const ProjectOverview = () => {
  const view = useProjectView();
  const { newTask, snapshot } = useDash();
  const [params] = useSearchParams();
  const { runtime, project } = view;
  const usage = projectUsage(snapshot, project.id);
  const { running } = projectFlags(view, false);
  const root = runtime.worktreeRoot;

  // Pick up worktrees made outside opendevhub (by opencode or a shell).
  useEffect(() => {
    if (running) {
      void refreshWorktrees(project.id).catch(() => undefined);
    }
  }, [project.id, running]);

  // `?session=` (from notifications and new tasks) goes to the session's checkout once it is known.
  const highlight = params.get("session");
  const highlighted = highlight
    ? view.sessions.find((s) => s.id === highlight)
    : undefined;
  const target = highlighted && checkoutOf(view, highlighted.directory)?.target;
  if (highlight && target !== undefined) {
    return (
      <Navigate
        replace
        to={`${checkoutPath(project.id, target)}?session=${encodeURIComponent(highlight)}`}
      />
    );
  }

  const attention = view.sessions
    .filter((s) => needsAttention(s.status))
    .toSorted(compareSessions);
  const tasks = projectTasks(view);
  const orphans = orphanSessions(view).toSorted(compareSessions);

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
              <span className="truncate">{project.path}</span>{" "}
              <CopyButton text={project.path} label="Copy path" />
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant="outline"
                className={STATE_PILL[runtime.containerState]}
              >
                {STATE_LABEL[runtime.containerState]}
              </Badge>
              {running && (
                <Badge
                  variant="outline"
                  className={OPENCODE_PILL[runtime.opencode]}
                >
                  opencode {runtime.opencode}
                  {runtime.opencodeVersion
                    ? ` · v${runtime.opencodeVersion}`
                    : ""}
                </Badge>
              )}
            </div>
            {usage && (
              <p
                className="text-xs tabular-nums"
                title={`Tokens today ${formatTokens(usage.today.tokens)} · all time ${formatTokens(usage.total.tokens)}`}
              >
                Today {formatCost(usage.today.cost)} · All time{" "}
                {formatCost(usage.total.cost)}
              </p>
            )}
          </div>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => newTask(project.id)}
              title="New task (n)"
            >
              <PlusIcon /> New task
            </Button>
            <OpenInMenu
              view={view}
              directory={workspaceFolderOf(view)}
              hostPath={project.path}
            />
            <ProjectSettingsButton view={view} />
            <AllContainersMenu view={view} />
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
          <SessionList
            entries={attention.map((session) => ({ session, view }))}
          />
        </Section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <GroupTitle className="mb-0">Worktrees</GroupTitle>
          {root?.mounted && (
            <Tip
              label={
                <>
                  Worktrees live in{" "}
                  <code className="font-mono">{root.host}</code>, mounted at{" "}
                  <code className="font-mono">{root.container}</code>.
                </>
              }
            >
              <InfoIcon
                className="text-muted-foreground size-4"
                tabIndex={0}
                aria-label="Where worktrees live"
              />
            </Tip>
          )}
          <span className="flex-1" />
          {running && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void refreshWorktrees(project.id).catch(() => undefined)
              }
            >
              <RefreshCwIcon /> Refresh
            </Button>
          )}
          <NewWorktreeButton view={view} />
        </div>
        {!running && (
          <Note>
            Start the project to create worktrees. Worktrees on this machine can
            still be opened.
          </Note>
        )}
        <ul className="grid gap-3 md:grid-cols-2">
          {checkouts(view).map((c) => (
            <CheckoutCard key={c.directory} view={view} checkout={c} />
          ))}
        </ul>
      </section>

      {tasks.length > 0 && (
        <Section title="Tasks" hint="each variant works in its own worktree">
          <ul>
            {tasks.map((t) => (
              <li
                key={t.task}
                className="hover:bg-muted/50 border-t first:border-t-0"
              >
                <Link
                  className="flex items-center gap-3 px-4 py-2"
                  to={`/p/${encodeURIComponent(project.id)}/t/${encodeURIComponent(t.task)}`}
                >
                  <StatusDot tone={taskTone(t)} />
                  <span className="flex-1 truncate">{t.title || "Task"}</span>
                  <span className={muted}>
                    {t.starting && "starting · "}
                    {t.variants} variant{t.variants === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {orphans.length > 0 && (
        <Section
          title="Other sessions"
          hint="in folders that are no longer a worktree"
        >
          <SessionList
            entries={orphans.map((session) => ({ session, view }))}
            highlight={highlight ?? undefined}
          />
        </Section>
      )}
    </>
  );
};

const CheckoutCard = ({
  view,
  checkout: c,
}: {
  view: ProjectView;
  checkout: Checkout;
}) => {
  const navigate = useNavigate();
  const { running } = projectFlags(view, false);
  const { pending, newSession, remove } = useCheckoutActions(view);
  const env = envOfDirectory(view, c.directory);
  const tone = checkoutTone(view, c.directory);
  const n = checkoutCounts(view, c.directory);
  const to = checkoutPath(view.project.id, c.target);
  const { snapshot } = useDash();
  const resources = checkoutResources(snapshot, view, c);

  return (
    <li>
      <Card
        className={cn(
          "hover:border-foreground/20 h-full min-w-0 cursor-pointer gap-2 px-4 py-3 transition-[border-color,box-shadow] hover:shadow-md",
          tone === "attention" && "border-attention/60"
        )}
        onClick={() => void navigate(to)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={tone} label={TONE_LABEL[tone]} />
          <Link
            to={to}
            className="flex min-w-0 items-center gap-1.5 font-semibold hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {c.worktree && (
              <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="truncate">{c.label}</span>
          </Link>
          {!c.worktree && <Chip className="ml-auto">main</Chip>}
        </div>
        <p
          className="text-muted-foreground flex min-w-0 items-center gap-1 font-mono text-xs"
          title={c.hostPath ?? c.directory}
        >
          {c.hostPath ? (
            <>
              <span className="truncate">{c.hostPath}</span>
              <span role="presentation" onClick={(e) => e.stopPropagation()}>
                <CopyButton text={c.hostPath} label="Copy path" />
              </span>
            </>
          ) : (
            <span className="truncate">only in container ({c.directory})</span>
          )}
        </p>
        <div className="text-muted-foreground flex min-h-5 flex-wrap items-center gap-x-3.5 gap-y-1 text-xs">
          {n.attention > 0 && (
            <span className="text-attention font-semibold">
              {n.attention} need you
            </span>
          )}
          {n.running > 0 && <span>{n.running} working</span>}
          {n.idle > 0 && <span>{n.idle} idle</span>}
          {n.attention + n.running + n.idle === 0 && <span>No sessions</span>}
          {resources && <ResourceStat {...resources} className="ml-auto" />}
        </div>
        {env && (
          <div>
            <EnvBadge env={env} />
          </div>
        )}
        <div
          role="presentation"
          className="mt-auto flex cursor-default items-center gap-2 pt-1"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!checkoutReady(view, c) || !!pending}
            onClick={() => newSession(c)}
          >
            New session
          </Button>
          <OpenInMenu
            view={view}
            directory={c.directory}
            hostPath={c.hostPath}
            compact
          />
          <ContainerMenu view={view} checkout={c} compact />
          {c.worktree && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground ml-auto"
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
};

const STATE_PILL: Record<ProjectView["runtime"]["containerState"], string> = {
  error: "border-destructive/45 text-destructive",
  running: "border-ok/45 text-ok",
  starting: "border-warn/45 text-warn",
  stopped: "text-muted-foreground",
  stopping: "border-warn/45 text-warn",
};

const OPENCODE_PILL: Record<ProjectView["runtime"]["opencode"], string> = {
  absent: "text-muted-foreground",
  healthy: "border-ok/45 text-ok",
  starting: "border-warn/45 text-warn",
  unhealthy: "border-destructive/45 text-destructive",
};

const taskTone = (t: {
  attention: boolean;
  running: boolean;
}): "attention" | "running" | "ok" => {
  if (t.attention) {
    return "attention";
  }
  return t.running ? "running" : "ok";
};
