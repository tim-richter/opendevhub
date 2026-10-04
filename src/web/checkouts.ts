import type { ProjectView, SessionSummary, Worktree } from "../shared/types";
import { needsAttention, type Tone, workspaceFolderOf } from "./derive";

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

export type CheckoutTab = "review" | "ports" | "logs";

const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** The main checkout first, then the worktrees in the order git lists them. */
export function checkouts(view: ProjectView): Checkout[] {
  return [
    { target: "", label: "Main checkout", directory: workspaceFolderOf(view), hostPath: view.project.path },
    ...(view.runtime.worktrees ?? []).map((w) => ({
      target: folderName(w.path),
      label: w.branch ?? folderName(w.path),
      directory: w.path,
      hostPath: w.hostPath,
      worktree: w,
    })),
  ];
}

export function checkoutOf(view: ProjectView, directory: string): Checkout | undefined {
  return checkouts(view).find((c) => c.directory === directory);
}

/** `main` for the main checkout and `w/<folder>` for a worktree, so a worktree named "main" can't clash. */
export function checkoutPath(projectId: string, target: string, tab?: CheckoutTab): string {
  const base = `/p/${encodeURIComponent(projectId)}/${target ? `w/${encodeURIComponent(target)}` : "main"}`;
  return tab ? `${base}/${tab}` : base;
}

/** Where a session lives: its checkout's Sessions tab, or the project overview when the checkout is unknown. */
export function sessionPath(view: ProjectView, session: SessionSummary): string {
  const c = checkoutOf(view, session.directory);
  const base = c ? checkoutPath(view.project.id, c.target) : `/p/${encodeURIComponent(view.project.id)}`;
  return `${base}?session=${encodeURIComponent(session.id)}`;
}

/** Sessions in no known checkout, e.g. one whose worktree was removed. */
export function orphanSessions(view: ProjectView): SessionSummary[] {
  const dirs = new Set(checkouts(view).map((c) => c.directory));
  return view.sessions.filter((s) => !dirs.has(s.directory));
}

export function checkoutCounts(view: ProjectView, directory: string): { attention: number; running: number; idle: number } {
  const counts = { attention: 0, running: 0, idle: 0 };
  for (const s of view.sessions) {
    if (s.directory !== directory) continue;
    if (needsAttention(s.status)) counts.attention++;
    else if (s.status === "running") counts.running++;
    else counts.idle++;
  }
  return counts;
}

/** Like projectTone, but from one checkout's sessions; the container state is shared. */
export function checkoutTone(view: ProjectView, directory: string): Tone {
  const c = checkoutCounts(view, directory);
  if (c.attention > 0) return "attention";
  if (c.running > 0) return "running";
  return view.runtime.containerState === "running" ? "ok" : "off";
}

export interface ProjectTask {
  task: string;
  title: string;
  /** Variants still listed; some may have been discarded. */
  variants: number;
  attention: boolean;
  running: boolean;
  updatedAt: number;
}

/** Tasks with several variants (they span worktrees, so they live at project level), most recent first. */
export function projectTasks(view: ProjectView): ProjectTask[] {
  const out = new Map<string, ProjectTask>();
  for (const s of view.sessions) {
    if (!s.task || s.task.of < 2) continue;
    const t = out.get(s.task.task) ?? { task: s.task.task, title: s.task.title, variants: 0, attention: false, running: false, updatedAt: 0 };
    t.variants++;
    t.attention ||= needsAttention(s.status);
    t.running ||= s.status === "running";
    t.updatedAt = Math.max(t.updatedAt, s.updatedAt);
    out.set(t.task, t);
  }
  return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Where the project tabs of earlier versions went. */
export function legacyPath(projectId: string, tab: "review" | "ports" | "logs" | "worktrees", target = ""): string {
  return tab === "worktrees" ? `/p/${encodeURIComponent(projectId)}` : checkoutPath(projectId, target, tab);
}
