import { describe, expect, it } from "vitest";

import type {
  ProjectView,
  ReviewData,
  SessionSummary,
  TaskMeta,
} from "../../../../src/shared/types";
import {
  diffStats,
  fileMatrix,
  startStepLabel,
  taskPath,
  formatCost,
  formatTokens,
  modelFromKey,
  modelKey,
  opensNewTask,
  pickPrompts,
  projectIdFromPath,
  removals,
  taskChip,
  taskDestination,
  taskFailures,
  taskSessions,
  variantName,
} from "../../../../src/web/features/tasks/tasks";

const meta = (variant: number, of = 3): TaskMeta => ({
  task: "tsk_1",
  variant,
  of,
  title: "Fix",
});
const session = (
  id: string,
  directory: string,
  over: Partial<SessionSummary> = {}
): SessionSummary => ({
  id,
  projectId: "p",
  title: id,
  directory,
  updatedAt: 1,
  status: "idle",
  ...over,
});
const wt = (b: string) => `/workspaces/demo.worktrees/${b}`;

function view(sessions: SessionSummary[]): ProjectView {
  return {
    project: {
      id: "p 1",
      name: "demo",
      path: "/src/demo",
      devcontainerPath: "/src/demo/x",
    },
    runtime: {
      projectId: "p 1",
      containerState: "running",
      opencode: "healthy",
      workspaceFolder: "/workspaces/demo",
      worktrees: [
        { path: wt("a"), branch: "fix-a" },
        { path: wt("b"), branch: "fix-b" },
        { path: wt("c"), branch: "fix-c" },
      ],
    },
    sessions,
    openUrl: "http://p.localhost:7777/",
    environments: [],
  };
}

describe("task sessions", () => {
  it("lists a task's sessions by variant and names them", () => {
    const v = view([
      session("s3", wt("c"), { task: meta(3) }),
      session("s1", wt("a"), {
        task: meta(1),
        model: { id: "anthropic/claude-opus-5-5", providerID: "p" },
      }),
      session("x", "/workspaces/demo"),
    ]);
    expect(taskSessions(v, "tsk_1").map((s) => s.id)).toStrictEqual([
      "s1",
      "s3",
    ]);
    expect(variantName(taskSessions(v, "tsk_1")[0])).toBe("claude-opus-5-5");
    expect(variantName(taskSessions(v, "tsk_1")[1])).toBe("#3");
  });

  it("shows a chip that links to the task page only for several variants", () => {
    const v = view([]);
    expect(taskChip(v, session("s", "/w"))).toBeUndefined();
    expect(taskChip(v, session("s", "/w", { task: meta(1, 1) }))).toStrictEqual(
      {
        label: "task",
        title: "Task: Fix",
      }
    );
    expect(
      taskChip(
        v,
        session("s", "/w", {
          task: meta(2),
          model: { id: "m-x", providerID: "p", variant: "high" },
        })
      )
    ).toStrictEqual({
      label: "task 2/3",
      title: "Task: Fix",
      to: "/p/p%201/t/tsk_1",
      model: "m-x-high",
    });
  });
});

