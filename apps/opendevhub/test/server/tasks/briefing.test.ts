import { describe, expect, it, vi } from "vitest";

import type { TaskRecord } from "../../../src/server/db/tasks";
import {
  buildBriefing,
  gatherBriefing,
  taskProgress,
} from "../../../src/server/tasks/briefing";
import type { BriefingSources } from "../../../src/server/tasks/briefing";

const plain = {
  base: "main",
  branch: "fix-login",
  directory: "/workspaces/demo.worktrees/fix-login",
  title: "Fix the login redirect",
};

describe(buildBriefing, () => {
  it("briefs a plain task with its commits, diffstat and uncommitted changes", () => {
    const text = buildBriefing({
      ...plain,
      brief: "Users land on /home instead of where they were.",
      commits: ["c3 fix redirect", "b2 add test", "a1 extract helper"],
      diffstat: [
        " src/login.ts | 4 ++--",
        " 1 file changed, 2 insertions(+), 2 deletions(-)",
      ],
      earlier: ["Fix the login redirect", "Add a regression test"],
      status: [" M src/login.ts", "?? notes.md"],
    });
    expect(text).toContain("fresh conversation in an ongoing task");
    expect(text).toContain("**Fix the login redirect**");
    expect(text).toContain("Users land on /home");
    expect(text).toContain("- Branch: `fix-login`");
    expect(text).toContain("- Base: `main`");
    expect(text).toContain("- Path: `/workspaces/demo.worktrees/fix-login`");
    expect(text).toMatch(
      /- c3 fix redirect\n- b2 add test\n- a1 extract helper/u
    );
    expect(text).toContain(" 1 file changed, 2 insertions(+), 2 deletions(-)");
    expect(text).toContain(" M src/login.ts\n?? notes.md");
    expect(text).toContain(
      "1. Fix the login redirect\n2. Add a regression test"
    );
    expect(text).not.toContain("## OpenSpec change");
  });

  it("names the task's ticket", () => {
    expect(
      buildBriefing({
        ...plain,
        ticket: {
          key: "WEB-42",
          title: "Login loses the return URL",
          url: "https://acme.atlassian.net/browse/WEB-42",
        },
      })
    ).toContain(
      "Ticket: WEB-42 — Login loses the return URL (https://acme.atlassian.net/browse/WEB-42)"
    );
  });

  it("gives a spec-first task's change, phase, progress and folder", () => {
    const text = buildBriefing({
      ...plain,
      spec: {
        change: "add-export",
        folder: "openspec/changes/add-export/",
        phase: "implement",
        tasks: { done: 4, total: 9 },
      },
    });
    expect(text).toContain("## OpenSpec change");
    expect(text).toContain("- Change: `add-export`");
    expect(text).toContain("- Phase: implementing");
    expect(text).toContain("- Tasks: 4/9 done");
    expect(text).toContain("- Folder: `openspec/changes/add-export/`");
  });

  it("says empty sections are empty", () => {
    const text = buildBriefing({
      ...plain,
      commits: [],
      diffstat: [],
      status: [],
    });
    expect(text).toContain("## Commits since the base\n\nNone yet.");
    expect(text).toContain("None: the branch matches its base.");
    expect(text).toContain("None: the working tree is clean.");
  });

  it("cuts long commit, diffstat and status lists", () => {
    const commits = Array.from({ length: 45 }, (_, i) => `c${i} commit ${i}`);
    const files = Array.from({ length: 50 }, (_, i) => ` f${i}.ts | 1 +`);
    const status = Array.from({ length: 60 }, (_, i) => `?? n${i}.md`);
    const text = buildBriefing({
      ...plain,
      commits,
      diffstat: [...files, " 50 files changed, 50 insertions(+)"],
      status,
    });
    expect(text).toContain("- c29 commit 29\n… and 15 more");
    expect(text).not.toContain("c30 commit 30");
    expect(text).toContain(
      " f39.ts | 1 +\n… and 10 more\n 50 files changed, 50 insertions(+)"
    );
    expect(text).toContain("?? n39.md\n… and 20 more");
  });

  it("leaves out sections whose data is missing", () => {
    const text = buildBriefing({ directory: "/w", title: "Spike" });
    expect(text).toContain("- Path: `/w`");
    expect(text).not.toContain("Branch");
    expect(text).not.toContain("## Commits");
    expect(text).not.toContain("## Changes against the base");
    expect(text).not.toContain("## Uncommitted changes");
    expect(text).not.toContain("## Earlier conversations");
  });
});

describe(taskProgress, () => {
  it("counts checked and unchecked items", () => {
    expect(
      taskProgress("## 1\n\n- [x] 1.1 a\n- [ ] 1.2 b\n- [X] 1.3 c\nprose [ ]\n")
    ).toStrictEqual({ done: 2, total: 3 });
  });
});

const sources = (over: Partial<BriefingSources> = {}) => {
  const git = {
    commitsSince: vi.fn(async () => ["b2 second", "a1 first"]),
    currentBranch: vi.fn(async () => "fix"),
    diffStat: vi.fn(async () => [" a.ts | 1 +", " 1 file changed"]),
    fileBytes: vi.fn(async () => Buffer.from("- [x] a\n- [ ] b\n")),
    mergeBase: vi.fn(async () => "c0ffee"),
    recordedBase: vi.fn(async (): Promise<string | undefined> => "main"),
    statusLines: vi.fn(async () => [" M a.ts"]),
  };
  const src: BriefingSources = {
    earlier: ["First try"],
    git,
    target: { id: "demo" } as unknown as BriefingSources["target"],
    task: {
      brief: "Do it",
      id: "t1",
      title: "Task",
      variants: [],
    } as unknown as TaskRecord,
    variant: { directory: "/w", n: 1, step: "session" },
    ...over,
  };
  return { ...src, git };
};

describe(gatherBriefing, () => {
  it("reads git against the merge-base of the recorded base", async () => {
    const src = sources({
      variant: {
        directory: "/w",
        n: 1,
        spec: { change: "add-export", phase: "implement" },
        step: "session",
      },
    });
    const input = await gatherBriefing(src);
    expect(src.git.commitsSince).toHaveBeenCalledWith(
      src.target,
      "/w",
      "c0ffee"
    );
    expect(src.git.fileBytes).toHaveBeenCalledWith(
      src.target,
      "/w",
      "openspec/changes/add-export/tasks.md",
      expect.anything()
    );
    expect(input).toMatchObject({
      base: "main",
      branch: "fix",
      brief: "Do it",
      commits: ["b2 second", "a1 first"],
      earlier: ["First try"],
      spec: {
        change: "add-export",
        folder: "openspec/changes/add-export/",
        phase: "implement",
        tasks: { done: 1, total: 2 },
      },
      status: [" M a.ts"],
    });
  });

  it("leaves out a step that fails and reports it", async () => {
    const onError = vi.fn();
    const src = sources({ onError });
    src.git.commitsSince.mockRejectedValueOnce(new Error("git log failed"));
    const input = await gatherBriefing(src);
    expect(input.commits).toBeUndefined();
    expect(input.diffstat).toBeDefined();
    expect(onError).toHaveBeenCalledWith("log", expect.any(Error));
  });

  it("has no commits or diffstat without a recorded base", async () => {
    const src = sources();
    src.git.recordedBase.mockResolvedValueOnce(undefined);
    const input = await gatherBriefing(src);
    expect(input.base).toBeUndefined();
    expect(input.commits).toBeUndefined();
    expect(input.diffstat).toBeUndefined();
    expect(input.status).toStrictEqual([" M a.ts"]);
  });
});
