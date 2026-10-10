import { GitBranchIcon, InfoIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ProjectView } from "../../../shared/types";
import { archiveTask, refreshWorktrees } from "../../api";
import { CopyButton } from "../../components/copy-button";
import { EnvBadge } from "../../components/env-badge";
import { Chip, muted, Note, PageHeader, Section } from "../../components/page";
import { ResourceStat } from "../../components/resource-stat";
import { STATE_LABEL, StatusDot, TONE_LABEL } from "../../components/status";
import { Tip } from "../../components/tip";
import { useDash } from "../../dashboard-context";
import {
  compareSessions,
  envOfDirectory,
  needsAttention,
  projectTone,
  workspaceFolderOf,
} from "../../derive";
import { checkoutResources } from "../../lib/resources";
import { Link, Navigate, useSearchParams } from "../../routing";
import {
  checkoutCounts,
  checkoutOf,
  checkoutPath,
  checkouts,
  checkoutTone,
  orphanSessions,
  projectTasks,
} from "../checkouts/checkouts";
import type { Checkout, ProjectTask } from "../checkouts/checkouts";
import { OpenInMenu } from "../checkouts/open-in-menu";
import { WorktreeCreator } from "../checkouts/worktree-creator";
import {
  checkoutReady,
  ContainerMenu,
  NewWorktreeButton,
  useCheckoutActions,
} from "../checkouts/worktrees";
import { SessionList } from "../sessions/session-list";
import { formatCost, formatTokens, taskPath } from "../tasks/tasks";
import { projectUsage } from "../usage/usage";
import { AllContainersMenu, projectFlags } from "./project-actions";
import { useProjectView } from "./project-layout";
import { ProjectSettingsButton } from "./project-settings-dialog";

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
  const active = tasks.filter((t) => t.state !== "ended");
  const ended = tasks.filter((t) => t.state === "ended");
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
            showMain
            entries={attention.map((session) => ({ session, view }))}
          />
        </Section>
      )}

      <Section
        title="Worktrees"
        hint={
          root?.mounted && (
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
                className="size-4 align-[-3px]"
                tabIndex={0}
                aria-label="Where worktrees live"
              />
            </Tip>
          )
        }
        action={
          <div className="flex items-center gap-1">
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
        }
      >
        {!running && (
          <Note className="m-3">
            Start the project to create worktrees. Worktrees on this machine can
            still be opened.
          </Note>
        )}
        <ul>
          {checkouts(view).map((c) => (
            <CheckoutRow key={c.directory} view={view} checkout={c} />
          ))}
        </ul>
      </Section>

      {active.length > 0 && (
        <Section title="Tasks" hint="each variant works in its own worktree">
          <ul>
            {active.map((t) => (
              <TaskRow key={t.task} projectId={project.id} task={t} />
            ))}
          </ul>
        </Section>
      )}

      {ended.length > 0 && <EndedTasks projectId={project.id} tasks={ended} />}

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

/** One checkout: the whole row opens it; its own buttons sit above the stretched link. */
const CheckoutRow = ({
  view,
  checkout: c,
}: {
  view: ProjectView;
  checkout: Checkout;
}) => {
  const { pending, newSession, remove } = useCheckoutActions(view);
  const env = envOfDirectory(view, c.directory);
  const tone = checkoutTone(view, c.directory);
  const n = checkoutCounts(view, c.directory);
  const to = checkoutPath(view.project.id, c.target);
  const { snapshot } = useDash();
  const resources = checkoutResources(snapshot, view, c);

  return (
    <li
      className={cn(
        "hover:bg-muted/50 relative grid items-center gap-x-5 gap-y-2 border-t px-4 py-3 first:border-t-0",
        "md:grid-cols-[minmax(0,1fr)_9rem_auto_auto]",
        tone === "attention" && "shadow-[inset_3px_0_var(--attention)]"
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={tone} label={TONE_LABEL[tone]} />
          <Link
            to={to}
            className="flex min-w-0 items-center gap-1.5 font-semibold after:absolute after:inset-0 hover:underline"
          >
            {c.worktree && (
              <GitBranchIcon className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="truncate">{c.label}</span>
          </Link>
          {!c.worktree && <Chip>main</Chip>}
          {env && (
            <span className="relative">
              <EnvBadge env={env} />
            </span>
          )}
          {c.worktree && (
            <span className="relative flex min-w-0 items-center gap-2">
              <WorktreeCreator
                projectId={view.project.id}
                worktree={c.worktree}
              />
            </span>
          )}
        </div>
        <p
          className="text-muted-foreground flex min-w-0 items-center gap-1 pl-4 font-mono text-xs"
          title={c.hostPath ?? c.directory}
        >
          {c.hostPath ? (
            <>
              <span className="truncate">{c.hostPath}</span>
              <span className="relative">
                <CopyButton text={c.hostPath} label="Copy path" />
              </span>
            </>
          ) : (
            <span className="truncate">only in container ({c.directory})</span>
          )}
        </p>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs max-md:pl-4">
        {n.attention > 0 && (
          <span className="text-attention font-semibold">
            {n.attention} {n.attention === 1 ? "needs" : "need"} you
          </span>
        )}
        {n.running > 0 && <span>{n.running} working</span>}
        {n.idle > 0 && <span>{n.idle} idle</span>}
        {n.attention + n.running + n.idle === 0 && <span>No sessions</span>}
      </div>
      <span className="max-md:hidden">
        {resources && <ResourceStat {...resources} />}
      </span>
      <div className="relative flex items-center gap-2 max-md:pl-4 md:justify-self-end">
        <Button
          variant="outline"
          size="sm"
          disabled={!checkoutReady(view, c) || !!pending}
          onClick={() => newSession(c)}
        >
          <PlusIcon /> Session
        </Button>
        <OpenInMenu
          view={view}
          directory={c.directory}
          hostPath={c.hostPath}
          compact
        />
        <ContainerMenu
          view={view}
          checkout={c}
          compact
          onRemoveWorktree={
            c.worktree && !pending ? () => remove(c) : undefined
          }
        />
      </div>
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

const TaskRow = (props: {
  projectId: string;
  task: ProjectTask;
  action?: ReactNode;
}) => {
  const { task: t } = props;
  return (
    <li className="hover:bg-muted/50 flex items-center border-t first:border-t-0">
      <Link
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2"
        to={taskPath(props.projectId, t.task)}
      >
        <StatusDot tone={t.state === "ended" ? "off" : taskTone(t)} />
        <span className="flex-1 truncate">{t.title || "Task"}</span>
        <span className={muted}>
          {t.state === "starting" && "starting · "}
          {t.kind === "manual"
            ? "session"
            : `${t.variants} variant${t.variants === 1 ? "" : "s"}`}
        </span>
      </Link>
      {props.action && <span className="pr-3">{props.action}</span>}
    </li>
  );
};

/** Tasks whose sessions are all gone, collapsed until opened; each can be archived. */
const EndedTasks = (props: { projectId: string; tasks: ProjectTask[] }) => {
  const { report } = useDash();
  const [open, setOpen] = useState(false);
  return (
    <Section
      title={`Ended tasks (${props.tasks.length})`}
      hint="their sessions are gone; archive them to hide them"
      action={
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      {open && (
        <ul>
          {props.tasks.map((t) => (
            <TaskRow
              key={t.task}
              projectId={props.projectId}
              task={t}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void archiveTask(props.projectId, t.task).catch(report)
                  }
                >
                  Archive
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </Section>
  );
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
