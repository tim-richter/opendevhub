import { Badge } from "@opendevhub/ui/badge";
import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import { Input } from "@opendevhub/ui/input";
import { Outlet, useLocation, useParams } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCompareIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  PlayIcon,
  PlusIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import type {
  ChatView,
  ForwardedPort,
  HostPortStatus,
} from "../../../shared/types";
import { refreshWorktrees } from "../../api";
import { CopyButton } from "../../components/copy-button";
import { EnvBadge } from "../../components/env-badge";
import {
  Chip,
  Empty,
  GroupTitle,
  muted,
  Note,
  PageHeader,
  TabBar,
  TabLink,
} from "../../components/page";
import { ResourceStat } from "../../components/resource-stat";
import { Count, StatusDot } from "../../components/status";
import { Tip } from "../../components/tip";
import { useDash } from "../../dashboard-context";
import { envOfDirectory, matches, sshAgentBadge } from "../../derive";
import { checkoutResources } from "../../lib/resources";
import { Link, Navigate, useNavigate } from "../../routing";
import { ActivityButton } from "../activity/activity-button";
import { ProvenanceBreadcrumb } from "../activity/provenance-breadcrumb";
import { checkoutChats } from "../chat/chat";
import { ChatRow } from "../chat/chat-rows";
import { CheckoutChecks } from "../checks/checks-panel";
import { PublishedPr } from "../forgejo/published-pr";
import { projectFlags, StartStopButton } from "../projects/project-actions";
import { useProjectView } from "../projects/project-layout";
import { TaskRow } from "../tasks/task-rows";
import { CheckoutProvider, useCheckoutContext } from "./checkout-context";
import type { ProjectTask } from "./checkouts";
import {
  checkoutCounts,
  checkoutPath,
  checkoutRuntime,
  checkouts,
  checkoutTasks,
  checkoutTone,
  sessionRedirect,
  worktreeRedirect,
} from "./checkouts";
import { OpenInMenu } from "./open-in-menu";
import { RuntimeControls, RuntimeLogs } from "./runtime-controls";
import { SavedPermissions } from "./saved-permissions";
import { WorktreeCreator } from "./worktree-creator";
import {
  checkoutReady,
  ContainerMenu,
  UnmountedNotice,
  useCheckoutActions,
} from "./worktrees";

/** Tasks a checkout lists before it offers a filter. */
const FILTER_FROM = 8;

/** Where the worktree came from; the project alone for the main checkout or while the trail loads. */
const CheckoutBreadcrumb = (props: {
  projectPath: string;
  projectName: string;
  worktreeId?: number;
}) => {
  const plain = (
    <nav
      aria-label="Breadcrumb"
      className="text-muted-foreground -mb-4 flex items-center gap-1 text-sm"
    >
      <Link
        to={props.projectPath}
        className="hover:text-foreground hover:underline"
      >
        {props.projectName}
      </Link>
      <ChevronRightIcon className="size-3.5" />
    </nav>
  );
  if (props.worktreeId !== undefined) {
    return (
      <ProvenanceBreadcrumb
        type="worktree"
        id={String(props.worktreeId)}
        className="-mb-4"
        fallback={plain}
      />
    );
  }
  return plain;
};

