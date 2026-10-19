import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Badge } from "@opendevhub/ui/badge";
import { Button } from "@opendevhub/ui/button";
import { Input } from "@opendevhub/ui/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranchIcon, InfoIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import type { ArchivedTask, ProjectView } from "../../../shared/types";
import {
  archiveTask,
  deleteArchivedTask,
  fetchArchivedTasks,
  refreshWorktrees,
  restoreTask,
} from "../../api";
import { confirm } from "../../components/confirm-dialog";
import { CopyButton } from "../../components/copy-button";
import { EnvBadge } from "../../components/env-badge";
import {
  Chip,
  muted,
  Note,
  PageHeader,
  Section,
  Segmented,
} from "../../components/page";
import { ResourceStat } from "../../components/resource-stat";
import { STATE_LABEL, StatusDot, TONE_LABEL } from "../../components/status";
import { Tip } from "../../components/tip";
import { useDash } from "../../dashboard-context";
import {
  envOfDirectory,
  matches,
  projectTone,
  workspaceFolderOf,
} from "../../derive";
import { checkoutResources } from "../../lib/resources";
import { Link, Navigate, useSearchParams } from "../../routing";
import { ActivityButton } from "../activity/activity-button";
import { ApprovalBanner, ProjectApprovals } from "../approvals/approval-review";
import { worktreeApproval } from "../approvals/approvals";
import { chatActivity, chatNeedsYou } from "../chat/chat";
import { ChatRow } from "../chat/chat-rows";
import {
  checkoutCounts,
  checkoutPath,
  checkoutTone,
  matchesTaskFilter,
  projectTasks,
  sessionPath,
  standaloneCheckouts,
} from "../checkouts/checkouts";
import type { Checkout, ProjectTask, TaskFilter } from "../checkouts/checkouts";
import { OpenInMenu } from "../checkouts/open-in-menu";
import { WorktreeCreator } from "../checkouts/worktree-creator";
import {
  checkoutReady,
  ContainerMenu,
  NewWorktreeButton,
  useCheckoutActions,
} from "../checkouts/worktrees";
import { PendingStack } from "../sessions/pending-cards";
import { TaskRow } from "../tasks/task-rows";
import { formatCost, formatTokens } from "../tasks/tasks";
import { projectUsage } from "../usage/usage";
import { AllContainersMenu, projectFlags } from "./project-actions";
import { useProjectView } from "./project-layout";
import { ProjectSettingsButton } from "./project-settings-dialog";
import { TodoButton } from "./todo-button";

/** How many chats the project page lists; the rest are on the chats page. */
const PROJECT_CHATS = 8;

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

  // `?session=` (from notifications and new conversations) goes to the session's task once it is known.
  const highlight = params.get("session");
  const highlighted = highlight
    ? view.sessions.find((s) => s.id === highlight)
    : undefined;
  // Its checkout unknown, sessionPath points back here; stay rather than loop.
  const destination = highlighted && sessionPath(view, highlighted);
  if (destination && !destination.includes("?session=")) {
    return <Navigate replace to={destination} />;
  }

  const chats = view.chats.toSorted(
    (a, b) => chatActivity(b) - chatActivity(a)
  );
  const waitingChats = chats.filter(chatNeedsYou);
  const otherChats = chats.filter((c) => !chatNeedsYou(c));

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
            <TodoButton projectId={project.id} subject={project.name} />
            <OpenInMenu
              view={view}
              directory={workspaceFolderOf(view)}
              hostPath={project.path}
            />
            <ActivityButton
              filter={{ projectId: project.id }}
              subject={project.name}
              empty="Nothing has happened in this project yet."
            />
            <ProjectSettingsButton view={view} />
            <AllContainersMenu view={view} />
          </>
        }
      />

      <ProjectApprovals view={view} />

      {runtime.error && (
        <Alert variant="destructive">
          <AlertDescription>{runtime.error}</AlertDescription>
        </Alert>
      )}

      {waitingChats.length > 0 && (
        <Section
          title="Chats waiting on you"
          hint={waitingChats.length}
          attention
        >
          <ul>
            {waitingChats.map((c) => (
              <ChatRow key={c.id} projectId={project.id} chat={c} />
            ))}
          </ul>
        </Section>
      )}

      <TasksCard view={view} />

      {otherChats.length > 0 && (
        <Section
          title="Chats"
          hint={otherChats.length}
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to={`/chats?project=${encodeURIComponent(project.id)}`}>
                Show all
              </Link>
            </Button>
          }
        >
          <ul>
            {otherChats.slice(0, PROJECT_CHATS).map((c) => (
              <ChatRow key={c.id} projectId={project.id} chat={c} />
            ))}
          </ul>
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
          {standaloneCheckouts(view).map((c) => (
            <CheckoutRow key={c.directory} view={view} checkout={c} />
          ))}
        </ul>
      </Section>
    </>
  );
};

