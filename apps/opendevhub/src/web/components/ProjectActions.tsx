import { EllipsisIcon, PlayIcon, SquareIcon } from "lucide-react";
import type { ProjectView } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { envAction } from "../api";
import { useDash } from "../DashboardContext";
import { envOfDirectory, openUrlOf } from "../derive";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

/** Project-wide actions on every container of the project: the main checkout's and each worktree's own. */
export function AllContainersMenu({ view }: { view: ProjectView }) {
  const { act, snapshot, report } = useDash();
  const blocked = (snapshot?.preflight.errors.length ?? 0) > 0;
  const { locked, running } = projectFlags(view, blocked);
  const id = view.project.id;
  const count = 1 + view.environments.length;

  const all = (action: "rebuild" | "restart-opencode") => {
    if (!locked && (action === "rebuild" || running)) act(id, action);
    for (const env of view.environments) {
      const state = env.runtime.containerState;
      if (state === "starting" || state === "stopping") continue;
      if (action === "restart-opencode" && state !== "running") continue;
      envAction(id, env.id, action).catch(report);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="All containers" title="All containers">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            if (confirm(`Rebuild all ${count} containers of ${view.project.name}? Running sessions will be interrupted.`)) all("rebuild");
          }}
        >
          Rebuild all containers
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => all("restart-opencode")}>Restart opencode in all containers</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
