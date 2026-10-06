import type { CheckDef, CheckResult, CheckRun, ChecksView } from "../shared/types";

/** What the Checks button shows for a checkout. */
export type ChecksState = "none" | "idle" | "stale" | "running" | "passed" | "failed";

export function isRunning(run: CheckRun | undefined): boolean {
  return !!run && !run.finishedAt;
}

export function checksState(view: ChecksView | undefined): ChecksState {
  if (!view || view.checks.length === 0) return "none";
  const { run } = view;
  if (isRunning(run)) return "running";
  if (!run) return "idle";
  if (!view.current) return "stale";
  if (run.results.some((r) => r.status === "failed" || r.status === "error")) return "failed";
  const passed = (c: CheckDef) => run.results.some((r) => r.name === c.name && r.command === c.command && r.where === c.where && r.status === "passed");
  return view.checks.every(passed) ? "passed" : "idle";
}

export const STATE_LABEL: Record<ChecksState, string> = {
  none: "No checks",
  idle: "Checks haven't run on this commit",
  stale: "Checks ran on a different commit",
  running: "Checks are running",
  passed: "All checks passed",
  failed: "Checks failed",
};

export function failedNames(run: CheckRun | undefined): string[] {
  return (run?.results ?? []).filter((r) => r.status === "failed" || r.status === "error").map((r) => r.name);
}

/** What the Publish dialog warns about; undefined when there are no checks or they all passed here. */
export function publishWarning(view: ChecksView | undefined): string | undefined {
  const state = checksState(view);
  if (state === "none" || state === "passed") return undefined;
  if (state === "failed") return `Checks failed on this commit: ${failedNames(view?.run).join(", ")}.`;
  if (state === "stale") return "The last checks ran on a different commit or with other uncommitted changes.";
  return `${STATE_LABEL[state]}.`;
}

/** The host checks among those about to run whose command hasn't been approved. */
export function needingApproval(view: ChecksView, names?: string[]): CheckDef[] {
  return view.checks.filter((c) => !c.approved && (!names || names.includes(c.name)));
}

/** Folds a polled run into the view, keeping `current` until the full view is fetched again. */
export function withRun(view: ChecksView, run: CheckRun | undefined): ChecksView {
  return run ? { ...view, run } : view;
}

export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

const PROMPT_LINES = 80;

/** Asks the agent to fix the failed checks, with the end of their output. */
export function fixPrompt(o: { branch?: string; results: CheckResult[] }): string {
  const failed = o.results.filter((r) => r.status === "failed" || r.status === "error");
  const parts = failed.map((r) => {
    const why = r.status === "error" ? `could not run: ${r.reason ?? "unknown error"}` : r.timedOut ? "timed out" : `failed with exit code ${r.exitCode}`;
    const where = r.where === "host" ? " (runs on the host, outside your container)" : "";
    const output = r.output.slice(-PROMPT_LINES).join("\n");
    return `### ${r.name}: \`${r.command}\`${where} ${why}\n\n${output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)"}`;
  });
  return [
    `These project checks failed${o.branch ? ` on ${o.branch}` : ""}. Fix the cause, run the checks you can run yourself to confirm, commit, and reply with what you changed.`,
    ...parts,
  ].join("\n\n");
}
