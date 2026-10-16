import type {
  CheckDef,
  CheckResult,
  CheckRun,
  ChecksView,
} from "../../../shared/types";

/** What the Checks button shows for a checkout. */
export type ChecksState =
  | "none"
  | "idle"
  | "stale"
  | "running"
  | "passed"
  | "failed";

export const isRunning = (run: CheckRun | undefined): boolean =>
  !!run && !run.finishedAt;

export const checksState = (view: ChecksView | undefined): ChecksState => {
  if (!view || view.checks.length === 0) {
    return "none";
  }
  const { run } = view;
  if (isRunning(run)) {
    return "running";
  }
  if (!run) {
    return "idle";
  }
  if (!view.current) {
    return "stale";
  }
  if (run.results.some((r) => r.status === "failed" || r.status === "error")) {
    return "failed";
  }
  const passed = (c: CheckDef) =>
    run.results.some(
      (r) =>
        r.name === c.name &&
        r.command === c.command &&
        r.where === c.where &&
        r.status === "passed"
    );
  return view.checks.every(passed) ? "passed" : "idle";
};

export const STATE_LABEL: Record<ChecksState, string> = {
  failed: "Checks failed",
  idle: "Checks haven't run on this commit",
  none: "No checks",
  passed: "All checks passed",
  running: "Checks are running",
  stale: "Checks ran on a different commit",
};

export const failedNames = (run: CheckRun | undefined): string[] =>
  (run?.results ?? [])
    .filter((r) => r.status === "failed" || r.status === "error")
    .map((r) => r.name);

/** What the Publish dialog warns about; undefined when there are no checks or they all passed here. */
export const publishWarning = (
  view: ChecksView | undefined
): string | undefined => {
  const state = checksState(view);
  if (state === "none" || state === "passed") {
    return undefined;
  }
  if (state === "failed") {
    return `Checks failed on this commit: ${failedNames(view?.run).join(", ")}.`;
  }
  if (state === "stale") {
    return "The last checks ran on a different commit or with other uncommitted changes.";
  }
  return `${STATE_LABEL[state]}.`;
};

/** The host checks among those about to run whose command hasn't been approved. */
export const needingApproval = (
  view: ChecksView,
  names?: string[]
): CheckDef[] =>
  view.checks.filter((c) => !c.approved && (!names || names.includes(c.name)));

/** Folds a polled run into the view, keeping `current` until the full view is fetched again. */
export const withRun = (
  view: ChecksView,
  run: CheckRun | undefined
): ChecksView => (run ? { ...view, run } : view);

/** A check's result in a run: the one for its exact name, command and place. */
export const resultOf = (
  run: CheckRun | undefined,
  c: CheckDef
): CheckResult | undefined =>
  run?.results.find(
    (r) => r.name === c.name && r.command === c.command && r.where === c.where
  );

/** Checks in their sections: the ungrouped ones first, then each group where it first appears. */
export const checkSections = <T extends CheckDef>(
  checks: T[]
): { group?: string; checks: T[] }[] => {
  const loose = checks.filter((c) => !c.group);
  const groups = new Map<string, T[]>();
  for (const c of checks) {
    if (c.group) {
      groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    }
  }
  return [
    ...(loose.length > 0 ? [{ checks: loose }] : []),
    ...[...groups].map(([group, members]) => ({ checks: members, group })),
  ];
};

/** Where a group of checks stands in a run, and how many of them passed. */
export const groupState = (
  run: CheckRun | undefined,
  checks: CheckDef[]
): { state: Exclude<ChecksState, "none" | "stale">; passed: number } => {
  const results = checks.map((c) => resultOf(run, c));
  const passed = results.filter((r) => r?.status === "passed").length;
  let state: Exclude<ChecksState, "none" | "stale"> = "idle";
  if (results.some((r) => r?.status === "queued" || r?.status === "running")) {
    state = "running";
  } else if (
    results.some((r) => r?.status === "failed" || r?.status === "error")
  ) {
    state = "failed";
  } else if (passed === checks.length) {
    state = "passed";
  }
  return { passed, state };
};

export const formatDuration = (ms: number): string => {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  if (ms < 120_000) {
    return `${Math.round(ms / 1000)} s`;
  }
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};

const PROMPT_LINES = 80;

/** Asks the agent to fix the failed checks, with the end of their output. */
export const fixPrompt = (o: {
  branch?: string;
  results: CheckResult[];
}): string => {
  const failed = o.results.filter(
    (r) => r.status === "failed" || r.status === "error"
  );
  const parts = failed.map((r) => {
    let why;
    if (r.status === "error") {
      why = `could not run: ${r.reason ?? "unknown error"}`;
    } else if (r.timedOut) {
      why = "timed out";
    } else {
      why = `failed with exit code ${r.exitCode}`;
    }
    const where =
      r.where === "host" ? " (runs on the host, outside your container)" : "";
    const output = r.output.slice(-PROMPT_LINES).join("\n");
    return `### ${r.name}: \`${r.command}\`${where} ${why}\n\n${output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)"}`;
  });
  return [
    `These project checks failed${o.branch ? ` on ${o.branch}` : ""}. Fix the cause, run the checks you can run yourself to confirm, commit, and reply with what you changed.`,
    ...parts,
  ].join("\n\n");
};
