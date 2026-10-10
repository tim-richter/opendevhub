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
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { ForwardedPort, ProjectView } from "../../../shared/types";
import { refreshWorktrees } from "../../api";
import { CopyButton } from "../../components/copy-button";
import { EnvBadge } from "../../components/env-badge";
import {
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
import { useDash } from "../../dashboard-context";
import {
  compareSessions,
  envOfDirectory,
  matches,
  needsAttention,
  sshAgentBadge,
} from "../../derive";
import type { SessionEntry } from "../../derive";
import { checkoutResources } from "../../lib/resources";
import { Link, useNavigate, useSearchParams } from "../../routing";
import { PublishedPr } from "../forgejo/published-pr";
import { projectFlags, StartStopButton } from "../projects/project-actions";
import { useProjectView } from "../projects/project-layout";
import { SessionList } from "../sessions/session-list";
import {
  checkoutCounts,
  checkoutPath,
  checkoutRuntime,
  checkouts,
  checkoutTone,
} from "./checkouts";
import type { Checkout } from "./checkouts";
import { LogPanel } from "./log-panel";
import { OpenInMenu } from "./open-in-menu";
import { WorktreeCreator } from "./worktree-creator";
import {
  checkoutReady,
  ContainerMenu,
  UnmountedNotice,
  useCheckoutActions,
} from "./worktrees";

const IDLE_LIMIT = 8;

export interface CheckoutContext {
  view: ProjectView;
  checkout: Checkout;
}

const CheckoutCtx = createContext<CheckoutContext | undefined>(undefined);

export const useCheckout = (): CheckoutContext => {
  const value = useContext(CheckoutCtx);
  if (!value) {
    throw new Error("useCheckout must be used inside CheckoutPage");
  }
  return value;
};

/** One checkout (the main one or a worktree) and its tabs. */
export const CheckoutPage = () => {
  const view = useProjectView();
  const { worktree = "" } = useParams({ strict: false });
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
  const onSession = pathname.startsWith(`${base}/s/`);
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
      <nav
        aria-label="Breadcrumb"
        className="text-muted-foreground -mb-4 flex items-center gap-1 text-sm"
      >
        <Link
          to={projectPath}
          className="hover:text-foreground hover:underline"
        >
          {view.project.name}
        </Link>
        <ChevronRightIcon className="size-3.5" />
      </nav>
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
            {checkoutReady(view, checkout) ? (
              <Button
                variant="outline"
                disabled={!!pending}
                onClick={() => newSession(checkout)}
              >
                <PlusIcon /> New session
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
        <TabLink to={base} end active={onSession}>
          <MessagesSquareIcon className="size-4" /> Sessions{" "}
          <Count n={n.attention} tone="attention" />
          {n.attention === 0 && <Count n={n.running + n.idle} tone="muted" />}
        </TabLink>
        <TabLink to={`${base}/review`}>
          <GitCompareIcon className="size-4" /> Review
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

      <CheckoutCtx value={{ checkout, view }}>
        <Outlet />
      </CheckoutCtx>
    </>
  );
};

export const CheckoutSessions = () => {
  const { view, checkout } = useCheckout();
  const { newTask } = useDash();
  const [params] = useSearchParams();
  const highlight = params.get("session") ?? undefined;
  const [query, setQuery] = useState("");
  const [showAllIdle, setShowAllIdle] = useState(false);
  const canOpen = checkoutReady(view, checkout);
  const own = envOfDirectory(view, checkout.directory);
  const { pending, newSession } = useCheckoutActions(view);

  const mine = useMemo(
    () => view.sessions.filter((s) => s.directory === checkout.directory),
    [view.sessions, checkout.directory]
  );
  const entries = useMemo<SessionEntry[]>(
    () =>
      [...mine]
        .toSorted(compareSessions)
        .filter((s) => matches(query, s.title))
        .map((session) => ({ session, view })),
    [mine, view, query]
  );

  useEffect(() => {
    if (!highlight) {
      return;
    }
    document
      .getElementById(`session-${highlight}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    document
      .querySelector<HTMLElement>(
        `#pending-${CSS.escape(highlight)} [data-pending-card]`
      )
      ?.focus({ preventScroll: true });
  }, [highlight]);

  if (mine.length === 0) {
    return canOpen ? (
      <Empty title="No sessions here yet">
        <p className={muted}>
          Start a session in this checkout, or a task for the project.
        </p>
        <div className="flex gap-2">
          <Button disabled={!!pending} onClick={() => newSession(checkout)}>
            <PlusIcon /> New session
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
          see this checkout&apos;s opencode sessions.
        </p>
        {!own && <StartStopButton view={view} />}
      </Empty>
    );
  }

  const attention = entries.filter((e) => needsAttention(e.session.status));
  const active = entries.filter((e) => e.session.status === "running");
  const idle = entries.filter((e) => e.session.status === "idle");
  // Never hide the highlighted session behind "show more".
  const highlightIdx = idle.findIndex((e) => e.session.id === highlight);
  const idleShown =
    showAllIdle || highlightIdx >= IDLE_LIMIT
      ? idle
      : idle.slice(0, IDLE_LIMIT);

  return (
    <div className="flex flex-col gap-5">
      {mine.length > IDLE_LIMIT && (
        <Input
          className="w-72 max-md:w-full"
          placeholder="Filter sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <Group
        title="Needs you"
        entries={attention}
        highlight={highlight}
        tone="attention"
      />
      <Group title="Working" entries={active} highlight={highlight} />
      <Group
        title="Idle"
        entries={idleShown}
        highlight={highlight}
        total={idle.length}
      />
      {idleShown.length < idle.length && (
        <Button
          variant="link"
          className="self-start px-0"
          onClick={() => setShowAllIdle(true)}
        >
          Show {idle.length - idleShown.length} more idle sessions
        </Button>
      )}
      {entries.length === 0 && <p className={muted}>No sessions match.</p>}
    </div>
  );
};

const Group = (props: {
  title: string;
  entries: SessionEntry[];
  highlight?: string;
  total?: number;
  tone?: "attention";
}) => {
  if (props.entries.length === 0) {
    return null;
  }
  const attention = props.tone === "attention";
  return (
    <section>
      <GroupTitle className={cn(attention && "text-attention")}>
        {props.title}{" "}
        <span className="text-muted-foreground ml-1 font-medium">
          {props.total ?? props.entries.length}
        </span>
      </GroupTitle>
      <Card
        className={cn(
          "overflow-hidden py-0",
          attention && "border-attention/45"
        )}
      >
        <SessionList
          entries={props.entries}
          highlight={props.highlight}
          hideWorktree
        />
      </Card>
    </section>
  );
};

/** The checkout's container at work: its forwarded ports beside its log. */
export const CheckoutRuntime = () => (
  <div className="grid items-start gap-8 lg:grid-cols-2">
    <CheckoutPorts />
    <CheckoutLogs />
  </div>
);

const CheckoutPorts = () => {
  const { view, checkout } = useCheckout();
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
            project&apos;s devcontainer.json to reach its apps from{" "}
            <code className="font-mono">localhost</code>.
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
    </section>
  );
};

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

const CheckoutLogs = () => {
  const { view, checkout } = useCheckout();
  const own = envOfDirectory(view, checkout.directory);
  const { logs, loadLogs } = useDash();
  const { id } = view.project;
  useEffect(() => loadLogs(id), [id, loadLogs]);
  return (
    <LogPanel
      lines={logs[id] ?? []}
      hint={
        own ? (
          <>
            The project&apos;s log; lines from this worktree&apos;s own
            container start with{" "}
            <code className="font-mono">[{own.worktree.branch}]</code>.
          </>
        ) : undefined
      }
    />
  );
};
