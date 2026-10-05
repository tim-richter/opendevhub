import { EllipsisIcon, ExternalLinkIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import type { ProjectView, SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { startSession } from "../api";
import { useDash } from "../DashboardContext";
import { envOfDirectory, openUrlOf, sessionHref, workspaceFolderOf } from "../derive";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function projectFlags(view: ProjectView, blocked: boolean) {
  const { runtime } = view;
  // Show Stop whenever there's a container to stop, even if it's in "error" state (e.g. a
  // failed `docker stop` left it running) — otherwise the user has no way to retry.
  const canStop = Boolean(runtime.containerId) && runtime.containerState !== "stopped";
  const transitioning =
    runtime.containerState === "starting" || runtime.containerState === "stopping" || runtime.opencode === "starting";
  const running = runtime.containerState === "running";
  return {
    canStop,
    running,
    transitioning,
    canOpen: running && runtime.opencode === "healthy",
    unhealthy: running && runtime.opencode === "unhealthy",
    locked: blocked || transitioning,
  };
}

/**
 * Opens a tab synchronously (inside the click) so popup blockers allow it, then points it at the
 * session once the server has created it.
 */
export async function openSessionTab(view: ProjectView, create: () => Promise<string | undefined>, directory?: string): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const id = await create();
    const base = directory ? openUrlOf(view, envOfDirectory(view, directory)?.id) : view.openUrl;
    if (id && tab) tab.location.href = sessionUrl(base, id);
    else tab?.close();
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/**
 * Opens the most recent session, or starts one in the workspace folder. opencode's home screen
 * starts with an empty project list (kept in browser storage, out of our reach), so landing on a
 * session spares the user from adding the workspace folder by hand.
 */
export function OpenButton({ view, compact }: { view: ProjectView; compact?: boolean }) {
  const { report } = useDash();
  const [starting, setStarting] = useState(false);
  const { canOpen } = projectFlags(view, false);
  const latest = view.sessions.reduce<SessionSummary | undefined>(
    (best, s) => (!best || s.updatedAt > best.updatedAt ? s : best),
    undefined,
  );
  const enabled = canOpen && !starting;
  return (
    <Button asChild size={compact ? "sm" : "default"} className={cn(!enabled && "pointer-events-none opacity-50")}>
      <a
        href={enabled ? (latest ? sessionHref(view, latest) : view.openUrl) : undefined}
        target="_blank"
        rel="noreferrer"
        aria-disabled={!enabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!enabled || latest) return;
          e.preventDefault();
          setStarting(true);
          openSessionTab(view, () => startSession(view.project.id, workspaceFolderOf(view)))
            .catch(report)
            .finally(() => setStarting(false));
        }}
      >
        {compact ? "Open" : "Open in opencode"} <ExternalLinkIcon />
      </a>
    </Button>
  );
}

export function StartStopButton({ view, compact }: { view: ProjectView; compact?: boolean }) {
  const { act, snapshot } = useDash();
  const blocked = (snapshot?.preflight.errors.length ?? 0) > 0;
  const { canStop, locked, transitioning } = projectFlags(view, blocked);
  const id = view.project.id;
  return (
    <Button
      variant="outline"
      size={compact ? "sm" : "default"}
      disabled={locked}
      onClick={(e) => {
        e.stopPropagation();
        act(id, canStop ? "stop" : "start");
      }}
    >
      {canStop ? <SquareIcon className="size-3" /> : <PlayIcon className="size-3" />}
      {transitioning ? (view.runtime.containerState === "stopping" ? "Stopping…" : "Starting…") : canStop ? "Stop" : "Start"}
    </Button>
  );
}

export function MoreMenu({ view }: { view: ProjectView }) {
  const { act, snapshot } = useDash();
  const blocked = (snapshot?.preflight.errors.length ?? 0) > 0;
  const { locked, running } = projectFlags(view, blocked);
  const id = view.project.id;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="More actions">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={locked}
          onSelect={() => {
            if (confirm(`Rebuild the devcontainer for ${view.project.name}? Running sessions will be interrupted.`))
              act(id, "rebuild");
          }}
        >
          Rebuild container
        </DropdownMenuItem>
        <DropdownMenuItem disabled={locked || !running} onSelect={() => act(id, "restart-opencode")}>
          Restart opencode
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
