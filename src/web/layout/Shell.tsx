import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { CommandPalette } from "../components/CommandPalette";
import { Icon } from "../components/Icon";
import { Count, StatusDot, TONE_LABEL } from "../components/Status";
import { useDash } from "../DashboardContext";
import { attentionCounts, matches, projectCounts, projectTone } from "../derive";

const FILTER_THRESHOLD = 8;

export function Shell() {
  const { snapshot, connected, error, dismissError, rescan, scanning, permission, requestPermission } = useDash();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [filter, setFilter] = useState("");
  const location = useLocation();

  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!snapshot) {
    return (
      <div className="splash">
        <div className="spinner" />
        <p className="muted">{connected ? "Loading…" : "Connecting to opendevhub…"}</p>
      </div>
    );
  }

  const counts = attentionCounts(snapshot);
  const projects = [...snapshot.projects]
    .sort((a, b) => a.project.name.localeCompare(b.project.name))
    .filter((v) => matches(filter, v.project.name, v.project.path));
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  return (
    <div className={`shell${drawer ? " drawer-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true">◆</span> opendevhub
          <button className="icon-button drawer-close" aria-label="Close menu" onClick={() => setDrawer(false)}>
            <Icon name="close" />
          </button>
        </div>

        <button className="search-trigger" onClick={() => setPalette(true)}>
          <Icon name="search" size={14} /> <span>Jump to…</span> <kbd>{isMac ? "⌘" : "Ctrl"} K</kbd>
        </button>

        <nav className="nav">
          <NavLink to="/" end>
            <Icon name="overview" /> Overview
          </NavLink>
          <NavLink to="/sessions">
            <Icon name="sessions" /> Sessions
            <span className="nav-trail">
              <Count n={counts.attention} tone="attention" />
            </span>
          </NavLink>
        </nav>

        <div className="nav-section">
          <span>Projects</span>
          <span className="muted">{snapshot.projects.length}</span>
        </div>
        {snapshot.projects.length > FILTER_THRESHOLD && (
          <input className="nav-filter" placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        <nav className="nav projects-nav">
          {projects.map((view) => {
            const c = projectCounts(view);
            const tone = projectTone(view);
            return (
              <NavLink key={view.project.id} to={`/p/${encodeURIComponent(view.project.id)}`} title={`${view.project.name} — ${TONE_LABEL[tone]}`}>
                <StatusDot tone={tone} />
                <span className="nav-label">{view.project.name}</span>
                <span className="nav-trail">
                  {c.attention > 0 ? <Count n={c.attention} tone="attention" /> : <Count n={c.running} tone="muted" />}
                </span>
              </NavLink>
            );
          })}
          {projects.length === 0 && <p className="muted nav-empty">{filter ? "No match" : "No projects found"}</p>}
        </nav>

        <div className="sidebar-foot">
          {permission === "default" && (
            <button className="small ghost" onClick={requestPermission}>
              <Icon name="bell" size={14} /> Enable notifications
            </button>
          )}
          <button className="small ghost" disabled={scanning} onClick={rescan} title={snapshot.roots.join("\n")}>
            <Icon name="refresh" size={14} /> {scanning ? "Scanning…" : "Rescan roots"}
          </button>
          <div className={`conn ${connected ? "on" : "off"}`}>
            <span className="dot" /> {connected ? "Live" : "Reconnecting…"}
          </div>
        </div>
      </aside>
      <div className="scrim" onClick={() => setDrawer(false)} />

      <div className="main">
        <div className="mobile-bar">
          <button className="icon-button" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <Icon name="menu" />
          </button>
          <span className="brand-small">opendevhub</span>
          {counts.attention > 0 && <Count n={counts.attention} tone="attention" />}
          <button className="icon-button" aria-label="Search" onClick={() => setPalette(true)}>
            <Icon name="search" />
          </button>
        </div>

        <div className="banners">
          {!connected && <div className="banner warn">Lost connection to opendevhub — retrying…</div>}
          {snapshot.preflight.errors.map((e) => (
            <div key={e} className="banner error">
              {e}
            </div>
          ))}
          {error && (
            <div className="banner error">
              <span>{error}</span>
              <button className="icon-button" aria-label="Dismiss" onClick={dismissError}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
        </div>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
