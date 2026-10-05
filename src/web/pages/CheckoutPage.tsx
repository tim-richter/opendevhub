import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import type { ForwardedPort, ProjectView } from "../../shared/types";
import { refreshWorktrees } from "../api";
import { CopyButton } from "../components/CopyButton";
import { ChevronRightIcon, ExternalLinkIcon, GitBranchIcon, KeyRoundIcon, PlayIcon, PlusIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Empty, GroupTitle, muted, Note, PageHeader, TabBar, TabLink } from "../components/Page";
import { LogPanel } from "../components/LogPanel";
import { OpenInMenu } from "../components/OpenInMenu";
import { projectFlags, StartStopButton } from "../components/ProjectActions";
import { SessionList } from "../components/SessionList";
import { Count, StatusDot } from "../components/Status";
import { EnvBadge } from "../components/EnvBadge";
import { checkoutReady, ContainerMenu, useCheckoutActions } from "../components/Worktrees";
import { type Checkout, checkoutCounts, checkoutPath, checkoutRuntime, checkouts, checkoutTone } from "../checkouts";
import { useDash } from "../DashboardContext";
import { compareSessions, envOfDirectory, matches, needsAttention, type SessionEntry, sshAgentBadge } from "../derive";
import { useProjectView } from "./ProjectLayout";

const IDLE_LIMIT = 8;

export interface CheckoutContext {
  view: ProjectView;
  checkout: Checkout;
}

export const useCheckout = () => useOutletContext<CheckoutContext>();

/** One checkout (the main one or a worktree) and its tabs. */
export function CheckoutPage() {
  const view = useProjectView();
  const { worktree = "" } = useParams();
  const navigate = useNavigate();
  const { running } = projectFlags(view, false);
  const { pending, newSession, remove, containerAction } = useCheckoutActions(view);
  const checkout = checkouts(view).find((c) => c.target === worktree);
  const projectPath = `/p/${encodeURIComponent(view.project.id)}`;

  // A worktree made a moment ago (or outside opendevhub) may not be listed yet.
  useEffect(() => {
    if (!checkout && running) void refreshWorktrees(view.project.id).catch(() => {});
  }, [checkout, running, view.project.id]);

  if (!checkout) {
    return (
      <Empty title="Unknown worktree">
        <p className={muted}>{view.project.name} has no worktree named {worktree}.</p>
        <Button asChild variant="link">
          <Link to={projectPath}>Back to {view.project.name}</Link>
        </Button>
      </Empty>
    );
  }

  const base = checkoutPath(view.project.id, checkout.target);
  const n = checkoutCounts(view, checkout.directory);
  const env = envOfDirectory(view, checkout.directory);
  const agent = sshAgentBadge(checkoutRuntime(view, checkout.directory));

  return (
    <>
      <nav aria-label="Breadcrumb" className="-mb-4 flex items-center gap-1 text-sm text-muted-foreground">
        <Link to={projectPath} className="hover:text-foreground hover:underline">
          {view.project.name}
        </Link>
        <ChevronRightIcon className="size-3.5" />
      </nav>
      <PageHeader
        title={
          <>
            <StatusDot tone={checkoutTone(view, checkout.directory)} />
            {checkout.worktree && <GitBranchIcon className="size-5 text-muted-foreground" />}
            <span className="truncate">{checkout.label}</span>
          </>
        }
        description={
          <p className="flex min-w-0 items-center gap-1 font-mono text-xs">
            {checkout.hostPath ? (
              <>
                <span className="truncate">{checkout.hostPath}</span> <CopyButton text={checkout.hostPath} label="Copy path" />
              </>
            ) : (
              <span className="truncate">only in container ({checkout.directory})</span>
            )}
            {env && <EnvBadge env={env} />}
            {agent && (
              <Badge
                variant="outline"
                className={cn("gap-1 font-normal", agent.warn ? "text-warn" : "text-muted-foreground")}
                title={agent.title}
              >
                <KeyRoundIcon className="size-3" /> {agent.label}
              </Badge>
            )}
          </p>
        }
        actions={
          <>
            {checkoutReady(view, checkout) ? (
              <Button variant="outline" disabled={!!pending} onClick={() => newSession(checkout)}>
                <PlusIcon /> New session
              </Button>
            ) : env && running ? (
              <Button
                variant="outline"
                disabled={!!pending || env.runtime.containerState === "starting" || env.runtime.containerState === "stopping"}
                onClick={() => containerAction(env, "start")}
              >
                <PlayIcon className="size-3" /> {env.runtime.containerState === "starting" ? "Starting…" : "Start container"}
              </Button>
            ) : (
              <StartStopButton view={view} />
            )}
            <OpenInMenu view={view} directory={checkout.directory} hostPath={checkout.hostPath} />
            <ContainerMenu view={view} checkout={checkout} />
            {checkout.worktree && (
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground"
                aria-label={`Remove worktree ${checkout.label}`}
                title="Remove worktree"
                disabled={!running || !!pending}
                onClick={() => remove(checkout, () => void navigate(projectPath))}
              >
                <XIcon />
              </Button>
            )}
          </>
        }
      />

      <TabBar label="Worktree">
        <TabLink to={base} end>
          Sessions <Count n={n.attention} tone="attention" />
          {n.attention === 0 && <Count n={n.running + n.idle} tone="muted" />}
        </TabLink>
        <TabLink to={`${base}/review`}>Review</TabLink>
        <TabLink to={`${base}/ports`}>
          Ports <Count n={checkoutRuntime(view, checkout.directory).ports?.length ?? 0} tone="muted" />
        </TabLink>
        <TabLink to={`${base}/logs`}>Logs</TabLink>
      </TabBar>

      <Outlet context={{ view, checkout } satisfies CheckoutContext} />
    </>
  );
}

