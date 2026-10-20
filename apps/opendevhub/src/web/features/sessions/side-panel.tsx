import { Button } from "@opendevhub/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@opendevhub/ui/sheet";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  ServerIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

import { modelShortName } from "../../../shared/tasks";
import type {
  ProjectView,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  SubagentSummary,
  SessionTurn,
} from "../../../shared/types";
import { sessionLink } from "../../../shared/urls";
import { Chip, muted } from "../../components/page";
import { SessionBadge } from "../../components/status";
import { Tip } from "../../components/tip";
import { When } from "../../components/when";
import { needsAttention, openUrlOf } from "../../derive";
import { useMediaQuery } from "../../hooks/use-media-query";
import { RightSidebar } from "../../shell/right-sidebar";
import type { ShortcutId } from "../../shell/shortcuts";
import { useShortcutLabel, useShortcut } from "../../shell/use-shortcut";
import type { Checkout } from "../checkouts/checkouts";
import { TurnChanges } from "../review/turn-changes";
import { formatCost, formatTokens } from "../tasks/tasks";
import { turnActivity, turnDuration } from "./session-detail";

export type PanelId =
  | "turns"
  | "changes"
  | "subagents"
  | "terminal"
  | "runtime";

const PANEL_KEY = "opendevhub.conversation.panel";
const PANEL_WIDTH_KEY = "opendevhub.conversation.panelWidth";
const PANEL_MIN_WIDTH = 240;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDE_WIDTH = 512;
const PANEL_DEFAULT_NARROW_WIDTH = 416;
const PANEL_MIN_MAIN_WIDTH = 320;
const PANEL_LEFT_SIDEBAR_FALLBACK = 256;
const PANEL_RAIL_WIDTH = 48;
const PANEL_RESIZE_STEP = 16;
const WIDE_QUERY = "(min-width: 1024px)";

const maxPanelWidth = (): number => {
  const leftSidebarWidth =
    document
      .querySelector<HTMLElement>('[data-slot="sidebar-gap"]')
      ?.getBoundingClientRect().width ?? PANEL_LEFT_SIDEBAR_FALLBACK;
  return Math.max(
    PANEL_DEFAULT_WIDE_WIDTH,
    Math.min(
      PANEL_MAX_WIDTH,
      window.innerWidth -
        PANEL_MIN_MAIN_WIDTH -
        leftSidebarWidth -
        PANEL_RAIL_WIDTH
    )
  );
};

const clampPanelWidth = (width: number): number =>
  Math.max(PANEL_MIN_WIDTH, Math.min(maxPanelWidth(), Math.round(width)));

const readPanelWidth = (): number | undefined => {
  try {
    const stored = localStorage.getItem(PANEL_WIDTH_KEY);
    if (stored === null) {
      return undefined;
    }
    const width = Number(stored);
    return Number.isFinite(width) && width >= PANEL_MIN_WIDTH
      ? clampPanelWidth(width)
      : undefined;
  } catch {
    return undefined;
  }
};

const isPanelId = (value: string | null): value is PanelId =>
  value === "turns" ||
  value === "changes" ||
  value === "subagents" ||
  value === "terminal" ||
  value === "runtime";

