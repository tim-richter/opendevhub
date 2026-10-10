import type {
  BranchCleanupItem,
  CleanupItem,
  CleanupPlan,
  CleanupProject,
} from "../../../shared/types";
import { formatMemory } from "../../lib/resources";

/** What the scan selects by default. */
export const initialSelection = (plan: CleanupPlan): Set<string> =>
  new Set(plan.items.filter((i) => i.checked).map((i) => i.id));

/** Rows the scan left unchecked: a dirty worktree, an upstream-gone branch, a running container, an idle session. */
export const isRisky = (item: CleanupItem): boolean => !item.checked;

/** Select-all or none for one kind; risky rows keep whatever the user chose. */
export const toggleAll = (
  plan: CleanupPlan,
  selected: Set<string>,
  kind: CleanupItem["kind"],
  on: boolean
): Set<string> => {
  const next = new Set(selected);
  for (const item of plan.items) {
    if (item.kind !== kind || isRisky(item)) {
      continue;
    }
    if (on) {
      next.add(item.id);
    } else {
      next.delete(item.id);
    }
  }
  return next;
};

const count = (n: number, one: string, many: string): string | undefined =>
  n === 0 ? undefined : `${n} ${n === 1 ? one : many}`;

/** "4 branches, 1 session, 2 containers, 3 images · 3.1 GiB". */
export const selectionSummary = (
  plan: CleanupPlan,
  selected: Set<string>
): string => {
  const chosen = plan.items.filter((i) => selected.has(i.id));
  if (chosen.length === 0) {
    return "Nothing selected";
  }
  const of = (kind: CleanupItem["kind"]) =>
    chosen.filter((i) => i.kind === kind).length;
  const parts = [
    count(of("branch"), "branch", "branches"),
    count(of("session"), "session", "sessions"),
    count(of("task"), "task to archive", "tasks to archive"),
    count(of("container"), "container", "containers"),
    count(of("image"), "image", "images"),
  ]
    .filter(Boolean)
    .join(", ");
  const bytes = chosen.reduce(
    (n, i) => n + (i.kind === "image" ? i.bytes : 0),
    0
  );
  return bytes > 0 ? `${parts} · ${formatMemory(bytes)}` : parts;
};

/** One line per selected risky item, for the confirmation. */
export const riskyNotes = (
  plan: CleanupPlan,
  selected: Set<string>
): string[] =>
  plan.items
    .filter((i) => selected.has(i.id) && isRisky(i))
    .map((i) => {
      if (i.kind === "branch" && i.dirty) {
        return `discards uncommitted changes in ${i.worktree?.split("/").at(-1) ?? i.branch}`;
      }
      if (i.kind === "branch") {
        return `deletes ${i.branch}, whose upstream is gone but which may not be merged`;
      }
      if (i.kind === "container") {
        return `stops and removes the running container ${i.name ?? i.containerId}`;
      }
      if (i.kind === "session") {
        return `deletes the session ${i.title}, ${i.reason}`;
      }
      if (i.kind === "task") {
        return `archives the task ${i.title}`;
      }
      return `removes ${i.ref}`;
    });

/** Every scanned project with its branch items, in the plan's project order. */
export const branchGroups = (
  plan: CleanupPlan
): { project: CleanupProject; items: BranchCleanupItem[] }[] =>
  plan.projects.map((project) => ({
    items: plan.items.filter(
      (i): i is BranchCleanupItem =>
        i.kind === "branch" && i.projectId === project.id
    ),
    project,
  }));
