import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useOutletContext, useParams, useSearchParams } from "react-router";
import type { ForwardedPort, ProjectView } from "../../shared/types";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { LogPanel } from "../components/LogPanel";
import { OpenInMenu } from "../components/OpenInMenu";
import { MoreMenu, OpenButton, projectFlags, StartStopButton } from "../components/ProjectActions";
import { SessionList } from "../components/SessionList";
import { Count, STATE_LABEL, StatusDot } from "../components/Status";
import { useDash } from "../DashboardContext";
import {
  compareSessions,
  matches,
  needsAttention,
  projectCounts,
  projectTone,
  type SessionEntry,
  workspaceFolderOf,
} from "../derive";
import { NotFound } from "./NotFound";

const IDLE_LIMIT = 8;

export function ProjectPage() {
  const { projectId } = useParams();
  const { snapshot } = useDash();
  const view = snapshot?.projects.find((v) => v.project.id === projectId);
  if (!view) return <NotFound what="Project" />;

  const { runtime, project } = view;
  const c = projectCounts(view);
  const { running } = projectFlags(view, false);
  const base = `/p/${encodeURIComponent(project.id)}`;
  const portCount = runtime.ports?.length ?? 0;

  return (
    <div className="page">
      <header className="page-head project-head">
        <div className="project-title">
          <h1>
            <StatusDot tone={projectTone(view)} /> {project.name}
          </h1>
          <p className="muted path">
            {project.path} <CopyButton text={project.path} label="Copy path" />
          </p>
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
        <div className="head-actions">
          <StartStopButton view={view} />
          <OpenButton view={view} />
          <OpenInMenu view={view} directory={workspaceFolderOf(view)} hostPath={project.path} />
          <MoreMenu view={view} />
        </div>
      </header>

      {runtime.error && <div className="banner error">{runtime.error}</div>}

      <nav className="tabs">
        <NavLink to={base} end>
          Sessions <Count n={c.attention} tone="attention" />
          {c.attention === 0 && <Count n={view.sessions.length} tone="muted" />}
        </NavLink>
        <NavLink to={`${base}/worktrees`}>
          Worktrees <Count n={runtime.worktrees?.length ?? 0} tone="muted" />
        </NavLink>
        <NavLink to={`${base}/ports`}>
          Ports <Count n={portCount} tone="muted" />
        </NavLink>
        <NavLink to={`${base}/logs`}>Logs</NavLink>
      </nav>

      <Outlet context={view} />
    </div>
  );
}

const useView = () => useOutletContext<ProjectView>();

