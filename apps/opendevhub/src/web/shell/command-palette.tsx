import { useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

import { SESSION_LABEL, StatusDot } from "../components/status";
import { useDash } from "../dashboard-context";
import { allSessions, matches, projectTone, sessionHref } from "../derive";
import {
  checkoutPath,
  checkouts,
  checkoutTone,
} from "../features/checkouts/checkouts";
import { projectIdFromPath } from "../features/tasks/tasks";
import { sendTestNotification } from "../push";
import { useNavigate } from "../routing";

interface Item {
  key: string;
  group: string;
  label: string;
  hint?: string;
  dot?: ReturnType<typeof projectTone>;
  run: () => void;
}

const LIMIT = 40;

export const CommandPalette = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const {
    snapshot,
    rescan,
    newTask,
    openAddProject,
    permission,
    report,
    forgejo,
    jira,
  } = useDash();
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!snapshot) {
      return [];
    }
    const go = (to: string) => () => void navigate(to);
    const list: Item[] = [
      ...[
        { key: "nav-overview", label: "Overview", run: go("/") },
        {
          key: "nav-sessions",
          label: "All sessions",
          run: go("/sessions"),
        },
        { key: "nav-activity", label: "Activity", run: go("/activity") },
        ...(forgejo?.enabled
          ? [{ key: "nav-pulls", label: "Pull requests", run: go("/forgejo") }]
          : []),
        ...(jira?.enabled
          ? [{ key: "nav-tickets", label: "Tickets", run: go("/jira") }]
          : []),
        { key: "nav-usage", label: "Usage", run: go("/usage") },
        { key: "nav-nodes", label: "Nodes", run: go("/nodes") },
        { key: "nav-cleanup", label: "Cleanup", run: go("/cleanup") },
        { key: "nav-settings", label: "Settings", run: go("/settings") },
      ].map((item): Item => ({ group: "Go to", ...item })),
      {
        group: "Actions",
        hint: "n",
        key: "act-new-task",
        label: "New task",
        run: () => newTask(projectIdFromPath(location.pathname)),
      },
      {
        group: "Actions",
        key: "act-rescan",
        label: "Rescan projects",
        run: rescan,
      },
      {
        group: "Actions",
        key: "act-add-project",
        label: "Add project…",
        run: openAddProject,
      },
    ];
    if (permission === "granted") {
      list.push({
        key: "act-test-notification",
        group: "Actions",
        label: "Send test notification",
        // The notification itself is the success message.
        run: () =>
          void sendTestNotification().then((sent) => {
            if (sent === 0) {
              report(new Error("No browser is subscribed to notifications"));
            }
          }, report),
      });
    }
    for (const view of snapshot.projects) {
      const id = encodeURIComponent(view.project.id);
      list.push({
        dot: projectTone(view),
        group: "Projects",
        hint: view.project.path,
        key: `p-${view.project.id}`,
        label: view.project.name,
        run: go(`/p/${id}`),
      });
      for (const c of checkouts(view).filter((w) => w.worktree)) {
        list.push({
          dot: checkoutTone(view, c.directory),
          group: "Worktrees",
          hint: c.hostPath ?? c.directory,
          key: `w-${view.project.id}-${c.target}`,
          label: `${view.project.name} › ${c.label}`,
          run: go(checkoutPath(view.project.id, c.target)),
        });
      }
    }
    for (const { session, view } of allSessions(snapshot)) {
      list.push({
        group: "Sessions",
        hint: `${view.project.name} · ${SESSION_LABEL[session.status]}`,
        key: `s-${session.id}`,
        label: session.title || "Untitled session",
        run: () =>
          window.open(sessionHref(view, session), "_blank", "noreferrer"),
      });
    }
    return list;
  }, [
    snapshot,
    navigate,
    rescan,
    newTask,
    openAddProject,
    permission,
    report,
    location.pathname,
    forgejo?.enabled,
    jira?.enabled,
  ]);

  // Filtering stays ours (substring match, capped) rather than cmdk's fuzzy ranking.
  const groups = useMemo(() => {
    const out = new Map<string, Item[]>();
    for (const item of items
      .filter((i) => matches(query, i.label, i.hint))
      .slice(0, LIMIT)) {
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
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Jump to a project, session or action…"
      />
      <CommandList>
        <CommandEmpty>No matches</CommandEmpty>
        {groups.map(([group, list]) => (
          <CommandGroup key={group} heading={group}>
            {list.map((item) => (
              <CommandItem
                key={item.key}
                value={item.key}
                onSelect={() => choose(item)}
              >
                {item.dot && <StatusDot tone={item.dot} />}
                <span className="truncate">{item.label}</span>
                {item.hint && (
                  <CommandShortcut className="max-w-1/2 truncate tracking-normal">
                    {item.hint}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
};
