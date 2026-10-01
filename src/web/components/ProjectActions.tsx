import { useEffect, useRef, useState } from "react";
import type { ProjectView, SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { startSession } from "../api";
import { useDash } from "../DashboardContext";
import { workspaceFolderOf } from "../derive";
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

/**
 * Opens a tab synchronously (inside the click) so popup blockers allow it, then points it at the
 * session once the server has created it.
 */
export async function openSessionTab(view: ProjectView, create: () => Promise<string | undefined>): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const id = await create();
    if (id && tab) tab.location.href = sessionUrl(view.openUrl, id);
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
    <a
      className={`button primary${enabled ? "" : " disabled"}${compact ? " small" : ""}`}
      href={enabled ? (latest ? sessionUrl(view.openUrl, latest.id) : view.openUrl) : undefined}
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