/** The permission and question cards of a task's conversations that wait on the user, to answer in place. */
const WaitingCards = (props: { view: ProjectView; task: string }) => {
  const waiting = props.view.sessions.filter(
    (s) => s.task?.id === props.task && s.pending
  );
  if (waiting.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      {waiting.map((s) => (
        <PendingStack key={s.id} session={s} view={props.view} />
      ))}
    </div>
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
  const approval = c.worktree
    ? worktreeApproval(view, c.worktree.branch, env?.node)
    : undefined;

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
        {n.attention + n.running + n.idle === 0 && (
          <span>No conversations</span>
        )}
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
          <PlusIcon /> Conversation
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
      {approval && (
        <div className="relative md:col-span-4">
          <ApprovalBanner view={view} approval={approval} compact />
        </div>
      )}
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

type TasksView = "open" | "archived" | Exclude<TaskFilter, "all">;

const TASK_VIEWS: { id: TasksView; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "attention", label: "Needs you" },
  { id: "running", label: "Working" },
  { id: "idle", label: "Idle" },
  { id: "draft", label: "Drafts" },
  { id: "ended", label: "Ended" },
  { id: "archived", label: "Archived" },
];

const isTasksView = (v: string | null): v is TasksView =>
  TASK_VIEWS.some((o) => o.id === v);

/** Open is everything not ended: what needs the user first, then what is working, idle, and drafts. */
const inView = (t: ProjectTask, v: TasksView) =>
  v === "open"
    ? t.state !== "ended"
    : v !== "archived" && matchesTaskFilter(t, v);

const TASK_ORDER: TaskFilter[] = [
  "attention",
  "running",
  "idle",
  "draft",
  "ended",
];
const taskRank = (t: ProjectTask) =>
  TASK_ORDER.findIndex((f) => matchesTaskFilter(t, f));

/** The project's tasks in one card, filtered by state (`?tasks=`) and title (`?q=`); waiting ones answer in place, ended ones archive. */
const TasksCard = ({ view }: { view: ProjectView }) => {
  const { report } = useDash();
  const queryClient = useQueryClient();
  const [busyTask, setBusyTask] = useState<string>();
  const [params, setParams] = useSearchParams();
  const projectId = view.project.id;
  const archivedQuery = useQuery({
    queryKey: ["archived-tasks", projectId],
    queryFn: () => fetchArchivedTasks(projectId),
    refetchOnMount: "always",
  });
  const archivedTasks = archivedQuery.data ?? [];
  const raw = params.get("tasks");
  const filter: TasksView = isTasksView(raw) ? raw : "open";
  const q = params.get("q") ?? "";
  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) {
          next.set(key, value);
        } else {
          next.delete(key);
        }
        return next;
      },
      { replace: true }
    );

  const tasks = projectTasks(view);
  const searched = tasks.filter((t) => matches(q, t.title));
  const shown = searched
    .filter((t) => inView(t, filter))
    .toSorted((a, b) => taskRank(a) - taskRank(b));
  const waiting = tasks.filter((t) => matchesTaskFilter(t, "attention")).length;
  const archivedShown = archivedTasks.filter((t) => matches(q, t.title));
  const refreshArchived = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["archived-tasks", projectId],
    });
  };
  const archive = async (taskId: string) => {
    setBusyTask(taskId);
    try {
      await archiveTask(projectId, taskId);
      await refreshArchived();
    } catch (error) {
      report(error);
    } finally {
      setBusyTask(undefined);
    }
  };
  const changeArchived = async (
    task: ArchivedTask,
    action: "restore" | "delete"
  ) => {
    if (action === "delete") {
      const approved = await confirm({
        title: `Delete “${task.title}”?`,
        description:
          "This permanently removes the task record and its conversations, discarded variants' included. Worktrees and branches stay in place.",
        confirmLabel: "Delete task",
        destructive: true,
      });
      if (!approved) {
        return;
      }
    }
    setBusyTask(task.id);
    try {
      if (action === "restore") {
        await restoreTask(projectId, task.id);
      } else {
        await deleteArchivedTask(projectId, task.id);
      }
      await refreshArchived();
    } catch (error) {
      report(error);
    } finally {
      setBusyTask(undefined);
    }
  };

  let body;
  if (filter === "archived" && archivedQuery.isPending) {
    body = <p className={cn(muted, "px-4 py-3")}>Loading archived tasks…</p>;
  } else if (filter === "archived" && archivedQuery.isError) {
    body = (
      <p className="text-destructive px-4 py-3">
        Could not load archived tasks.
      </p>
    );
  } else if (filter === "archived" && archivedShown.length === 0) {
    body = <p className={cn(muted, "px-4 py-3")}>No archived tasks match.</p>;
  } else if (filter === "archived") {
    body = (
      <ul>
        {archivedShown.map((task) => (
          <li key={task.id} className="border-t first:border-t-0">
            <div className="flex flex-wrap items-center gap-3 px-4 py-2">
              <span className="min-w-0 basis-full truncate sm:flex-1 sm:basis-auto">
                {task.title || "Task"}
              </span>
              <span className={muted}>
                Archived {new Date(task.archivedAt).toLocaleDateString()} ·{" "}
                {task.variants} variant
                {task.variants === 1 ? "" : "s"}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busyTask === task.id}
                onClick={() => void changeArchived(task, "restore")}
              >
                Restore
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busyTask === task.id}
                onClick={() => void changeArchived(task, "delete")}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (tasks.length === 0) {
    body = (
      <p className={cn(muted, "px-4 py-3")}>
        No tasks yet. Start one, or make one from a chat.
      </p>
    );
  } else if (shown.length === 0) {
    body = <p className={cn(muted, "px-4 py-3")}>No tasks match.</p>;
  } else {
    body = (
      <ul>
        {shown.map((t) => (
          <TaskRow
            key={t.task}
            projectId={projectId}
            task={t}
            action={
              t.state === "ended" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyTask === t.task}
                  onClick={() => void archive(t.task)}
                >
                  Archive
                </Button>
              )
            }
          >
            {t.attention && <WaitingCards view={view} task={t.task} />}
          </TaskRow>
        ))}
      </ul>
    );
  }

  return (
    <Section
      title="Tasks"
      hint={tasks.filter((t) => inView(t, "open")).length}
      attention={waiting > 0}
      action={
        <div className="flex min-w-0 items-center justify-end gap-2.5 max-md:flex-wrap">
          <div className="max-w-full min-w-0 [scrollbar-width:none] overflow-x-auto max-md:w-full">
            <Segmented
              label="State"
              value={filter}
              onChange={(id) => set("tasks", id === "open" ? "" : id)}
              options={TASK_VIEWS.map((o) => ({
                id: o.id,
                label: (
                  <>
                    {o.label}{" "}
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {o.id === "archived"
                        ? archivedShown.length
                        : searched.filter((t) => inView(t, o.id)).length}
                    </span>
                  </>
                ),
              }))}
            />
          </div>
          <Input
            className="h-8 w-48 shrink-0 max-md:w-full"
            placeholder="Search tasks…"
            aria-label="Search tasks"
            value={q}
            onChange={(e) => set("q", e.target.value)}
          />
        </div>
      }
    >
      {body}
    </Section>
  );
};