/** One checkout (the main one or a worktree) and its tabs. */
export const CheckoutPage = () => {
  const view = useProjectView();
  const { worktree = "", sessionId } = useParams({ strict: false });
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { running } = projectFlags(view, false);
  const { pending, newSession, remove, containerAction } =
    useCheckoutActions(view);
  const { snapshot } = useDash();
  const checkout = checkouts(view).find((c) => c.target === worktree);
  const projectPath = `/p/${encodeURIComponent(view.project.id)}`;

  // A worktree made a moment ago (or outside opendevhub) may not be listed yet.
  useEffect(() => {
    if (!checkout && running) {
      void refreshWorktrees(view.project.id).catch(() => undefined);
    }
  }, [checkout, running, view.project.id]);

  if (!checkout) {
    return (
      <Empty title="Unknown worktree">
        <p className={muted}>
          {view.project.name} has no worktree named {worktree}.
        </p>
        <Button asChild variant="link">
          <Link to={projectPath}>Back to {view.project.name}</Link>
        </Button>
      </Empty>
    );
  }

  const base = checkoutPath(view.project.id, checkout.target);
  // Sessions have no page any more, and a worktree a task made lives on that task's page.
  const redirectTo = sessionId
    ? sessionRedirect(view, checkout.target, sessionId)
    : worktreeRedirect(
        view,
        checkout,
        pathname.slice(base.length).split("/")[1] ?? ""
      );
  if (redirectTo) {
    return <Navigate replace to={redirectTo} />;
  }
  const n = checkoutCounts(view, checkout.directory);
  const env = envOfDirectory(view, checkout.directory);
  const agent = sshAgentBadge(checkoutRuntime(view, checkout.directory));
  const resources = checkoutResources(snapshot, view, checkout);

  const startControl =
    env && running ? (
      <Button
        variant="outline"
        disabled={
          !!pending ||
          env.runtime.containerState === "starting" ||
          env.runtime.containerState === "stopping"
        }
        onClick={() => containerAction(env, "start")}
      >
        <PlayIcon className="size-3" />{" "}
        {env.runtime.containerState === "starting"
          ? "Starting…"
          : "Start container"}
      </Button>
    ) : (
      <StartStopButton view={view} />
    );
  return (
    <>
      <CheckoutBreadcrumb
        projectPath={projectPath}
        projectName={view.project.name}
        worktreeId={checkout.worktree?.id}
      />
      <PageHeader
        title={
          <>
            <StatusDot tone={checkoutTone(view, checkout.directory)} />
            {checkout.worktree && (
              <GitBranchIcon className="text-muted-foreground size-5" />
            )}
            <span className="truncate">{checkout.label}</span>
          </>
        }
        description={
          <p className="flex min-w-0 items-center gap-1 font-mono text-xs">
            {checkout.hostPath ? (
              <>
                <span className="truncate">{checkout.hostPath}</span>{" "}
                <CopyButton text={checkout.hostPath} label="Copy path" />
              </>
            ) : (
              <span className="truncate">
                only in container ({checkout.directory})
              </span>
            )}
            {env && <EnvBadge env={env} />}
            {checkout.worktree && (
              <WorktreeCreator
                projectId={view.project.id}
                worktree={checkout.worktree}
              />
            )}
            <PublishedPr
              projectId={view.project.id}
              directory={checkout.directory}
              enabled={running}
            />
            {agent && (
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 font-normal",
                  agent.warn ? "text-warn" : "text-muted-foreground"
                )}
                title={agent.title}
              >
                <KeyRoundIcon className="size-3" /> {agent.label}
              </Badge>
            )}
            {resources && (
              <ResourceStat {...resources} className="ml-1 font-sans" />
            )}
          </p>
        }
        actions={
          <>
            {!checkout.worktree?.node && (
              <CheckoutChecks
                projectId={view.project.id}
                directory={checkout.directory}
              />
            )}
            {checkoutReady(view, checkout) ? (
              <Button
                variant="outline"
                disabled={!!pending}
                onClick={() => newSession(checkout)}
              >
                <PlusIcon /> New chat
              </Button>
            ) : (
              startControl
            )}
            {!checkout.worktree?.node && (
              <OpenInMenu
                view={view}
                directory={checkout.directory}
                hostPath={checkout.hostPath}
              />
            )}
            {checkout.worktree && (
              <ActivityButton
                filter={{
                  entity: {
                    id: String(checkout.worktree.id),
                    type: "worktree",
                  },
                }}
                subject={checkout.label}
                empty="Nothing recorded for this worktree yet."
              />
            )}
            <ContainerMenu
              view={view}
              checkout={checkout}
              onRemoveWorktree={
                checkout.worktree && !pending
                  ? () => remove(checkout, () => void navigate(projectPath))
                  : undefined
              }
            />
          </>
        }
      />

      {!checkout.worktree && <UnmountedNotice view={view} />}

      <TabBar label="Worktree">
        <TabLink to={base} end>
          <MessagesSquareIcon className="size-4" /> Conversations{" "}
          <Count n={n.attention} tone="attention" />
          {n.attention === 0 && <Count n={n.running + n.idle} tone="muted" />}
        </TabLink>
        <TabLink to={`${base}/review`}>
          <GitCompareIcon className="size-4" /> Changes
        </TabLink>
        <TabLink to={`${base}/terminal`}>
          <TerminalIcon className="size-4" /> Terminal
        </TabLink>
        <TabLink to={`${base}/runtime`}>
          <ServerIcon className="size-4" /> Runtime{" "}
          <Count
            n={checkoutRuntime(view, checkout.directory).ports?.length ?? 0}
            tone="muted"
          />
        </TabLink>
      </TabBar>

      <CheckoutProvider value={{ checkout, view }}>
        <Outlet />
      </CheckoutProvider>
    </>
  );
};

