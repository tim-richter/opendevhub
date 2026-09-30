import { useState } from "react";
import type { ContainerState, ProjectView } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import type { Action } from "../api";
import { LogPanel } from "./LogPanel";
import { SessionRow } from "./SessionRow";

const STATE_LABEL: Record<ContainerState, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  error: "Error",
};

export function ProjectCard(props: {
  view: ProjectView;
  disabled: boolean;
  logs: string[] | undefined;
  highlight: string | undefined;
  onAction: (action: Action) => void;
  onLoadLogs: () => void;
}) {
  const { view, disabled, logs, highlight, onAction, onLoadLogs } = props;
  const { project, runtime, sessions, openUrl } = view;
  const [showLogs, setShowLogs] = useState(false);
  const running = runtime.containerState === "running";
  // Show Stop whenever there's a container to stop, even if it's in "error" state (e.g. a
  // failed `docker stop` left it running) — otherwise the user has no way to retry.
  const canStop = Boolean(runtime.containerId) && runtime.containerState !== "stopped";
  const transitioning =
    runtime.containerState === "starting" || runtime.containerState === "stopping" || runtime.opencode === "starting";
  const canOpen = running && runtime.opencode === "healthy";
  const locked = disabled || transitioning;

  return (
    <li className="card">
      <div className="card-head">
        <div>
          <h2>{project.name}</h2>
          <p className="muted path">{project.path}</p>
        </div>
        <div className="pills">
          <span className={`pill state-${runtime.containerState}`}>{STATE_LABEL[runtime.containerState]}</span>
          {running && (
            <span className={`pill oc-${runtime.opencode}`}>
              opencode {runtime.opencode}
              {runtime.opencodeVersion ? ` · v${runtime.opencodeVersion}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="actions">
        {canStop ? (
          <button disabled={locked} onClick={() => onAction("stop")}>Stop</button>
        ) : (
          <button disabled={locked} onClick={() => onAction("start")}>Start</button>
        )}
        <button disabled={locked} onClick={() => onAction("rebuild")}>Rebuild</button>
        {running && runtime.opencode === "unhealthy" && (
          <button disabled={locked} onClick={() => onAction("restart-opencode")}>Restart opencode</button>
        )}
        <a
          className={`button primary${canOpen ? "" : " disabled"}`}
          href={canOpen ? openUrl : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!canOpen}
        >
          Open in opencode ↗
        </a>
        <button
          className="link"
          onClick={() => {
            if (!showLogs) onLoadLogs();
            setShowLogs(!showLogs);
          }}
        >
          {showLogs ? "Hide logs" : "Logs"}
        </button>
      </div>

      {runtime.error && <p className="error-text">{runtime.error}</p>}

      {sessions.length > 0 && (
        <ul className="sessions">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} openUrl={sessionUrl(openUrl, s.id)} highlighted={s.id === highlight} />
          ))}
        </ul>
      )}
      {canOpen && sessions.length === 0 && <p className="muted">No sessions yet — open opencode to start one.</p>}
      {showLogs && <LogPanel lines={logs ?? []} />}
    </li>
  );
}
