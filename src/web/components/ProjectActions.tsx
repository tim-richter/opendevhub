import { useEffect, useRef, useState } from "react";
import type { ProjectView } from "../../shared/types";
import { useDash } from "../DashboardContext";
import { Icon } from "./Icon";

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

export function OpenButton({ view, compact }: { view: ProjectView; compact?: boolean }) {
  const { canOpen } = projectFlags(view, false);
  return (
    <a
      className={`button primary${canOpen ? "" : " disabled"}${compact ? " small" : ""}`}
      href={canOpen ? view.openUrl : undefined}
      target="_blank"
      rel="noreferrer"
      aria-disabled={!canOpen}
      onClick={(e) => e.stopPropagation()}
    >
      {compact ? "Open" : "Open in opencode"} <Icon name="external" size={14} />
    </a>
  );
}

export function StartStopButton({ view, compact }: { view: ProjectView; compact?: boolean }) {
  const { act, snapshot } = useDash();
  const blocked = (snapshot?.preflight.errors.length ?? 0) > 0;
  const { canStop, locked, transitioning } = projectFlags(view, blocked);
  const id = view.project.id;
  return (
    <button
      className={compact ? "small" : undefined}
      disabled={locked}
      onClick={(e) => {
        e.stopPropagation();
        act(id, canStop ? "stop" : "start");
      }}
    >
      <Icon name={canStop ? "stop" : "play"} size={12} />
      {transitioning ? (view.runtime.containerState === "stopping" ? "Stopping…" : "Starting…") : canStop ? "Stop" : "Start"}
    </button>
  );
}

/** Open/close state for a popup menu that closes on outside click or Escape. */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return { open, setOpen, ref, run };
}

export function MoreMenu({ view }: { view: ProjectView }) {
  const { act, snapshot } = useDash();
  const blocked = (snapshot?.preflight.errors.length ?? 0) > 0;
  const { locked, running } = projectFlags(view, blocked);
  const { open, setOpen, ref, run } = useMenu();
  const id = view.project.id;

  return (
    <div className="menu" ref={ref}>
      <button className="icon-button" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <button
            role="menuitem"
            disabled={locked}
            onClick={run(() => {
              if (confirm(`Rebuild the devcontainer for ${view.project.name}? Running sessions will be interrupted.`))
                act(id, "rebuild");
            })}
          >
            Rebuild container
          </button>
          <button role="menuitem" disabled={locked || !running} onClick={run(() => act(id, "restart-opencode"))}>
            Restart opencode
          </button>
        </div>
      )}
    </div>
  );
}
