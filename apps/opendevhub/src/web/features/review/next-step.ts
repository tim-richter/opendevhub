import type { ReviewData } from "../../../shared/types";

/** Why a git action can't run right now; undefined when it can. */
export interface GitBlockers {
  commit?: string;
  update?: string;
  merge?: string;
  branch?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What stops each git action, in words for the person. Without data, everything waits for it to load. */
export const gitBlockers = (
  data: ReviewData | undefined,
  options: { isWorktree: boolean; baseName?: string }
): GitBlockers => {
  if (!data) {
    return {
      branch: "Loading…",
      commit: "Loading…",
      merge: "Loading…",
      update: "Loading…",
    };
  }
  const { baseName, isWorktree } = options;
  const blockers: GitBlockers = {};
  if (!data.dirty) {
    blockers.commit = "No uncommitted changes";
  }
  if (!baseName || !data.branch) {
    blockers.update = "No base branch";
  } else if (data.dirty) {
    blockers.update = "Commit the changes first";
  } else if (data.behind === 0) {
    blockers.update = `Already up to date with ${baseName}`;
  }
  if (isWorktree) {
    blockers.branch =
      "A worktree stays on its own branch; start a new task to branch off";
  }
  if (!isWorktree) {
    blockers.merge = "The main checkout is the base";
  } else if (data.ahead === 0) {
    blockers.merge = "Nothing to merge";
  } else if (data.dirty) {
    blockers.merge = "Commit the changes first";
  } else if (!data.workspace.clean) {
    blockers.merge = "The main checkout has uncommitted changes";
  } else if (data.workspace.branch !== baseName) {
    blockers.merge = `The main checkout is on ${data.workspace.branch ?? "a detached HEAD"}, not ${baseName}`;
  }
  return blockers;
};

export type StepKind = "commit" | "update" | "publish" | "done";

export interface Step {
  kind: StepKind;
  title: string;
  detail?: string;
}

/**
 * The one thing to do next with a checkout, in the order work usually goes: commit what changed, catch up with
 * the base, then publish. The page offers it as its main button; everything else sits in a menu.
 */
export const nextStep = (
  data: ReviewData,
  options: { baseName?: string; hasPullRequest: boolean }
): Step => {
  const { baseName, hasPullRequest } = options;
  if (data.dirty) {
    return {
      detail: "Keep the changes that belong together, then commit them.",
      kind: "commit",
      title: "Commit your changes",
    };
  }
  const comparable = !!baseName && !!data.branch && data.branch !== baseName;
  if (comparable && data.behind > 0) {
    return {
      detail: `${baseName} has ${plural(data.behind, "new commit")} this branch doesn't.`,
      kind: "update",
      title: `Update from ${baseName}`,
    };
  }
  if (comparable && data.ahead > 0) {
    return {
      detail: `${plural(data.ahead, "commit")} ahead of ${baseName}.`,
      kind: "publish",
      title: hasPullRequest ? "Update the pull request" : "Publish this branch",
    };
  }
  return {
    detail: "Nothing to commit, publish or merge.",
    kind: "done",
    title: "Up to date",
  };
};