const readPanel = (): PanelId | undefined => {
  try {
    const stored = localStorage.getItem(PANEL_KEY);
    return isPanelId(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
};

const storePanel = (panel: PanelId | undefined): void => {
  try {
    if (panel) {
      localStorage.setItem(PANEL_KEY, panel);
    } else {
      localStorage.removeItem(PANEL_KEY);
    }
  } catch {
    // Not remembered; the next conversation opens with the panels closed.
  }
};

/** The open side panel, remembered on this browser; closed until the user opens one. */
export const useSidePanel = (initialPanel?: PanelId) => {
  const [panel, setPanel] = useState(() => initialPanel ?? readPanel());
  const show = (next: PanelId | undefined) => {
    setPanel(next);
    storePanel(next);
  };
  return {
    close: () => show(undefined),
    panel,
    toggle: (id: PanelId) => show(panel === id ? undefined : id),
  };
};

export const PANELS = {
  runtime: { icon: ServerIcon, label: "Runtime" },
  changes: { icon: FileDiffIcon, label: "Changes" },
  subagents: { icon: BotIcon, label: "Subagents" },
  terminal: { icon: TerminalIcon, label: "Terminal" },
  turns: { icon: ListTreeIcon, label: "Turns" },
} as const;

export const AgentStatusBadge = ({
  status,
  outcome,
}: {
  status: SessionStatus;
  outcome?: SubagentSummary["outcome"];
}) => {
  if (status !== "idle" || !outcome) {
    return <SessionBadge status={status} />;
  }
  const label = {
    succeeded: "Done",
    failed: "Failed",
    interrupted: "Cancelled",
  }[outcome];
  return <Chip>{label}</Chip>;
};

/** The open panel's content and the short note beside its title. */
export interface OpenPanel {
  id: PanelId;
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * The conversation's right sidebar, on the window's right edge: a rail of icon buttons, one per panel, and the open
 * panel beside it. On narrow screens the open panel is a sheet over the conversation instead.
 */
export const ConversationSidebar = (props: {
  /** The panels offered, in the rail's order. */
  panels: PanelId[];
  open?: OpenPanel;
  onToggle: (id: PanelId) => void;
  onClose: () => void;
}) => {
  const wide = useMediaQuery(WIDE_QUERY);
  const { open } = props;
  useShortcut("panelChanges", () => props.onToggle("changes"), {
    enabled: props.panels.includes("changes"),
  });
  useShortcut("panelTerminal", () => props.onToggle("terminal"), {
    enabled: props.panels.includes("terminal"),
  });
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizePanel = (width: number, persist = false) => {
    const nextWidth = clampPanelWidth(width);
    setPanelWidth(nextWidth);
    if (persist) {
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(nextWidth));
      } catch {
        // The panel remains resizable when storage is unavailable.
      }
    }
  };
  return (
    <RightSidebar>
      <Sidebar
        side="right"
        collapsible="none"
        className="sticky top-0 h-svh w-auto shrink-0 flex-row border-l"
      >
        {open && wide && (
          <PanelColumn
            panel={open}
            width={panelWidth}
            onResize={resizePanel}
            onClose={props.onClose}
          />
        )}
        <SidebarContent className="w-12 flex-none border-l first:border-l-0">
          <SidebarGroup className="px-2">
            <SidebarMenu aria-label="Side panels">
              {props.panels.map((id) => (
                <RailButton
                  key={id}
                  id={id}
                  active={open?.id === id}
                  onToggle={() => props.onToggle(id)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      {open && !wide && <PanelSheet panel={open} onClose={props.onClose} />}
    </RightSidebar>
  );
};

/** The shortcuts that show or hide a panel. */
const PANEL_SHORTCUTS: Partial<Record<PanelId, ShortcutId>> = {
  changes: "panelChanges",
  terminal: "panelTerminal",
};

/** One panel's button in the rail, its tooltip naming the panel's shortcut when it has one. */
const RailButton = (props: {
  id: PanelId;
  active: boolean;
  onToggle: () => void;
}) => {
  const { icon: Icon, label } = PANELS[props.id];
  const shortcut = PANEL_SHORTCUTS[props.id];
  const keys = useShortcutLabel(shortcut ?? "panelChanges");
  return (
    <SidebarMenuItem>
      <Tip label={shortcut && keys ? `${label} (${keys})` : label} side="left">
        <SidebarMenuButton
          className="size-8 justify-center p-0"
          aria-label={label}
          aria-pressed={props.active}
          isActive={props.active}
          onClick={props.onToggle}
        >
          <Icon />
        </SidebarMenuButton>
      </Tip>
    </SidebarMenuItem>
  );
};

/** The open panel as a column of the sidebar; Changes and Terminal get more room. */
const PanelColumn = (props: {
  panel: OpenPanel;
  width?: number;
  onResize: (width: number, persist?: boolean) => void;
  onClose: () => void;
}) => {
  const { id, hint, children } = props.panel;
  const { label } = PANELS[id];
  return (
    <aside
      aria-label={label}
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col",
        id === "changes" || id === "terminal"
          ? "w-[32rem] xl:w-[44vw]"
          : "w-[26rem] xl:w-[34vw]"
      )}
      style={props.width === undefined ? undefined : { width: props.width }}
    >
      <div
        role="separator"
        aria-label="Resize right sidebar"
        aria-orientation="vertical"
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={maxPanelWidth()}
        aria-valuenow={
          props.width ??
          (id === "changes" || id === "terminal"
            ? PANEL_DEFAULT_WIDE_WIDTH
            : PANEL_DEFAULT_NARROW_WIDTH)
        }
        aria-valuetext={props.width === undefined ? "Default width" : undefined}
        tabIndex={0}
        className="hover:after:bg-sidebar-border focus-visible:after:bg-sidebar-border absolute inset-y-0 left-0 z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none select-none after:absolute after:inset-y-0 after:left-1/2 after:w-px focus-visible:outline-none"
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            const right =
              event.currentTarget.parentElement?.getBoundingClientRect().right;
            if (right !== undefined) {
              props.onResize(right - event.clientX);
            }
          }
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            const right =
              event.currentTarget.parentElement?.getBoundingClientRect().right;
            if (right !== undefined) {
              props.onResize(right - event.clientX, true);
            }
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const width =
              props.width ??
              event.currentTarget.parentElement?.getBoundingClientRect()
                .width ??
              PANEL_MIN_WIDTH;
            props.onResize(
              width +
                (event.key === "ArrowLeft"
                  ? PANEL_RESIZE_STEP
                  : -PANEL_RESIZE_STEP),
              true
            );
          }
        }}
      />
      <SidebarHeader className="h-12 flex-row items-center gap-2 border-b py-0 pr-2 pl-4">
        <h3 className="text-sm font-semibold">{label}</h3>
        {hint && (
          <span className={cn(muted, "min-w-0 truncate text-xs")}>{hint}</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label={`Close ${label}`}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </SidebarHeader>
      <div
        className={cn(
          "bg-background min-h-0 flex-1 overflow-y-auto",
          (id === "changes" || id === "terminal" || id === "runtime") && "p-4"
        )}
      >
        {children}
      </div>
    </aside>
  );
};

const PanelSheet = (props: { panel: OpenPanel; onClose: () => void }) => {
  const { id, hint, children } = props.panel;
  const { label } = PANELS[id];
  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent
        className={cn(
          "w-full gap-0",
          id === "changes" || id === "terminal" ? "sm:max-w-4xl" : "sm:max-w-md"
        )}
      >
        <SheetHeader className="border-b">
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription className={hint ? undefined : "sr-only"}>
            {hint ?? label}
          </SheetDescription>
        </SheetHeader>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto",
            (id === "changes" || id === "terminal" || id === "runtime") && "p-4"
          )}
        >
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
};

