import { checkoutPath, checkouts, checkoutTone } from "../checkouts";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useDash } from "../DashboardContext";
import { allSessions, matches, projectTone, sessionHref } from "../derive";
import { projectIdFromPath } from "../tasks";
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
  const { snapshot, rescan, newTask, openAddProject } = useDash();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!snapshot) return [];
    const go = (to: string) => () => void navigate(to);
    const list: Item[] = [
      { key: "nav-overview", group: "Go to", label: "Overview", run: go("/") },
      { key: "nav-sessions", group: "Go to", label: "All sessions", run: go("/sessions") },
      { key: "act-new-task", group: "Actions", label: "New task", hint: "n", run: () => newTask(projectIdFromPath(location.pathname)) },
      { key: "act-rescan", group: "Actions", label: "Rescan projects", run: rescan },
      { key: "act-add-project", group: "Actions", label: "Add project…", run: openAddProject },
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
      for (const c of checkouts(view).filter((c) => c.worktree)) {
        list.push({
          key: `w-${view.project.id}-${c.target}`,
          group: "Worktrees",
          label: `${view.project.name} › ${c.label}`,
          hint: c.hostPath ?? c.directory,
          dot: checkoutTone(view, c.directory),
          run: go(checkoutPath(view.project.id, c.target)),
        });
      }
    }
    for (const { session, view } of allSessions(snapshot)) {
      list.push({
        key: `s-${session.id}`,
        group: "Sessions",
        label: session.title || "Untitled session",
        hint: `${view.project.name} · ${SESSION_LABEL[session.status]}`,
        run: () => window.open(sessionHref(view, session), "_blank", "noreferrer"),
      });
    }
    return list;
  }, [snapshot, navigate, rescan, newTask, openAddProject, location.pathname]);

  // Filtering stays ours (substring match, capped) rather than cmdk's fuzzy ranking.
  const groups = useMemo(() => {
    const out = new Map<string, Item[]>();
    for (const item of items.filter((i) => matches(query, i.label, i.hint)).slice(0, LIMIT)) {
      out.set(item.group, [...(out.get(item.group) ?? []), item]);
    }
    return [...out];
  }, [items, query]);

  const choose = (item: Item) => {
    onClose();
    item.run();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      shouldFilter={false}
      title="Command palette"
      description="Jump to a project, session or action"
      showCloseButton={false}
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder="Jump to a project, session or action…" />
      <CommandList>
        <CommandEmpty>No matches</CommandEmpty>
        {groups.map(([group, list]) => (
          <CommandGroup key={group} heading={group}>
            {list.map((item) => (
              <CommandItem key={item.key} value={item.key} onSelect={() => choose(item)}>
                {item.dot && <StatusDot tone={item.dot} />}
                <span className="truncate">{item.label}</span>
                {item.hint && <CommandShortcut className="max-w-1/2 truncate tracking-normal">{item.hint}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
