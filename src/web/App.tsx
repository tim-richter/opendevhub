import { useState } from "react";
import { type Action, postAction, rescan } from "./api";
import { ProjectCard } from "./components/ProjectCard";
import { attentionCounts } from "./derive";
import { useDashboard } from "./useDashboard";

type Permission = NotificationPermission | "unsupported";

export function App() {
  const { snapshot, connected, logs, loadLogs, highlight } = useDashboard();
  const [actionError, setActionError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [permission, setPermission] = useState<Permission>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  if (!snapshot) {
    return (
      <main className="app">
        <p className="muted">{connected ? "Loading…" : "Connecting to opendevhub…"}</p>
      </main>
    );
  }

  const counts = attentionCounts(snapshot);
  const blocked = snapshot.preflight.errors.length > 0;
  const act = (projectId: string, action: Action) =>
    postAction(projectId, action).then(
      () => setActionError(undefined),
      (err: Error) => setActionError(err.message),
    );
  const doRescan = () => {
    setScanning(true);
    rescan()
      .catch((err: Error) => setActionError(err.message))
      .finally(() => setScanning(false));
  };

  return (
    <main className="app">
      <header className="top">
        <div>
          <h1>opendevhub</h1>
          <p className="muted">{snapshot.roots.join(" · ")}</p>
        </div>
        <div className="top-actions">
          <span className={`summary${counts.attention > 0 ? " hot" : ""}`}>
            {counts.attention} need attention · {counts.running} running
          </span>
          {permission === "default" && (
            <button onClick={() => void Notification.requestPermission().then(setPermission)}>
              Enable notifications
            </button>
          )}
          <button disabled={scanning} onClick={doRescan}>
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      {!connected && <div className="banner warn">Lost connection to opendevhub — retrying…</div>}
      {snapshot.preflight.errors.map((e) => (
        <div key={e} className="banner error">{e}</div>
      ))}
      {actionError && <div className="banner error">{actionError}</div>}

      {snapshot.projects.length === 0 ? (
        <p className="muted">No projects with a devcontainer found under the configured roots.</p>
      ) : (
        <ul className="projects">
          {snapshot.projects.map((view) => (
            <ProjectCard
              key={view.project.id}
              view={view}
              disabled={blocked}
              logs={logs[view.project.id]}
              highlight={highlight}
              onAction={(a) => void act(view.project.id, a)}
              onLoadLogs={() => void loadLogs(view.project.id)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
