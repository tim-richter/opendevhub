import { useSearchParams } from "react-router";
import type { SessionStatus } from "../../shared/types";
import { SessionList } from "../components/SessionList";
import { useDash } from "../DashboardContext";
import { allSessions, matches, needsAttention } from "../derive";

type StatusFilter = "all" | "attention" | SessionStatus;
const CHIPS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs you" },
  { id: "running", label: "Working" },
  { id: "idle", label: "Idle" },
];

export function SessionsPage() {
  const { snapshot } = useDash();
  const [params, setParams] = useSearchParams();
  if (!snapshot) return null;

  const status = (params.get("status") ?? "all") as StatusFilter;
  const project = params.get("project") ?? "";
  const q = params.get("q") ?? "";
  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value && value !== "all") next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const all = allSessions(snapshot);
  const byStatus = (f: StatusFilter) =>
    all.filter((e) =>
      f === "all" ? true : f === "attention" ? needsAttention(e.session.status) : e.session.status === f,
    );
  const entries = byStatus(status)
    .filter((e) => !project || e.view.project.id === project)
    .filter((e) => matches(q, e.session.title, e.view.project.name));
  const withSessions = snapshot.projects.filter((v) => v.sessions.length > 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Sessions</h1>
          <p className="muted">Every opencode session across running projects</p>
        </div>
      </header>

      <div className="toolbar">
        <div className="segmented">
          {CHIPS.map((c) => (
            <button key={c.id} className={status === c.id ? "on" : ""} aria-pressed={status === c.id} onClick={() => set("status", c.id)}>
              {c.label} <span className="seg-count">{byStatus(c.id).length}</span>
            </button>
          ))}
        </div>
        <select value={project} onChange={(e) => set("project", e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {withSessions.map((v) => (
            <option key={v.project.id} value={v.project.id}>
              {v.project.name}
            </option>
          ))}
        </select>
        <input className="search" placeholder="Search titles…" value={q} onChange={(e) => set("q", e.target.value)} />
      </div>

      {all.length === 0 ? (
        <div className="empty">
          <h2>No sessions</h2>
          <p className="muted">Start a project and open opencode to create one.</p>
        </div>
      ) : entries.length === 0 ? (
        <p className="muted">No sessions match these filters.</p>
      ) : (
        <div className="panel flush">
          <SessionList entries={entries} showProject />
        </div>
      )}
    </div>
  );
}
