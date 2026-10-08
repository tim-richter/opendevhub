import { modelShortName } from "../shared/tasks";
import type {
  ProjectView,
  ReviewData,
  ReviewFile,
  SessionSummary,
  StartStep,
  TaskResult,
} from "../shared/types";
import { workspaceFolderOf } from "./derive";

/** The task's sessions in variant order. Discarded variants never reach the dashboard. */
export const taskSessions = (
  view: ProjectView,
  task: string
): SessionSummary[] =>
  view.sessions
    .filter((s) => s.task?.task === task)
    .toSorted((a, b) => (a.task?.variant ?? 0) - (b.task?.variant ?? 0));

/** A variant's short name: its model, or its number. */
export const variantName = (session: SessionSummary): string =>
  session.model
    ? modelShortName(session.model)
    : `#${session.task?.variant ?? 1}`;

export const formatCost = (usd: number | undefined): string => {
  if (usd === undefined) {
    return "—";
  }
  if (usd > 0 && usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
};

export const formatTokens = (n: number | undefined): string => {
  if (n === undefined) {
    return "—";
  }
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
};

/** Where to go after starting a task: the session for one variant, the task page for several; nowhere if none started. */
export const taskDestination = (
  projectId: string,
  result: TaskResult
): string | undefined => {
  const sessionId = result.variants.find((v) => v.sessionId)?.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const base = `/p/${encodeURIComponent(projectId)}`;
  if (result.variants.length === 1) {
    return `${base}?session=${encodeURIComponent(sessionId)}`;
  }
  return `${base}/t/${encodeURIComponent(result.task)}`;
};

/** The variants that failed, as one line for the error banner. */
export const taskFailures = (result: TaskResult): string | undefined => {
  const lines = result.variants.flatMap((v, i) =>
    v.error
      ? [`variant ${i + 1}${v.branch ? ` (${v.branch})` : ""}: ${v.error}`]
      : []
  );
  return lines.length > 0 ? lines.join("; ") : undefined;
};

export const diffStats = (
  data: ReviewData
): {
  files: number;
  additions: number;
  deletions: number;
} => {
  const stats = { additions: 0, deletions: 0, files: 0 };
  for (const f of data.files) {
    stats.additions += f.additions;
    stats.deletions += f.deletions;
    stats.files += 1;
  }
  return stats;
};

export interface Removal {
  name: string;
  /** Undefined when the variant's review didn't load, so it's unknown. */
  dirty?: boolean;
  /** The worktree's branch wasn't created by this task, so only the worktree is removed. */
  branchKept?: true;
}

/** The worktrees "Pick this one" would remove (mirrors the server): other variants' worktrees no remaining session uses. */
export const removals = (
  view: ProjectView,
  task: string,
  keep: string,
  dirty: Record<string, boolean>
): Removal[] => {
  const ws = workspaceFolderOf(view);
  const others = taskSessions(view, task).filter((s) => s.id !== keep);
  const inUse = new Set(
    view.sessions.filter((s) => !others.includes(s)).map((s) => s.directory)
  );
  return [...new Set(others.map((s) => s.directory))]
    .filter((d) => d !== ws && !inUse.has(d))
    .flatMap((d) => {
      const worktree = view.runtime.worktrees?.find((w) => w.path === d);
      if (!worktree) {
        return [];
      }
      const ours =
        worktree.branch === undefined ||
        others.some(
          (s) => s.directory === d && s.task?.branch === worktree.branch
        );
      return [
        {
          name: worktree.branch ?? d,
          ...(d in dirty ? { dirty: dirty[d] } : {}),
          ...(ours ? {} : { branchKept: true as const }),
        },
      ];
    });
};

/** The two confirmations of "Pick this one": discard the others, then (optionally) remove their worktrees. */
export const pickPrompts = (
  keepName: string,
  discardCount: number,
  list: Removal[],
  othersRunning = false
): { discard: string; remove?: string } => {
  const one = discardCount === 1;
  const discard = `Keep ${keepName} and discard the other ${one ? "variant" : `${discardCount} variants`}? ${
    one
      ? "It disappears from the dashboard; its session stays"
      : "They disappear from the dashboard; their sessions stay"
  } in opencode.${othersRunning ? " Running variants are stopped." : ""}`;
  if (list.length === 0) {
    return { discard };
  }
  const lines = list
    .map((r) => {
      let dirty;
      if (r.dirty === true) {
        dirty = "has uncommitted changes";
      } else if (r.dirty === undefined) {
        dirty = "may have uncommitted changes";
      } else {
        dirty = "";
      }
      const kept = r.branchKept ? "branch kept (not created by this task)" : "";
      const notes = [dirty, kept].filter(Boolean).join(", ");
      return `• ${r.name}${notes ? ` — ${notes}` : ""}`;
    })
    .join("\n");
  return {
    discard,
    remove: `Also remove their worktrees and delete their branches? Uncommitted changes and unmerged commits are lost.\n\n${lines}\n\nCancel keeps them.`,
  };
};

/** The task chip on a session row; it links to the task page when the task has several variants. */
export const taskChip = (
  view: ProjectView,
  s: SessionSummary
):
  | { label: string; title: string; to?: string; model?: string }
  | undefined => {
  if (!s.task) {
    return undefined;
  }
  const title = `Task: ${s.task.title}`;
  if (s.task.of === 1) {
    return { label: "task", title };
  }
  return {
    label: `task ${s.task.variant}/${s.task.of}`,
    title,
    to: `/p/${encodeURIComponent(view.project.id)}/t/${encodeURIComponent(s.task.task)}`,
    ...(s.model ? { model: modelShortName(s.model) } : {}),
  };
};

/** `n` opens New task, but not while typing somewhere or with a modifier held. */
export const opensNewTask = (e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
}): boolean => {
  if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey) {
    return false;
  }
  const t = e.target as {
    tagName?: string;
    isContentEditable?: boolean;
  } | null;
  if (!t) {
    return true;
  }
  return (
    !t.isContentEditable &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? "")
  );
};

