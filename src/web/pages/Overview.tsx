import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectView } from "../../shared/types";
import { MoreMenu, OpenButton, projectFlags, StartStopButton } from "../components/ProjectActions";
import { SessionList } from "../components/SessionList";
import { STATE_LABEL, StatusDot, TONE_LABEL } from "../components/Status";
import { useDash } from "../DashboardContext";
import { allSessions, matches, needsAttention, projectCounts, projectTone } from "../derive";

type Filter = "all" | "running" | "stopped";
const ACTIVE_LIMIT = 6;

export function Overview() {
  const { snapshot } = useDash();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  if (!snapshot) return null;

  const sessions = allSessions(snapshot);
  const attention = sessions.filter((e) => needsAttention(e.session.status));
  const active = sessions.filter((e) => e.session.status === "running");
  const runningProjects = snapshot.projects.filter((v) => v.runtime.containerState === "running");
  const ports = snapshot.projects.reduce((n, v) => n + projectCounts(v).ports, 0);

  const isUp = (v: ProjectView) => v.runtime.containerState !== "stopped";
  const tiles = [...snapshot.projects]
    .sort((a, b) => a.project.name.localeCompare(b.project.name))
    .filter((v) => (filter === "all" ? true : filter === "running" ? isUp(v) : !isUp(v)))
    .filter((v) => matches(query, v.project.name, v.project.path));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">{snapshot.roots.join(" · ") || "No roots configured"}</p>
        </div>
      </header>

      <section className="stats">
        <Stat label="Projects running" value={runningProjects.length} of={snapshot.projects.length} />
        <Stat label="Agents working" value={active.length} tone={active.length > 0 ? "running" : undefined} />
        <Stat label="Need you" value={attention.length} tone={attention.length > 0 ? "attention" : undefined} />
        <Stat label="Forwarded ports" value={ports} />
      </section>

      {attention.length > 0 ? (
        <section className="panel panel-attention">
          <div className="panel-head">
            <h2>Needs you</h2>
            <span className="muted">Agents blocked on a permission or a question</span>
          </div>
          <SessionList entries={attention} showProject />
        </section>
      ) : (
        snapshot.projects.length > 0 && <p className="all-clear">✓ No agent is waiting on you.</p>
      )}

      <section>
        <div className="section-head">
          <h2>Projects</h2>
          <div className="segmented" role="tablist">
            {(["all", "running", "stopped"] as const).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f[0]!.toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          {snapshot.projects.length > 6 && (
            <input className="search" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
        </div>
        {snapshot.projects.length === 0 ? (
          <div className="empty">
            <h2>No projects yet</h2>
            <p className="muted">No folder with a devcontainer was found under the configured roots.</p>
          </div>
        ) : tiles.length === 0 ? (
          <p className="muted">No projects match.</p>
        ) : (
          <ul className="tiles">
            {tiles.map((v) => (
              <ProjectTile key={v.project.id} view={v} />
            ))}
          </ul>
        )}
      </section>

      {active.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Working now</h2>
            {active.length > ACTIVE_LIMIT && (
              <Link to="/sessions?status=running" className="muted-link">
                All {active.length} →
              </Link>
            )}
          </div>
          <SessionList entries={active.slice(0, ACTIVE_LIMIT)} showProject />
        </section>
      )}
    </div>
  );
}

function Stat(props: { label: string; value: number; of?: number; tone?: "attention" | "running" }) {
  return (
    <div className={`stat${props.tone ? ` stat-${props.tone}` : ""}`}>
      <span className="stat-value">
        {props.value}
        {props.of !== undefined && <span className="stat-of"> / {props.of}</span>}
      </span>
      <span className="stat-label">{props.label}</span>
    </div>
  );
}

function ProjectTile({ view }: { view: ProjectView }) {
  const navigate = useNavigate();
  const tone = projectTone(view);
  const c = projectCounts(view);
  const { canOpen, running } = projectFlags(view, false);
  const to = `/p/${encodeURIComponent(view.project.id)}`;
  const status = view.runtime.containerState === "running" ? TONE_LABEL[tone] : STATE_LABEL[view.runtime.containerState];

  return (
    <li className={`tile tile-${tone}`} onClick={() => void navigate(to)}>
      <div className="tile-head">
        <StatusDot tone={tone} />
        <Link to={to} className="tile-name" onClick={(e) => e.stopPropagation()}>
          {view.project.name}
        </Link>
        <span className={`tile-status tone-text-${tone}`}>{status}</span>
      </div>
      <p className="muted path" title={view.project.path}>
        {view.project.path}
      </p>
      <div className="tile-meta">
        {c.attention > 0 && <span className="meta-attention">{c.attention} need you</span>}
        {running ? (
          <>
            <span>{c.running} working</span>
            <span>{c.idle} idle</span>
            <span>{c.ports} {c.ports === 1 ? "port" : "ports"}</span>
          </>
        ) : (
          view.runtime.containerState === "stopped" && <span className="muted">Container not running</span>
        )}
      </div>
      {view.runtime.error && <p className="tile-error" title={view.runtime.error}>{view.runtime.error}</p>}
      <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
        {canOpen ? <OpenButton view={view} compact /> : null}
        <StartStopButton view={view} compact />
        <MoreMenu view={view} />
      </div>
    </li>
  );
}
