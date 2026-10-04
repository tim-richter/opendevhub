import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { sessionUrl } from "../../shared/urls";
import { useDash } from "../DashboardContext";
import { allSessions, matches, projectTone } from "../derive";
import { projectIdFromPath } from "../tasks";
import { Icon } from "./Icon";
import { SESSION_LABEL, StatusDot } from "./Status";

interface Item {
  key: string;
  group: string;
  label: string;
  hint?: string;
  dot?: ReturnType<typeof projectTone>;
  run: () => void;
}

const LIMIT = 40;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snapshot, rescan, newTask } = useDash();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!snapshot) return [];
    const go = (to: string) => () => void navigate(to);
    const list: Item[] = [
      { key: "nav-overview", group: "Go to", label: "Overview", run: go("/") },
      { key: "nav-sessions", group: "Go to", label: "All sessions", run: go("/sessions") },
      { key: "act-new-task", group: "Actions", label: "New task", hint: "n", run: () => newTask(projectIdFromPath(location.pathname)) },
      { key: "act-rescan", group: "Actions", label: "Rescan projects", run: rescan },
    ];
    for (const view of snapshot.projects) {
      const id = encodeURIComponent(view.project.id);
      list.push({
        key: `p-${view.project.id}`,
        group: "Projects",
        label: view.project.name,
        hint: view.project.path,
        dot: projectTone(view),
        run: go(`/p/${id}`),
      });
    }
    for (const { session, view } of allSessions(snapshot)) {
      list.push({
        key: `s-${session.id}`,
        group: "Sessions",
        label: session.title || "Untitled session",
        hint: `${view.project.name} · ${SESSION_LABEL[session.status]}`,
        run: () => window.open(sessionUrl(view.openUrl, session.id), "_blank", "noreferrer"),
      });
    }
    return list;
  }, [snapshot, navigate, rescan, newTask, location.pathname]);

  const filtered = useMemo(() => items.filter((i) => matches(query, i.label, i.hint)).slice(0, LIMIT), [items, query]);

  if (!open) return null;

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = "";
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={query}
            placeholder="Jump to a project, session or action…"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(filtered[active]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="palette-list" role="listbox">
          {filtered.length === 0 && <li className="muted palette-empty">No matches</li>}
          {filtered.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : undefined;
            lastGroup = item.group;
            return (
              <li key={item.key}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item${i === active ? " active" : ""}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(item)}
                  ref={(el) => {
                    if (i === active) el?.scrollIntoView({ block: "nearest" });
                  }}
                >
                  {item.dot && <StatusDot tone={item.dot} />}
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="muted palette-hint">{item.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
