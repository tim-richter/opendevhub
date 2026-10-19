import type {
  ConfigApprovalChange,
  NodeId,
  PendingConfigApproval,
  ProjectView,
} from "../../../shared/types";

/** What each host-affecting setting is, for the review. */
const KEY_LABELS: Record<string, string> = {
  appPort: "Published ports (appPort)",
  buildContext: "Build context",
  buildOptions: "Build options",
  capAdd: "Added capabilities (capAdd)",
  dockerComposeFile: "Docker Compose files",
  features: "Features (their metadata couldn't be read)",
  initializeCommand: "Command on the host (initializeCommand)",
  mounts: "Mounts",
  privileged: "Privileged container",
  runArgs: "docker run arguments (runArgs)",
  runServices: "Compose services to start",
  securityOpt: "Security options (securityOpt)",
  service: "Compose service",
  workspaceMount: "Workspace mount",
};

export const settingLabel = (key: string): string => KEY_LABELS[key] ?? key;

/** The settings that differ from the closest approval. */
export const changedSettings = (
  approval: PendingConfigApproval
): ConfigApprovalChange[] =>
  approval.changes.filter((c) => c.kind !== "unchanged");

/** One line naming what changed, for a banner. */
export const approvalSummary = (approval: PendingConfigApproval): string => {
  const keys = changedSettings(approval).map((c) => settingLabel(c.key));
  return keys.join(", ");
};

/** The pending approval that blocks the project's main container, if any. */
export const mainApproval = (
  view: ProjectView
): PendingConfigApproval | undefined =>
  view.approvals?.find((a) => a.sources.some((s) => s.kind === "main"));

/** The pending approval that blocks a worktree's container, by its branch and node. */
export const worktreeApproval = (
  view: ProjectView,
  branch: string | undefined,
  node: NodeId | undefined
): PendingConfigApproval | undefined =>
  branch === undefined
    ? undefined
    : view.approvals?.find((a) =>
        a.sources.some(
          (s) =>
            s.kind === "worktree" &&
            s.branch === branch &&
            (node === undefined || s.node === node)
        )
      );

/** Where a pending approval comes from, for the review: the main checkout, or each worktree's branch and node. */
export const sourceLabels = (approval: PendingConfigApproval): string[] =>
  approval.sources.map((s) => {
    if (s.kind === "main") {
      return "the main checkout";
    }
    return s.node === "local"
      ? `worktree ${s.branch}`
      : `worktree ${s.branch} on ${s.node}`;
  });

/** A setting's value as the review prints it. */
export const formatValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** A line diff (longest common subsequence), for Compose files. */
export const lineDiff = (before: string, after: string): DiffLine[] => {
  const a = before === "" ? [] : before.replace(/\n$/u, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/u, "").split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  for (; i < a.length; i++) {
    out.push({ kind: "removed", text: a[i] });
  }
  for (; j < b.length; j++) {
    out.push({ kind: "added", text: b[j] });
  }
  return out;
};

/** Compose files by path, before and after; a file only on one side counts as empty on the other. */
export const composeFileDiffs = (
  change: ConfigApprovalChange
): { path: string; lines: DiffLine[] }[] => {
  const before = (change.before ?? {}) as Record<string, string | null>;
  const after = (change.after ?? {}) as Record<string, string | null>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .toSorted()
    .map((file) => ({
      lines: lineDiff(before[file] ?? "", after[file] ?? ""),
      path: file,
    }));
};