/** The chats and tasks whose conversations run in this checkout, each linking to its view, and a way to start a chat. */
export const CheckoutTasks = () => {
  const { view, checkout } = useCheckoutContext();
  const { newTask } = useDash();
  const [query, setQuery] = useState("");
  const canOpen = checkoutReady(view, checkout);
  const own = envOfDirectory(view, checkout.directory);
  const { pending, newSession } = useCheckoutActions(view);
  const all = useMemo(
    () => checkoutTasks(view, checkout.directory),
    [view, checkout.directory]
  );
  const allChats = useMemo(
    () => checkoutChats(view, checkout.directory),
    [view, checkout.directory]
  );

  if (all.length === 0 && allChats.length === 0) {
    return canOpen ? (
      <Empty title="No conversations in this checkout yet">
        <p className={muted}>
          Start a chat in this checkout, or a task for the project.
        </p>
        <div className="flex gap-2">
          <Button disabled={!!pending} onClick={() => newSession(checkout)}>
            <PlusIcon /> New chat
          </Button>
          <Button variant="outline" onClick={() => newTask(view.project.id)}>
            New task
          </Button>
        </div>
      </Empty>
    ) : (
      <Empty title="Not running">
        <p className={muted}>
          {own ? "Start this worktree's container" : "Start the container"} to
          see this checkout&apos;s conversations.
        </p>
        {!own && <StartStopButton view={view} />}
      </Empty>
    );
  }

  const shown = all.filter((t) => matches(query, t.title));
  const chats = allChats.filter((c) => matches(query, c.title));
  const attention = shown.filter((t) => t.attention);
  const rest = shown.filter((t) => !t.attention);
  return (
    <div className="flex flex-col gap-5">
      {all.length + allChats.length > FILTER_FROM && (
        <Input
          className="w-72 max-md:w-full"
          placeholder="Filter conversations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <Group title="Needs you" tasks={attention} tone="attention" />
      <ChatGroup chats={chats} />
      <Group title="Tasks" tasks={rest} />
      {shown.length === 0 && chats.length === 0 && (
        <p className={muted}>No conversations match.</p>
      )}
    </div>
  );
};

const ChatGroup = (props: { chats: ChatView[] }) => {
  const view = useProjectView();
  if (props.chats.length === 0) {
    return null;
  }
  return (
    <section>
      <GroupTitle>
        Chats{" "}
        <span className="text-muted-foreground ml-1 font-medium">
          {props.chats.length}
        </span>
      </GroupTitle>
      <Card className="overflow-hidden py-0">
        <ul>
          {props.chats.map((c) => (
            <ChatRow key={c.id} projectId={view.project.id} chat={c} />
          ))}
        </ul>
      </Card>
    </section>
  );
};

const Group = (props: {
  title: string;
  tasks: ProjectTask[];
  tone?: "attention";
}) => {
  const view = useProjectView();
  if (props.tasks.length === 0) {
    return null;
  }
  const attention = props.tone === "attention";
  return (
    <section>
      <GroupTitle className={cn(attention && "text-attention")}>
        {props.title}{" "}
        <span className="text-muted-foreground ml-1 font-medium">
          {props.tasks.length}
        </span>
      </GroupTitle>
      <Card
        className={cn(
          "overflow-hidden py-0",
          attention && "border-attention/45"
        )}
      >
        <ul>
          {props.tasks.map((t) => (
            <TaskRow key={t.task} projectId={view.project.id} task={t} />
          ))}
        </ul>
      </Card>
    </section>
  );
};

/** The checkout's container at work: its controls, its forwarded ports beside its log, then its saved permissions. */
export const CheckoutRuntime = ({
  sidebar = false,
}: { sidebar?: boolean } = {}) => (
  // Split by the width it gets, not the window's: the task page gives it a narrower column than a worktree page.
  <div className="@container flex flex-col gap-8">
    <RuntimeControls />
    <div
      className={cn("grid items-start gap-8", !sidebar && "@4xl:grid-cols-2")}
    >
      <CheckoutPorts />
      <RuntimeLogs />
    </div>
    <SavedPermissions />
  </div>
);

const CheckoutPorts = () => {
  const { view, checkout } = useCheckoutContext();
  const own = envOfDirectory(view, checkout.directory);
  const runtime = checkoutRuntime(view, checkout.directory);
  const ports = runtime.ports ?? [];
  const forwarded = ports.filter((p) => p.status === "forwarded").length;
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Forwarded ports</h2>
        {ports.length > 0 && (
          <p className={muted}>
            {own
              ? "This worktree runs in its own container; these ports are its own."
              : "Shared with the other checkouts in the project's container."}
            {runtime.relay === "active" &&
              " Relayed from inside the container, so apps bound to localhost there are reachable."}
          </p>
        )}
      </div>
      {runtime.relay === "unavailable" && ports.length > 0 && (
        <Note warn>
          No relay in the container: only apps listening on 0.0.0.0 are
          reachable. The log says why.
        </Note>
      )}
      {ports.length === 0 ? (
        <Empty title="No forwarded ports">
          <p className={muted}>
            Add <code className="font-mono">forwardPorts</code> to the
            project&apos;s devcontainer.json, or ports in its settings, to reach
            its apps from <code className="font-mono">localhost</code>.
          </p>
        </Empty>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y">
            {ports.map((p) => (
              <PortRow
                key={
                  p.status === "skipped"
                    ? `s-${p.entry}`
                    : `${p.status}-${p.containerPort}`
                }
                port={p}
              />
            ))}
          </ul>
          <p
            className={cn(
              "border-t px-4 py-3 text-sm",
              forwarded === ports.length ? "text-ok" : "text-muted-foreground"
            )}
          >
            {forwarded === ports.length
              ? `All ${forwarded} forwarded`
              : `${forwarded} of ${ports.length} forwarded`}
          </p>
        </Card>
      )}
      {runtime.hostPorts && runtime.hostPorts.length > 0 && (
        <HostPorts ports={runtime.hostPorts} />
      )}
    </section>
  );
};

/** Ports on this machine the container reaches at the same localhost port, from the project's settings. */
const HostPorts = ({ ports }: { ports: HostPortStatus[] }) => (
  <div className="flex flex-col gap-2">
    <div>
      <h3 className="font-semibold">Host ports</h3>
      <p className={muted}>
        Reachable inside the container at{" "}
        <code className="font-mono">localhost</code> on the same port, and
        answered by this machine.
      </p>
    </div>
    <ul className="flex flex-wrap gap-2">
      {ports.map((p) => {
        const ok = p.state === "forwarded";
        return (
          <li key={p.port}>
            <Tip
              label={
                ok
                  ? `localhost:${p.port} in the container reaches localhost:${p.port} here`
                  : `Unavailable: ${p.reason}`
              }
            >
              <Chip tabIndex={0} className="gap-1.5 font-mono">
                <StatusDot
                  tone={ok ? "ok" : "error"}
                  label={ok ? "Forwarded" : "Unavailable"}
                />
                {p.port}
              </Chip>
            </Tip>
          </li>
        );
      })}
    </ul>
  </div>
);

const PortRow = ({ port: p }: { port: ForwardedPort }) => {
  const row = "flex min-h-12 items-center gap-4 px-4 py-2 text-sm";
  if (p.status !== "forwarded") {
    const skipped = p.status === "skipped";
    return (
      <li className={cn(row, "text-muted-foreground")}>
        <StatusDot
          tone={skipped ? "off" : "error"}
          label={skipped ? "Skipped" : "Failed"}
        />
        <span className="w-14 font-mono">
          {skipped ? p.entry : p.containerPort}
        </span>
        <span className="min-w-0 flex-1 truncate" title={p.reason}>
          {skipped ? "Skipped" : "Failed"}: {p.reason}
        </span>
        {!skipped && p.label && <span>{p.label}</span>}
      </li>
    );
  }
  const url = `http://localhost:${p.hostPort}/`;
  const moved = p.hostPort !== p.containerPort;
  return (
    <li className={row}>
      <StatusDot tone="ok" label="Forwarded" />
      <span className="w-14 font-mono">{p.containerPort}</span>
      <a
        className="text-primary inline-flex min-w-0 items-center gap-1 font-mono hover:underline"
        href={url}
        target="_blank"
        rel="noreferrer"
      >
        localhost:{p.hostPort} <ExternalLinkIcon className="size-3" />
      </a>
      {moved && (
        <span className="text-muted-foreground truncate text-xs">
          ({p.containerPort} was taken here)
        </span>
      )}
      <span className="text-muted-foreground ml-auto truncate">{p.label}</span>
      <CopyButton text={url} label="Copy URL" />
    </li>
  );
};