export function ProjectSessions() {
  const view = useView();
  const [params] = useSearchParams();
  const highlight = params.get("session") ?? undefined;
  const [query, setQuery] = useState("");
  const [showAllIdle, setShowAllIdle] = useState(false);
  const { canOpen } = projectFlags(view, false);

  const entries = useMemo<SessionEntry[]>(
    () =>
      [...view.sessions]
        .sort(compareSessions)
        .filter((s) => matches(query, s.title, s.directory))
        .map((session) => ({ session, view })),
    [view, query],
  );

  useEffect(() => {
    if (highlight) document.getElementById(`session-${highlight}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight]);

  if (view.sessions.length === 0) {
    return (
      <div className="empty">
        {canOpen ? (
          <>
            <h2>No sessions yet</h2>
            <p className="muted">Open opencode to start one.</p>
            <OpenButton view={view} />
          </>
        ) : (
          <>
            <h2>Not running</h2>
            <p className="muted">Start the container to see this project's opencode sessions.</p>
            <StartStopButton view={view} />
          </>
        )}
      </div>
    );
  }

  const attention = entries.filter((e) => needsAttention(e.session.status));
  const active = entries.filter((e) => e.session.status === "running");
  const idle = entries.filter((e) => e.session.status === "idle");
  // Never hide the highlighted session behind "show more".
  const highlightIdx = idle.findIndex((e) => e.session.id === highlight);
  const idleShown = showAllIdle || highlightIdx >= IDLE_LIMIT ? idle : idle.slice(0, IDLE_LIMIT);

  return (
    <div className="tab-body">
      {view.sessions.length > IDLE_LIMIT && (
        <input className="search" placeholder="Filter sessions…" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <Group title="Needs you" entries={attention} highlight={highlight} tone="attention" />
      <Group title="Working" entries={active} highlight={highlight} />
      <Group title="Idle" entries={idleShown} highlight={highlight} total={idle.length} />
      {idleShown.length < idle.length && (
        <button className="link" onClick={() => setShowAllIdle(true)}>
          Show {idle.length - idleShown.length} more idle sessions
        </button>
      )}
      {entries.length === 0 && <p className="muted">No sessions match.</p>}
    </div>
  );
}

function Group(props: { title: string; entries: SessionEntry[]; highlight?: string; total?: number; tone?: "attention" }) {
  if (props.entries.length === 0) return null;
  return (
    <section className={`group${props.tone ? ` group-${props.tone}` : ""}`}>
      <h3>
        {props.title} <span className="muted">{props.total ?? props.entries.length}</span>
      </h3>
      <SessionList entries={props.entries} highlight={props.highlight} />
    </section>
  );
}

export function ProjectPorts() {
  const { runtime } = useView();
  const ports = runtime.ports ?? [];
  if (ports.length === 0) {
    return (
      <div className="empty">
        <h2>No forwarded ports</h2>
        <p className="muted">
          Add <code>forwardPorts</code> to the project's devcontainer.json to reach its apps from <code>localhost</code>.
        </p>
      </div>
    );
  }
  return (
    <div className="tab-body">
      {runtime.relay && (
        <p className={`note${runtime.relay === "unavailable" ? " note-warn" : ""}`}>
          {runtime.relay === "active"
            ? "Connections go through a relay inside the container, so apps bound to localhost there are reachable."
            : "No relay in the container: only apps listening on 0.0.0.0 are reachable. See the Logs tab for why."}
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Container</th>
              <th>Local</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {ports.map((p) => (
              <PortRow key={p.status === "skipped" ? `s-${p.entry}` : `${p.status}-${p.containerPort}`} port={p} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PortRow({ port: p }: { port: ForwardedPort }) {
  if (p.status === "skipped") {
    return (
      <tr className="dim">
        <td>—</td>
        <td className="mono">{p.entry}</td>
        <td>—</td>
        <td title={p.reason}>
          <span className="badge">Skipped</span> <span className="muted">{p.reason}</span>
        </td>
      </tr>
    );
  }
  if (p.status === "failed") {
    return (
      <tr className="dim">
        <td>{p.label ?? "—"}</td>
        <td className="mono">{p.containerPort}</td>
        <td>—</td>
        <td>
          <span className="badge badge-error">Failed</span> <span className="muted">{p.reason}</span>
        </td>
      </tr>
    );
  }
  const url = `http://localhost:${p.hostPort}/`;
  const moved = p.hostPort !== p.containerPort;
  return (
    <tr>
      <td>{p.label ?? "—"}</td>
      <td className="mono">{p.containerPort}</td>
      <td className="mono">
        <a href={url} target="_blank" rel="noreferrer">
          localhost:{p.hostPort} <Icon name="external" size={12} />
        </a>{" "}
        <CopyButton text={url} label="Copy URL" />
      </td>
      <td>
        <span className="badge badge-ok">Forwarded</span>
        {moved && <span className="muted" title={`Port ${p.containerPort} was taken on this machine`}> · moved</span>}
      </td>
    </tr>
  );
}

export function ProjectLogs() {
  const { project } = useView();
  const { logs, loadLogs } = useDash();
  useEffect(() => loadLogs(project.id), [project.id, loadLogs]);
  return (
    <div className="tab-body">
      <LogPanel lines={logs[project.id] ?? []} />
    </div>
  );
}