/** The conversation's turns, newest first, each with its changes on demand. */
export const TurnsPanel = (props: {
  detail: SessionDetail;
  session: SessionSummary;
  projectId: string;
  checkout: Checkout;
  onSent: (notice: string) => void;
}) => {
  const { detail, session } = props;
  const running = session.status !== "idle";
  if (detail.turns.length === 0) {
    return (
      <p className={cn(muted, "px-4 py-3")}>
        No turns yet: the conversation hasn&apos;t been prompted.
      </p>
    );
  }
  return (
    <ol>
      {detail.turns.map((turn, i) => (
        <TurnItem
          key={turn.id}
          turn={turn}
          latest={i === 0}
          running={i === 0 && running}
          waiting={i === 0 && needsAttention(session.status)}
          projectId={props.projectId}
          checkout={props.checkout}
          sessionId={session.id}
          onSent={props.onSent}
        />
      ))}
    </ol>
  );
};

/** The conversation's subagents with their usage and a link to each in opencode. */
export const SubagentsPanel = (props: {
  detail: SessionDetail;
  view: ProjectView;
  session: SessionSummary;
}) => (
  <ul>
    {props.detail.subagents.length === 0 && (
      <li className="text-muted-foreground px-4 py-3 text-sm">
        No subagents in this conversation yet.
      </li>
    )}
    {props.detail.subagents.map((sub) => (
      <li
        key={sub.id}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t px-4 py-2 text-sm first:border-t-0"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{sub.title}</span>
          {sub.agent && <Chip>{sub.agent}</Chip>}
          <AgentStatusBadge
            status={
              props.session.subagents?.find((agent) => agent.id === sub.id)
                ?.status ?? "idle"
            }
            outcome={sub.outcome}
          />
        </span>
        <a
          className="row-span-2 inline-flex items-center gap-1 text-sm font-medium hover:underline"
          href={sessionLink(openUrlOf(props.view, props.session.envId), sub.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open <ExternalLinkIcon className="size-3.5" />
        </a>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatCost(sub.cost)} · {formatTokens(sub.tokens)} tokens ·{" "}
          <When at={sub.updatedAt} />
        </span>
      </li>
    ))}
  </ul>
);

const LONG_PROMPT_CHARS = 280;
const LONG_PROMPT_LINES = 3;

const TurnItem = (props: {
  turn: SessionTurn;
  latest: boolean;
  running: boolean;
  /** The session waits on a permission or an answer. */
  waiting: boolean;
  projectId: string;
  checkout: Checkout;
  sessionId: string;
  onSent: (notice: string) => void;
}) => {
  const { turn, running } = props;
  // The newest turn shows its changes from the start; older ones on demand.
  const [open, setOpen] = useState(props.latest);
  const [whole, setWhole] = useState(false);
  const long =
    turn.prompt.length > LONG_PROMPT_CHARS ||
    turn.prompt.split("\n").length > LONG_PROMPT_LINES;
  const duration = turnDuration(turn, running);
  const activity = turnActivity(turn);
  const usage = [
    turn.cost !== undefined && formatCost(turn.cost),
    turn.tokens !== undefined && `${formatTokens(turn.tokens)} tokens`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-col gap-2 border-t px-4 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className={cn(
              "text-sm font-medium break-words whitespace-pre-wrap",
              long && !whole && "line-clamp-3"
            )}
          >
            {turn.prompt || "(empty prompt)"}
          </p>
          {long && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-auto self-start p-0 hover:bg-transparent"
              onClick={() => setWhole((w) => !w)}
            >
              {whole ? "Show less" : "Show the whole prompt"}
            </Button>
          )}
        </div>
        <When
          at={turn.created}
          className="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
        />
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
        {running ? (
          <span className="text-foreground inline-flex items-center gap-1">
            {props.waiting ? (
              <span className="text-attention">Waiting on you</span>
            ) : (
              <>
                <LoaderCircleIcon className="size-3 animate-spin" /> Working
              </>
            )}
          </span>
        ) : (
          duration && <span>{duration}</span>
        )}
        {usage && <span>{usage}</span>}
        {activity && <span>{activity}</span>}
        {turn.model && (
          <Tip label={turn.agent ? `Agent ${turn.agent}` : "Model"}>
            <span>{modelShortName(turn.model)}</span>
          </Tip>
        )}
      </div>
      {turn.error && (
        <p className="text-destructive text-sm break-words">{turn.error}</p>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 self-start"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />} Changes
        {turn.files > 0 && (
          <span className="text-muted-foreground">({turn.files})</span>
        )}
      </Button>
      {open && (
        <TurnChanges
          projectId={props.projectId}
          target={props.checkout.target}
          directory={props.checkout.directory}
          sessionId={props.sessionId}
          turn={turn}
          latest={props.latest}
          running={running}
          onSent={props.onSent}
        />
      )}
    </li>
  );
};
