import type { BranchCleanupItem, CleanupItem, CleanupPlan, CleanupProject } from "../shared/types";
import { formatMemory } from "./resources";

/** What the scan selects by default. */
export function initialSelection(plan: CleanupPlan): Set<string> {
  return new Set(plan.items.filter((i) => i.checked).map((i) => i.id));
}

/** Rows the scan left unchecked: a dirty worktree, an upstream-gone branch, a running container, an idle session. */
export function isRisky(item: CleanupItem): boolean {
  return !item.checked;
}

/** Select-all or none for one kind; risky rows keep whatever the user chose. */
export function toggleAll(plan: CleanupPlan, selected: Set<string>, kind: CleanupItem["kind"], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const item of plan.items) {
    if (item.kind !== kind || isRisky(item)) continue;
    if (on) next.add(item.id);
    else next.delete(item.id);
  }
  return next;
}

function count(n: number, one: string, many: string): string | undefined {
  return n === 0 ? undefined : `${n} ${n === 1 ? one : many}`;
}

/** "4 branches, 1 session, 2 containers, 3 images · 3.1 GiB". */
export function selectionSummary(plan: CleanupPlan, selected: Set<string>): string {
  const chosen = plan.items.filter((i) => selected.has(i.id));
  if (chosen.length === 0) return "Nothing selected";
  const of = (kind: CleanupItem["kind"]) => chosen.filter((i) => i.kind === kind).length;
  const parts = [
    count(of("branch"), "branch", "branches"),
    count(of("session"), "session", "sessions"),
    count(of("container"), "container", "containers"),
    count(of("image"), "image", "images"),
  ]
    .filter(Boolean)
    .join(", ");
  const bytes = chosen.reduce((n, i) => n + (i.kind === "image" ? i.bytes : 0), 0);
  return bytes > 0 ? `${parts} · ${formatMemory(bytes)}` : parts;
}

/** One line per selected risky item, for the confirmation. */
export function riskyNotes(plan: CleanupPlan, selected: Set<string>): string[] {
  return plan.items
    .filter((i) => selected.has(i.id) && isRisky(i))
    .map((i) => {
      if (i.kind === "branch" && i.dirty) return `discards uncommitted changes in ${i.worktree?.split("/").at(-1) ?? i.branch}`;
      if (i.kind === "branch") return `deletes ${i.branch}, whose upstream is gone but which may not be merged`;
      if (i.kind === "container") return `stops and removes the running container ${i.name ?? i.containerId}`;
      if (i.kind === "session") return `deletes the session ${i.title}, ${i.reason}`;
      return `removes ${i.ref}`;
    });
}

/** Every scanned project with its branch items, in the plan's project order. */
export function branchGroups(plan: CleanupPlan): { project: CleanupProject; items: BranchCleanupItem[] }[] {
  return plan.projects.map((project) => ({
    project,
    items: plan.items.filter((i): i is BranchCleanupItem => i.kind === "branch" && i.projectId === project.id),
  }));
}