describe("formatting", () => {
  it("formats cost and tokens", () => {
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("sums a review's diff stats", () => {
    const data = {
      files: [
        { additions: 3, deletions: 1 },
        { additions: 0, deletions: 4 },
      ],
    } as unknown as ReviewData;
    expect(diffStats(data)).toStrictEqual({
      files: 2,
      additions: 3,
      deletions: 5,
    });
  });
});

describe("after starting a task", () => {
  it("goes to the session for one variant and to the task page for several", () => {
    expect(
      taskDestination("p 1", {
        task: "tsk_1",
        variants: [{ directory: "/w", sessionId: "ses_1" }],
      })
    ).toBe("/p/p%201?session=ses_1");
    expect(
      taskDestination("p", {
        task: "tsk_1",
        variants: [{ error: "x" }, { sessionId: "ses_2" }],
      })
    ).toBe("/p/p/t/tsk_1");
    expect(
      taskDestination("p", {
        task: "tsk_1",
        variants: [{ branch: "b", error: "boom" }],
      })
    ).toBeUndefined();
  });

  it("describes failed variants", () => {
    expect(
      taskFailures({ task: "t", variants: [{ sessionId: "s" }] })
    ).toBeUndefined();
    expect(
      taskFailures({
        task: "t",
        variants: [
          { sessionId: "s" },
          { branch: "b", error: "boom" },
          { error: "no" },
        ],
      })
    ).toBe("variant 2 (b): boom; variant 3: no");
  });

  it("navigates when a variant has both sessionId and error (prompt failed after session created)", () => {
    expect(
      taskDestination("p", {
        task: "tsk_1",
        variants: [{ sessionId: "ses_1", error: "prompt failed" }],
      })
    ).toBe("/p/p?session=ses_1");
    expect(
      taskFailures({
        task: "tsk_1",
        variants: [{ sessionId: "ses_1", error: "prompt failed" }],
      })
    ).toBe("variant 1: prompt failed");
  });

  it("goes to task page when both variants errored but only one has a sessionId", () => {
    expect(
      taskDestination("p", {
        task: "tsk_1",
        variants: [{ sessionId: "ses_1", error: "x" }, { error: "y" }],
      })
    ).toBe("/p/p/t/tsk_1");
  });
});

describe("picking a variant", () => {
  it("removes other variants' worktrees that no remaining session uses", () => {
    const v = view([
      session("s1", wt("a"), { task: { ...meta(1), branch: "fix-a" } }),
      session("s2", wt("b"), { task: { ...meta(2), branch: "fix-b" } }),
      session("s3", wt("c"), { task: { ...meta(3), branch: "fix-c" } }),
      session("other", wt("c")),
      session("ws", "/workspaces/demo", {
        task: { ...meta(1), task: "tsk_2" },
      }),
    ]);
    expect(removals(v, "tsk_1", "s2", { [wt("a")]: true })).toStrictEqual([
      { name: "fix-a", dirty: true },
    ]);
    expect(removals(v, "tsk_1", "s1", {})).toStrictEqual([{ name: "fix-b" }]);
  });

  it("marks worktrees whose branch would be kept", () => {
    const v = view([
      session("s1", wt("a"), { task: { ...meta(1), branch: "fix-a" } }),
      session("s2", wt("b"), { task: { ...meta(2), branch: "fix-b" } }),
      session("s3", wt("c"), { task: meta(3) }),
    ]);
    v.runtime.worktrees = [
      { path: wt("a"), branch: "fix-a" },
      { path: wt("b"), branch: "other" },
      { path: wt("c"), branch: "fix-c" },
    ];
    expect(removals(v, "tsk_1", "s1", { [wt("b")]: true })).toStrictEqual([
      { name: "other", dirty: true, branchKept: true },
      { name: "fix-c", branchKept: true },
    ]);
  });

  it("says running variants are stopped and which branches are kept", () => {
    expect(pickPrompts("a", 1, [], false).discard).not.toMatch(/stopped/u);
    expect(pickPrompts("a", 1, [], true).discard).toMatch(
      /Running variants are stopped\./u
    );
    const p = pickPrompts("a", 2, [
      { name: "x", dirty: true, branchKept: true },
      { name: "y", branchKept: true },
    ]);
    expect(p.remove).toContain(
      "• x — has uncommitted changes, branch kept (not created by this task)"
    );
    expect(p.remove).toContain(
      "• y — may have uncommitted changes, branch kept (not created by this task)"
    );
  });

  it("asks to discard, then to remove worktrees, naming the ones with changes", () => {
    expect(pickPrompts("claude", 1, [])).toStrictEqual({
      discard:
        "Keep claude and discard the other variant? It disappears from the dashboard; its session stays in opencode.",
    });
    const p = pickPrompts("#2", 2, [
      { name: "fix-a", dirty: true },
      { name: "fix-c", dirty: false },
      { name: "fix-d" },
    ]);
    expect(p.discard).toMatch(/^Keep #2 and discard the other 2 variants\?/u);
    expect(p.remove).toContain("• fix-a — has uncommitted changes");
    expect(p.remove).toContain("• fix-c\n");
    expect(p.remove).toContain("• fix-d — may have uncommitted changes");
    expect(p.remove).toMatch(/unmerged commits are lost/u);
  });
});

describe("keyboard and routing", () => {
  const key = (over: Partial<Parameters<typeof opensNewTask>[0]> = {}) => ({
    key: "n",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: null,
    ...over,
  });

  it("opens New task on a bare n, never while typing or with a modifier", () => {
    expect(opensNewTask(key())).toBeTruthy();
    expect(opensNewTask(key({ target: { tagName: "DIV" } }))).toBeTruthy();
    expect(opensNewTask(key({ key: "m" }))).toBeFalsy();
    expect(opensNewTask(key({ metaKey: true }))).toBeFalsy();
    expect(opensNewTask(key({ ctrlKey: true }))).toBeFalsy();
    expect(opensNewTask(key({ altKey: true }))).toBeFalsy();
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(opensNewTask(key({ target: { tagName } }))).toBeFalsy();
    }
    expect(
      opensNewTask(key({ target: { tagName: "DIV", isContentEditable: true } }))
    ).toBeFalsy();
  });

  it("reads the project from the current path", () => {
    expect(projectIdFromPath("/p/demo%201/review/x")).toBe("demo 1");
    expect(projectIdFromPath("/p/demo")).toBe("demo");
    expect(projectIdFromPath("/sessions")).toBeUndefined();
  });

  it("round-trips model select values, slashes included", () => {
    const ref = { id: "anthropic/claude-opus-5-5", providerID: "openrouter" };
    expect(modelFromKey(modelKey(ref))).toStrictEqual(ref);
    expect(modelKey(undefined)).toBe("");
    expect(modelFromKey("")).toBeUndefined();
  });
});

describe("starting tasks", () => {
  it("names each setup step", () => {
    expect(startStepLabel("queued")).toBe("Waiting");
    expect(startStepLabel("pushing")).toBe("Pushing the base");
    expect(startStepLabel("worktree")).toBe("Creating the worktree");
    expect(startStepLabel("image")).toBe("Preparing the image");
    expect(startStepLabel("container")).toBe("Starting the container");
    expect(startStepLabel("session")).toBe("Starting the session");
    expect(startStepLabel("failed")).toBe("Failed");
  });

  it("goes to the task's page", () => {
    expect(taskPath("p 1", "tsk_1")).toBe("/p/p%201/t/tsk_1");
  });
});

describe("fileMatrix", () => {
  const review = (
    files: { file: string; additions: number; deletions?: number }[]
  ): ReviewData =>
    ({
      files: files.map((f) => ({
        additions: f.additions,
        deletions: f.deletions ?? 0,
        file: f.file,
        status: "modified",
      })),
    }) as unknown as ReviewData;

  it("lines up each file across variants, the ones they disagree on first", () => {
    const rows = fileMatrix([
      review([
        { additions: 4, file: "src/a.ts" },
        { additions: 2, file: "src/b.ts" },
      ]),
      review([
        { additions: 4, file: "src/a.ts" },
        { additions: 9, file: "src/c.ts" },
      ]),
    ]);
    expect(rows.map((r) => [r.file, r.same])).toEqual([
      ["src/b.ts", false],
      ["src/c.ts", false],
      ["src/a.ts", true],
    ]);
    expect(rows[0].cells[1]).toBeUndefined();
    expect(rows[1].cells[1]).toMatchObject({ additions: 9 });
  });

  it("treats a variant whose changes haven't loaded as touching nothing", () => {
    const rows = fileMatrix([review([{ additions: 1, file: "x" }]), undefined]);
    expect(rows).toEqual([
      {
        cells: [{ additions: 1, deletions: 0, status: "modified" }, undefined],
        file: "x",
        same: false,
      },
    ]);
  });
});
