import type {
  ProjectView,
  PublicRuntime,
  SessionSummary,
  Worktree,
} from "../shared/types";
import {
  envOfDirectory,
  envTone,
  needsAttention,
  workspaceFolderOf,
} from "./derive";
import type { Tone } from "./derive";

/** A place a project is checked out: the main checkout or one of its worktrees. */
export interface Checkout {
  /** "" for the main checkout, else the worktree's folder name (also its URL segment). */
  target: string;
  label: string;
  /** Path inside the container. */
  directory: string;
  /** Same checkout on this machine, when there is one. */
  hostPath?: string;
  worktree?: Worktree;
}

export type CheckoutTab = "review" | "runtime";

const folderName = (path: string) => path.split("/").findLast(Boolean) ?? path;

/** The main checkout first, then the worktrees in the order git lists them. */
export const checkouts = (view: ProjectView): Checkout[] => [
  {
    directory: workspaceFolderOf(view),
    hostPath: view.project.path,
    label: "Main checkout",
    target: "",
  },
  ...(view.runtime.worktrees ?? []).map((w) => ({
    directory: w.path,
    hostPath: w.hostPath,
    label: w.branch ?? folderName(w.path),
    target: folderName(w.path),
    worktree: w,
  })),
];

export const checkoutOf = (
  view: ProjectView,
  directory: string
): Checkout | undefined =>
  checkouts(view).find((c) => c.directory === directory);

/** `main` for the main checkout and `w/<folder>` for a worktree, so a worktree named "main" can't clash. */
export const checkoutPath = (
  projectId: string,
  target: string,
  tab?: CheckoutTab
): string => {
  const base = `/p/${encodeURIComponent(projectId)}/${target ? `w/${encodeURIComponent(target)}` : "main"}`;
  return tab ? `${base}/${tab}` : base;
};

/** A session's own page in its checkout. */
export const sessionPagePath = (
  projectId: string,
  target: string,
  sessionId: string
): string =>
  `${checkoutPath(projectId, target)}/s/${encodeURIComponent(sessionId)}`;

/** Where a session lives: its page in its checkout, or the project overview when the checkout is unknown. */
export const sessionPath = (
  view: ProjectView,
  session: SessionSummary
): string => {
  const c = checkoutOf(view, session.directory);
  return c
    ? sessionPagePath(view.project.id, c.target, session.id)
    : `/p/${encodeURIComponent(view.project.id)}?session=${encodeURIComponent(session.id)}`;
};

/** Sessions in no known checkout, e.g. one whose worktree was removed. */
export const orphanSessions = (view: ProjectView): SessionSummary[] => {
  const dirs = new Set(checkouts(view).map((c) => c.directory));
  return view.sessions.filter((s) => !dirs.has(s.directory));
};

export const checkoutCounts = (
  view: ProjectView,
  directory: string
): { attention: number; running: number; idle: number } => {
  const counts = { attention: 0, idle: 0, running: 0 };
  for (const s of view.sessions) {
    if (s.directory !== directory) {
      continue;
    }
    if (needsAttention(s.status)) {
      counts.attention += 1;
    } else if (s.status === "running") {
      counts.running += 1;
    } else {
      counts.idle += 1;
    }
  }
  return counts;
};

/** The container a checkout runs in: its own when it has one, else the project's. */
export const checkoutRuntime = (
  view: ProjectView,
  directory: string
): PublicRuntime => envOfDirectory(view, directory)?.runtime ?? view.runtime;

/** Like projectTone, but from one checkout's sessions and the container it runs in. */
export const checkoutTone = (view: ProjectView, directory: string): Tone => {
  const c = checkoutCounts(view, directory);
  if (c.attention > 0) {
    return "attention";
  }
  if (c.running > 0) {
    return "running";
  }
  const env = envOfDirectory(view, directory);
  if (env) {
    return envTone(env);
  }
  return view.runtime.containerState === "running" ? "ok" : "off";
};

export interface ProjectTask {
  task: string;
  title: string;
  /** Variants still listed; some may have been discarded. */
  variants: number;
  attention: boolean;
  running: boolean;
  updatedAt: number;
  /** Some variants are still being set up. */
  starting?: true;
}

/**
 * Tasks with several variants (they span worktrees, so they live at project level), and tasks still being set
 * up, most recent first.
 */
export const projectTasks = (view: ProjectView): ProjectTask[] => {
  const out = new Map<string, ProjectTask>();
  for (const s of view.sessions) {
    if (!s.task || s.task.of < 2) {
      continue;
    }
    const t = out.get(s.task.task) ?? {
      attention: false,
      running: false,
      task: s.task.task,
      title: s.task.title,
      updatedAt: 0,
      variants: 0,
    };
    t.variants += 1;
    t.attention ||= needsAttention(s.status);
    t.running ||= s.status === "running";
    t.updatedAt = Math.max(t.updatedAt, s.updatedAt);
    out.set(t.task, t);
  }
  for (const s of view.starting ?? []) {
    const t = out.get(s.task) ?? {
      attention: false,
      running: false,
      task: s.task,
      title: s.title,
      updatedAt: s.createdAt,
      variants: 0,
    };
    t.variants = Math.max(t.variants, s.of);
    t.attention ||= s.variants.some((v) => v.step === "failed");
    t.running ||= s.variants.some((v) => v.step !== "failed");
    t.starting = true;
    out.set(t.task, t);
  }
  return [...out.values()].toSorted((a, b) => b.updatedAt - a.updatedAt);
};

/** Where the project tabs of earlier versions went. */
export const legacyPath = (
  projectId: string,
  tab: "review" | "ports" | "logs" | "worktrees",
  target = ""
): string => {
  if (tab === "worktrees") {
    return `/p/${encodeURIComponent(projectId)}`;
  }
  return checkoutPath(
    projectId,
    target,
    tab === "review" ? "review" : "runtime"
  );
};