export function CheckoutSessions() {
  const { view, checkout } = useCheckout();
  const { newTask } = useDash();
  const [params] = useSearchParams();
  const highlight = params.get("session") ?? undefined;
  const [query, setQuery] = useState("");
  const [showAllIdle, setShowAllIdle] = useState(false);
  const canOpen = checkoutReady(view, checkout);
  const own = envOfDirectory(view, checkout.directory);
  const { pending, newSession } = useCheckoutActions(view);

  const mine = useMemo(() => view.sessions.filter((s) => s.directory === checkout.directory), [view.sessions, checkout.directory]);
  const entries = useMemo<SessionEntry[]>(
    () =>
      [...mine]
        .sort(compareSessions)
        .filter((s) => matches(query, s.title))
        .map((session) => ({ session, view })),
    [mine, view, query],
  );

  useEffect(() => {
    if (!highlight) return;
    document.getElementById(`session-${highlight}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    document.querySelector<HTMLElement>(`#pending-${CSS.escape(highlight)} [data-pending-card]`)?.focus({ preventScroll: true });
  }, [highlight]);

  if (mine.length === 0) {
    return canOpen ? (
      <Empty title="No sessions here yet">
        <p className={muted}>Start a session in this checkout, or a task for the project.</p>
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
          {own ? "Start this worktree's container" : "Start the container"} to see this checkout's opencode sessions.
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
  const idleShown = showAllIdle || highlightIdx >= IDLE_LIMIT ? idle : idle.slice(0, IDLE_LIMIT);

  return (
    <div className="flex flex-col gap-5">
      {mine.length > IDLE_LIMIT && (
        <Input className="w-72 max-md:w-full" placeholder="Filter sessions…" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <Group title="Needs you" entries={attention} highlight={highlight} tone="attention" />
      <Group title="Working" entries={active} highlight={highlight} />
      <Group title="Idle" entries={idleShown} highlight={highlight} total={idle.length} />
      {idleShown.length < idle.length && (
        <Button variant="link" className="self-start px-0" onClick={() => setShowAllIdle(true)}>
          Show {idle.length - idleShown.length} more idle sessions
        </Button>
      )}
      {entries.length === 0 && <p className={muted}>No sessions match.</p>}
    </div>
  );
}

function Group(props: { title: string; entries: SessionEntry[]; highlight?: string; total?: number; tone?: "attention" }) {
  if (props.entries.length === 0) return null;
  const attention = props.tone === "attention";
  return (
    <section>
      <GroupTitle className={cn(attention && "text-attention")}>
        {props.title} <span className="ml-1 font-medium text-muted-foreground">{props.total ?? props.entries.length}</span>
      </GroupTitle>
      <Card className={cn("overflow-hidden py-0", attention && "border-attention/45")}>
        <SessionList entries={props.entries} highlight={props.highlight} hideWorktree />
      </Card>
    </section>
  );
}

/** Checkouts without their own container share the project's. */
function SharedNote() {
  return <Note>This checkout runs in the project's container, so these are shared with the other checkouts that do.</Note>;
}

export function CheckoutPorts() {
  const { view, checkout } = useCheckout();
  const own = envOfDirectory(view, checkout.directory);
  const runtime = checkoutRuntime(view, checkout.directory);
  const ports = runtime.ports ?? [];
  if (ports.length === 0) {
    return (
      <Empty title="No forwarded ports">
        <p className={muted}>
          Add <code className="font-mono">forwardPorts</code> to the project's devcontainer.json to reach its apps from{" "}
          <code className="font-mono">localhost</code>.
        </p>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {own ? <Note>This worktree runs in its own container; these ports are its own.</Note> : <SharedNote />}
      {runtime.relay && (
        <Note warn={runtime.relay === "unavailable"}>
          {runtime.relay === "active"
            ? "Connections go through a relay inside the container, so apps bound to localhost there are reachable."
            : "No relay in the container: only apps listening on 0.0.0.0 are reachable. See the Logs tab for why."}
        </Note>
      )}
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Name</TableHead>
              <TableHead>Container</TableHead>
              <TableHead>Local</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ports.map((p) => (
              <PortRow key={p.status === "skipped" ? `s-${p.entry}` : `${p.status}-${p.containerPort}`} port={p} />
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function PortRow({ port: p }: { port: ForwardedPort }) {
  if (p.status === "skipped") {
    return (
      <TableRow className="text-muted-foreground">
        <TableCell className="px-4">—</TableCell>
        <TableCell className="font-mono">{p.entry}</TableCell>
        <TableCell>—</TableCell>
        <TableCell title={p.reason}>
          <Badge variant="secondary" className="bg-muted text-muted-foreground">Skipped</Badge> {p.reason}
        </TableCell>
      </TableRow>
    );
  }
  if (p.status === "failed") {
    return (
      <TableRow className="text-muted-foreground">
        <TableCell className="px-4">{p.label ?? "—"}</TableCell>
        <TableCell className="font-mono">{p.containerPort}</TableCell>
        <TableCell>—</TableCell>
        <TableCell>
          <Badge variant="secondary" className="bg-destructive/15 text-destructive">
            Failed
          </Badge>{" "}
          {p.reason}
        </TableCell>
      </TableRow>
    );
  }
  const url = `http://localhost:${p.hostPort}/`;
  const moved = p.hostPort !== p.containerPort;
  return (
    <TableRow>
      <TableCell className="px-4">{p.label ?? "—"}</TableCell>
      <TableCell className="font-mono">{p.containerPort}</TableCell>
      <TableCell className="font-mono">
        <span className="inline-flex items-center gap-1">
          <a className="inline-flex items-center gap-1 hover:underline" href={url} target="_blank" rel="noreferrer">
            localhost:{p.hostPort} <ExternalLinkIcon className="size-3" />
          </a>
          <CopyButton text={url} label="Copy URL" />
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="bg-ok/15 text-ok">
          Forwarded
        </Badge>
        {moved && (
          <span className="text-muted-foreground" title={`Port ${p.containerPort} was taken on this machine`}>
            {" "}
            · moved
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

export function CheckoutLogs() {
  const { view, checkout } = useCheckout();
  const own = envOfDirectory(view, checkout.directory);
  const { logs, loadLogs } = useDash();
  const id = view.project.id;
  useEffect(() => loadLogs(id), [id, loadLogs]);
  return (
    <div className="flex flex-col gap-5">
      {own ? (
        <Note>
          This is the project's log. Lines from this worktree's own container start with <code className="font-mono">[{own.worktree.branch}]</code>.
        </Note>
      ) : (
        <SharedNote />
      )}
      <LogPanel lines={logs[id] ?? []} />
    </div>
  );
}
