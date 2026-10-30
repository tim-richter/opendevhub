import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@opendevhub/ui/collapsible";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@opendevhub/ui/message-scroller";
import { Skeleton } from "@opendevhub/ui/skeleton";
import { ChevronRightIcon, ExternalLinkIcon, HistoryIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { modelShortName } from "../../../shared/tasks";
import type {
  ComposerSendRequest,
  ComposerSendResult,
  ProjectView,
  SessionDetail,
  SessionRevert,
  SessionSummary,
} from "../../../shared/types";
import { sessionLink } from "../../../shared/urls";
import { Chip } from "../../components/page";
import { SessionBadge } from "../../components/status";
import { Tip } from "../../components/tip";
import { needsAttention, openUrlOf, sessionHref } from "../../derive";
import { Link } from "../../routing";
import { CheckoutProvider } from "../checkouts/checkout-context";
import { CheckoutRuntime } from "../checkouts/checkout-page";
import type { Checkout } from "../checkouts/checkouts";
import { ProjectReview } from "../review/project-review";
import { taskChip } from "../tasks/tasks";
import { BackgroundShells, ShellsChip } from "./background-shells";
import { Composer } from "./composer";
import { PendingStack } from "./pending-cards";
import {
  AgentStatusBadge,
  ConversationSidebar,
  SubagentsPanel,
  TurnsPanel,
  useSidePanel,
} from "./side-panel";
import type { OpenPanel, PanelId } from "./side-panel";
import { Transcript } from "./transcript";
import { UsagePopover } from "./usage-popover";

/** The transcript's and the composer's width: as wide as reads well. */
const COLUMN = "w-full max-w-4xl";

/** A transcript item's width, centred in the scroller. */
const column = cn("mx-auto", COLUMN);

/** How long a send's notice stays under the transcript. */
const NOTICE_MS = 5000;

const CheckoutTerminal = lazy(() =>
  import("../checkouts/checkout-terminal").then((module) => ({
    default: module.CheckoutTerminal,
  }))
);

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What a restored checkpoint rewound, above the composer: how many messages are hidden, the files changed back, and
 * a Redo that brings both back until the next message makes the restore permanent.
 */
export const RevertBar = ({
  revert,
  running,
  onRedo,
}: {
  revert: SessionRevert;
  running: boolean;
  onRedo: () => void;
}) => (
  <section
    aria-label="Restored checkpoint"
    className="bg-muted/40 flex flex-col gap-1.5 rounded-md border px-3 py-2 text-xs"
  >
    <div className="flex items-center gap-2">
      <HistoryIcon
        className="text-muted-foreground size-3.5 shrink-0"
        aria-hidden
      />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Checkpoint restored</span>
        <span className="text-muted-foreground">
          {" "}
          · {plural(revert.hidden, "message")} hidden. Sending a message makes
          this permanent.
        </span>
      </p>
      <Tip
        label={
          running
            ? "Wait for the agent to stop before redoing"
            : "Bring back the hidden messages and the files as they were"
        }
      >
        {/* A disabled button gets no pointer events; the span carries the tooltip. */}
        <span tabIndex={running ? 0 : undefined} className="shrink-0">
          <Button
            size="xs"
            variant="outline"
            disabled={running}
            onClick={onRedo}
          >
            Redo
          </Button>
        </span>
      </Tip>
    </div>
    {revert.files.length === 0 ? (
      <p className="text-muted-foreground pl-5.5">No files changed back.</p>
    ) : (
      <Collapsible className="pl-5.5">
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
          {plural(revert.files.length, "file")} changed back
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto font-mono">
            {revert.files.map((f) => (
              <li key={f.path} className="flex min-w-0 gap-2">
                <span className="truncate" title={f.path}>
                  {f.path}
                </span>
                {f.additions !== undefined && (
                  <span className="text-ok shrink-0">+{f.additions}</span>
                )}
                {f.deletions !== undefined && (
                  <span className="text-destructive shrink-0">
                    −{f.deletions}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    )}
  </section>
);

/**
 * One conversation, filling the height it is given: a one-line header, the transcript scrolling under it, the
 * pending cards and the composer pinned to the bottom, and a right sidebar of panels. `chips` and `actions` add to
 * the header, e.g. the Chat view's project and its link to the task; `changes` adds the checkout's Changes panel.
 */
export const Conversation = (props: {
  view: ProjectView;
  checkout: Checkout;
  session: SessionSummary;
  detail?: SessionDetail;
  error?: string;
  /** Adds a chip linking to the task the conversation belongs to. */
  showTask?: boolean;
  /** Offers the checkout's changes in a side panel, for a conversation whose page has no Changes of its own. */
  changes?: boolean;
  /** Offers the checkout's terminal in a side panel. */
  terminal?: boolean;
  /** Offers the checkout runtime in a side panel. */
  runtime?: boolean;
  initialPanel?: PanelId;
  /** Names whom the composer writes to. */
  composerLabel?: string;
  chips?: ReactNode;
  actions?: ReactNode;
  onSend: (
    message: ComposerSendRequest
  ) => Promise<ComposerSendResult | undefined>;
  /** Rewinds the conversation and its files to before a user message. */
  onRestore: (messageId: string) => Promise<void>;
  /** Clears a restored checkpoint, bringing back what it hid. */
  onRedo: () => Promise<void>;
}) => {
  const { view, checkout, session, detail } = props;
  const projectId = view.project.id;
  const { panel, toggle, close } = useSidePanel(props.initialPanel);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const showNotice = (text: string) => setNotice({ text });
  const [fill, setFill] = useState<{ text: string; key: number }>();
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const title = session.title || "Untitled conversation";
  const task = props.showTask ? taskChip(view, session) : undefined;
  const running = session.status !== "idle";
  const failed = (error: unknown) =>
    setNotice({
      error: true,
      text: error instanceof Error ? error.message : String(error),
    });
  const restore = async (messageId: string) => {
    const restored = detail?.transcript.find((m) => m.id === messageId);
    try {
      await props.onRestore(messageId);
    } catch (error) {
      failed(error);
      return;
    }
    if (restored?.role === "user") {
      setFill((last) => ({ key: (last?.key ?? 0) + 1, text: restored.text }));
    }
  };
  const redo = async () => {
    try {
      await props.onRedo();
    } catch (error) {
      failed(error);
    }
  };
  const openHref = sessionHref(view, session);
  const statusByAgent = new Map(
    session.subagents?.map((agent) => [agent.id, agent.status])
  );
  const agents = (detail?.subagents ?? session.subagents ?? [])
    .map((agent) => ({
      ...agent,
      status: statusByAgent.get(agent.id) ?? "idle",
    }))
    .toSorted((a, b) => {
      const active = Number(b.status !== "idle") - Number(a.status !== "idle");
      return active || b.updatedAt - a.updatedAt;
    });
  const subagents = agents.length;
  const panels: PanelId[] = [
    "turns",
    ...(props.changes ? (["changes"] as const) : []),
    "subagents",
    ...(props.terminal ? (["terminal"] as const) : []),
    ...(props.runtime ? (["runtime"] as const) : []),
  ];
  // A remembered panel this conversation doesn't offer stays shut.
  const shown = panel && panels.includes(panel) ? panel : undefined;
  let open: OpenPanel | undefined;
  if (shown === "changes") {
    open = {
      children: (
        <CheckoutProvider value={{ checkout, sessionId: session.id, view }}>
          <ProjectReview />
        </CheckoutProvider>
      ),
      hint: checkout.worktree
        ? "Commits against the base, and what isn't committed"
        : "What isn't committed",
      id: shown,
    };
  } else if (shown === "runtime") {
    open = {
      children: (
        <CheckoutProvider value={{ checkout, sessionId: session.id, view }}>
          <CheckoutRuntime sidebar />
        </CheckoutProvider>
      ),
      hint: checkout.worktree?.branch ?? checkout.label,
      id: shown,
    };
  } else if (shown === "terminal") {
    open = {
      children: (
        <CheckoutProvider value={{ checkout, sessionId: session.id, view }}>
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <CheckoutTerminal fill />
          </Suspense>
        </CheckoutProvider>
      ),
      hint: checkout.worktree?.branch ?? checkout.label,
      id: shown,
    };
  } else if (shown === "turns" && detail) {
    open = {
      children: (
        <TurnsPanel
          detail={detail}
          session={session}
          projectId={projectId}
          checkout={checkout}
          onSent={showNotice}
        />
      ),
      hint: `${detail.turns.length}${detail.more ? "+" : ""}, newest first`,
      id: shown,
    };
  } else if (shown === "subagents" && detail) {
    open = {
      children: (
        <SubagentsPanel detail={detail} view={view} session={session} />
      ),
      hint: subagents,
      id: shown,
    };
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-w-0 items-center gap-2 border-b pb-2">
          <h2
            className="min-w-16 truncate text-base font-semibold"
            title={title}
          >
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            <SessionBadge status={session.status} />
            <ShellsChip session={session} />
          </div>
          <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 overflow-hidden text-xs max-md:hidden">
            {session.model && <Chip>{modelShortName(session.model)}</Chip>}
            {task &&
              (task.to ? (
                <Chip
                  asChild
                  className="text-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <Link to={task.to} title={task.title}>
                    {task.label}
                  </Link>
                </Chip>
              ) : (
                <Chip className="text-foreground" title={task.title}>
                  {task.label}
                </Chip>
              ))}
            {props.chips}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <UsagePopover session={session} detail={detail} />
            <Tip label="Open in opencode">
              <Button asChild variant="ghost" size="icon" className="size-8">
                <a
                  href={openHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open in opencode"
                >
                  <ExternalLinkIcon />
                </a>
              </Button>
            </Tip>
            {props.actions}
          </div>
        </header>

        {agents.length > 0 && (
          <section
            aria-label="Agents in this conversation"
            className="flex shrink-0 items-center gap-2 border-b py-2 text-xs"
          >
            <span className="text-muted-foreground shrink-0 font-medium">
              Agents ({agents.length})
            </span>
            <ul className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
              {agents.slice(0, 4).map((agent) => (
                <li key={agent.id} className="shrink-0">
                  <a
                    className="hover:bg-muted inline-flex max-w-52 items-center gap-1.5 rounded-md border px-2 py-1"
                    href={sessionLink(openUrlOf(view, session.envId), agent.id)}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={agent.title}
                  >
                    <span className="truncate">{agent.title}</span>
                    <AgentStatusBadge
                      status={agent.status}
                      outcome={agent.outcome}
                    />
                  </a>
                </li>
              ))}
            </ul>
            {agents.length > 4 && (
              <button
                type="button"
                className="shrink-0 font-medium hover:underline"
                onClick={() => toggle("subagents")}
              >
                View all
              </button>
            )}
          </section>
        )}

        <BackgroundShells session={session} />

        <div className="min-h-48 flex-1">
          {/* Keyed so another conversation opens at its own end. */}
          <MessageScrollerProvider key={session.id} autoScroll>
            <MessageScroller>
              <MessageScrollerViewport aria-label="Conversation transcript">
                <MessageScrollerContent className="px-1 py-5">
                  {props.error && (
                    <MessageScrollerItem>
                      <Alert variant="destructive" className={column}>
                        <AlertDescription>{props.error}</AlertDescription>
                      </Alert>
                    </MessageScrollerItem>
                  )}
                  {!detail && !props.error && (
                    <MessageScrollerItem>
                      <div className={cn("flex flex-col gap-3", column)}>
                        <Skeleton className="h-10 w-1/2 self-end" />
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-4 w-2/3" />
                      </div>
                    </MessageScrollerItem>
                  )}
                  {detail && (
                    <Transcript
                      transcript={detail.transcript}
                      more={detail.more}
                      openHref={openHref}
                      working={running && !needsAttention(session.status)}
                      onRestore={(messageId) => void restore(messageId)}
                      restoreDisabled={running}
                      className={column}
                    />
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton className="dark:bg-background dark:hover:bg-muted shadow-md" />
            </MessageScroller>
          </MessageScrollerProvider>
        </div>

        <footer
          className={cn("mx-auto flex shrink-0 flex-col gap-3 pt-2", COLUMN)}
        >
          {session.pending && (
            <div className="max-h-[45svh] overflow-y-auto">
              <PendingStack session={session} view={view} />
            </div>
          )}
          {detail?.revert && (
            <RevertBar
              revert={detail.revert}
              running={running}
              onRedo={() => void redo()}
            />
          )}
          {notice && (
            <p
              className={cn(
                "text-xs",
                notice.error ? "text-destructive" : "text-ok"
              )}
              role={notice.error ? "alert" : "status"}
            >
              {notice.text}
            </p>
          )}
          {props.composerLabel && (
            <p
              className="text-muted-foreground -mb-2 truncate px-1 font-mono text-xs"
              title={props.composerLabel}
            >
              {props.composerLabel}
            </p>
          )}
          <Composer
            view={view}
            directory={checkout.directory}
            checkoutLabel={checkout.worktree?.branch ?? checkout.label}
            running={running}
            model={session.model}
            agent={detail?.agent ?? detail?.turns[0]?.agent}
            hubCommands
            onSend={props.onSend}
            onSent={showNotice}
            fill={fill}
          />
        </footer>
      </div>

      <ConversationSidebar
        panels={panels}
        open={open}
        onToggle={toggle}
        onClose={close}
      />
    </div>
  );
};