export const projectIdFromPath = (pathname: string): string | undefined => {
  const m = pathname.match(/^\/p\/(?<g1>[^/]+)/u);
  return m ? decodeURIComponent(m[1]) : undefined;
};

/** `<select>` values for models; "" is the project's default. Model ids can contain "/", so encode as JSON. */
export const modelKey = (
  ref: { id: string; providerID: string } | undefined
): string => (ref ? JSON.stringify([ref.providerID, ref.id]) : "");

export const modelFromKey = (
  key: string
): { id: string; providerID: string } | undefined => {
  if (!key) {
    return undefined;
  }
  const [providerID, id] = JSON.parse(key) as [string, string];
  return { id, providerID };
};

const STEP_LABELS: Record<StartStep, string> = {
  container: "Starting the container",
  failed: "Failed",
  image: "Preparing the image",
  pushing: "Pushing the base",
  queued: "Waiting",
  session: "Starting the session",
  worktree: "Creating the worktree",
};

/** What a starting variant is doing, for its card. */
export const startStepLabel = (step: StartStep): string => STEP_LABELS[step];

/** A task's page: its variants, and while they're set up, their progress. */
export const taskPath = (projectId: string, task: string): string =>
  `/p/${encodeURIComponent(projectId)}/t/${encodeURIComponent(task)}`;

export interface FileCell {
  status: ReviewFile["status"];
  additions: number;
  deletions: number;
}

export interface FileRow {
  file: string;
  /** One per variant, in order; undefined when that variant leaves the file alone. */
  cells: (FileCell | undefined)[];
  /** Every variant changes the file the same way (by line counts). */
  same: boolean;
}

/** The files the variants touch, side by side: files they disagree on first, then by path. */
export const fileMatrix = (
  reviews: readonly (ReviewData | null | undefined)[]
): FileRow[] => {
  const files = new Set<string>();
  for (const r of reviews) {
    for (const f of r?.files ?? []) {
      files.add(f.file);
    }
  }
  const rows = [...files].map((file): FileRow => {
    const cells = reviews.map((r) => {
      const f = r?.files.find((x) => x.file === file);
      return f
        ? { additions: f.additions, deletions: f.deletions, status: f.status }
        : undefined;
    });
    const key = (c: FileCell | undefined) =>
      c ? `${c.status}:${c.additions}:${c.deletions}` : "-";
    return {
      cells,
      file,
      same: cells.every((c) => key(c) === key(cells[0])),
    };
  });
  return rows.toSorted(
    (a, b) => Number(a.same) - Number(b.same) || a.file.localeCompare(b.file)
  );
};
