import { describe, expect, it } from "vitest";

import type { ReviewData } from "../../../../src/shared/types";
import {
  gitBlockers,
  nextStep,
} from "../../../../src/web/features/review/next-step";

const data: ReviewData = {
  ahead: 0,
  behind: 0,
  branch: "feature",
  dirty: false,
  directory: "/work",
  files: [],
  mode: "working",
  pushed: false,
  workspace: { branch: "main", clean: true },
};
const options = { baseName: "main", hasPullRequest: false };

describe(nextStep, () => {
  it("commits first when there are uncommitted changes", () => {
    expect(
      nextStep({ ...data, ahead: 2, behind: 1, dirty: true }, options).kind
    ).toBe("commit");
  });

  it("updates from the base before publishing", () => {
    const step = nextStep({ ...data, ahead: 2, behind: 3 }, options);
    expect(step).toMatchObject({ kind: "update", title: "Update from main" });
    expect(step.detail).toContain("3 new commits");
  });

  it("publishes a branch that is ahead", () => {
    expect(nextStep({ ...data, ahead: 1 }, options)).toMatchObject({
      detail: "1 commit ahead of main.",
      kind: "publish",
      title: "Publish this branch",
    });
  });

  it("updates the pull request when there is one", () => {
    expect(
      nextStep({ ...data, ahead: 1 }, { ...options, hasPullRequest: true })
        .title
    ).toBe("Update the pull request");
  });

  it("is done on the base branch itself", () => {
    expect(nextStep({ ...data, ahead: 4, branch: "main" }, options).kind).toBe(
      "done"
    );
  });

  it("is done when nothing differs", () => {
    expect(nextStep(data, options).kind).toBe("done");
  });
});

describe(gitBlockers, () => {
  const worktree = { baseName: "main", isWorktree: true };

  it("waits for the data to load", () => {
    expect(gitBlockers(undefined, worktree)).toEqual({
      branch: "Loading…",
      commit: "Loading…",
      merge: "Loading…",
      update: "Loading…",
    });
  });

  it("makes new branches only in the main checkout", () => {
    expect(gitBlockers(data, worktree).branch).toMatch(/own branch/u);
    expect(
      gitBlockers(data, { ...worktree, isWorktree: false }).branch
    ).toBeUndefined();
  });

  it("allows merging a clean, ahead worktree into a clean base", () => {
    expect(gitBlockers({ ...data, ahead: 2 }, worktree).merge).toBeUndefined();
  });

  it("blocks merging while changes are uncommitted", () => {
    expect(
      gitBlockers({ ...data, ahead: 2, dirty: true }, worktree).merge
    ).toBe("Commit the changes first");
  });

  it("blocks merging when the main checkout is on another branch", () => {
    expect(
      gitBlockers(
        { ...data, ahead: 2, workspace: { branch: "dev", clean: true } },
        worktree
      ).merge
    ).toBe("The main checkout is on dev, not main");
  });

  it("blocks updating when already up to date", () => {
    expect(gitBlockers(data, worktree).update).toBe(
      "Already up to date with main"
    );
  });

  it("allows committing only when dirty", () => {
    expect(gitBlockers({ ...data, dirty: true }, worktree).commit).toBe(
      undefined
    );
    expect(gitBlockers(data, worktree).commit).toBe("No uncommitted changes");
  });
});
