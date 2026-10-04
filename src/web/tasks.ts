import { modelShortName } from "../shared/tasks";
import type { ProjectView, ReviewData, SessionSummary, TaskResult } from "../shared/types";
import { workspaceFolderOf } from "./derive";

/** The task's sessions in variant order. Discarded variants never reach the dashboard. */
export function taskSessions(view: ProjectView, task: string): SessionSummary[] {
  return view.sessions.filter((s) => s.task?.task === task).sort((a, b) => (a.task?.variant ?? 0) - (b.task?.variant ?? 0));
}

/** A variant's short name: its model, or its number. */
export function variantName(session: SessionSummary): string {
  return session.model ? modelShortName(session.model) : `#${session.task?.variant ?? 1}`;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Where to go after starting a task: the session for one variant, the task page for several; nowhere if none started. */
export function taskDestination(projectId: string, result: TaskResult): string | undefined {
  const started = result.variants.filter((v) => v.sessionId);
  if (started.length === 0) return undefined;
  const base = `/p/${encodeURIComponent(projectId)}`;
  if (result.variants.length === 1) return `${base}?session=${encodeURIComponent(started[0].sessionId!)}`;
  return `${base}/t/${encodeURIComponent(result.task)}`;
}

/** The variants that failed, as one line for the error banner. */
export function taskFailures(result: TaskResult): string | undefined {
  const lines = result.variants.flatMap((v, i) => (v.error ? [`variant ${i + 1}${v.branch ? ` (${v.branch})` : ""}: ${v.error}`] : []));
  return lines.length > 0 ? lines.join("; ") : undefined;
}

export function diffStats(data: ReviewData): { files: number; additions: number; deletions: number } {
  return data.files.reduce(
    (s, f) => ({ files: s.files + 1, additions: s.additions + f.additions, deletions: s.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export interface Removal {
  name: string;
  /** Undefined when the variant's review didn't load, so it's unknown. */
  dirty?: boolean;
}

/** The worktrees "Pick this one" would remove (mirrors the server): other variants' worktrees no remaining session uses. */
export function removals(view: ProjectView, task: string, keep: string, dirty: Record<string, boolean>): Removal[] {
  const ws = workspaceFolderOf(view);
  const others = taskSessions(view, task).filter((s) => s.id !== keep);
  const inUse = new Set(view.sessions.filter((s) => !others.includes(s)).map((s) => s.directory));
  return [...new Set(others.map((s) => s.directory))]
    .filter((d) => d !== ws && !inUse.has(d))
    .flatMap((d) => {
      const worktree = view.runtime.worktrees?.find((w) => w.path === d);
      if (!worktree) return [];
      return [{ name: worktree.branch ?? d, ...(d in dirty ? { dirty: dirty[d] } : {}) }];
    });
}

/** The two confirmations of "Pick this one": discard the others, then (optionally) remove their worktrees. */
export function pickPrompts(keepName: string, discardCount: number, list: Removal[]): { discard: string; remove?: string } {
  const one = discardCount === 1;
  const discard = `Keep ${keepName} and discard the other ${one ? "variant" : `${discardCount} variants`}? ${
    one ? "It disappears from the dashboard; its session stays" : "They disappear from the dashboard; their sessions stay"
  } in opencode.`;
  if (list.length === 0) return { discard };
  const lines = list
    .map((r) => `• ${r.name}${r.dirty === true ? " — has uncommitted changes" : r.dirty === undefined ? " — may have uncommitted changes" : ""}`)
    .join("\n");
  return {
    discard,
    remove: `Also remove their worktrees and delete their branches? Uncommitted changes and unmerged commits are lost.\n\n${lines}\n\nCancel keeps them.`,
  };
}

/** The task chip on a session row; it links to the task page when the task has several variants. */
export function taskChip(view: ProjectView, s: SessionSummary): { label: string; title: string; to?: string; model?: string } | undefined {
  if (!s.task) return undefined;
  const title = `Task: ${s.task.title}`;
  if (s.task.of === 1) return { label: "task", title };
  return {
    label: `task ${s.task.variant}/${s.task.of}`,
    title,
    to: `/p/${encodeURIComponent(view.project.id)}/t/${encodeURIComponent(s.task.task)}`,
    ...(s.model ? { model: modelShortName(s.model) } : {}),
  };
}

/** `n` opens New task, but not while typing somewhere or with a modifier held. */
export function opensNewTask(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }): boolean {
  if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!t) return true;
  return !t.isContentEditable && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? "");
}

export function projectIdFromPath(pathname: string): string | undefined {
  const m = pathname.match(/^\/p\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** `<select>` values for models; "" is the project's default. Model ids can contain "/", so encode as JSON. */
export function modelKey(ref: { id: string; providerID: string } | undefined): string {
  return ref ? JSON.stringify([ref.providerID, ref.id]) : "";
}

export function modelFromKey(key: string): { id: string; providerID: string } | undefined {
  if (!key) return undefined;
  const [providerID, id] = JSON.parse(key) as [string, string];
  return { id, providerID };
}
