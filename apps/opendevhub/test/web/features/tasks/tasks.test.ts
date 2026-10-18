import { describe, expect, it } from "vitest";

import type {
  ChecksView,
  ProjectView,
  ReviewData,
  SessionSummary,
  TaskView,
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
  pickPrompts,
  projectIdFromPath,
  specUnavailable,
  removals,
  endedVariants,
  startingVariants,
  taskChip,
  taskDestination,
  taskFailures,
  taskSessions,
  taskTabs,
  variantName,
  conversationThreads,
  defaultVariant,
  selectedVariant,
  switchableVariants,
  activeVariants,
  showsVariants,
  comparesVariants,
  variantState,
  taskAttention,
  taskSteps,
} from "../../../../src/web/features/tasks/tasks";

/** A session's reference to variant `n` of a task. */
const ref = (n: number, id = "tsk_1") => ({
  discarded: false,
  id,
  kind: "task" as const,
  n,
});
const task = (
  id: string,
  variants: Partial<TaskView["variants"][number]>[],
  over: Partial<TaskView> = {}
): TaskView => ({
  createdAt: 1,
  id,
  kind: "task",
  state: "running",
  title: "Fix",
  variants: variants.map((v, i) => ({ n: i + 1, step: "session", ...v })),
  ...over,
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

function view(sessions: SessionSummary[], tasks: TaskView[] = []): ProjectView {
  return {
    tasks,
    chats: [],
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
      session("s3", wt("c"), { task: ref(3) }),
      session("s1", wt("a"), {
        task: ref(1),
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

  it("shows a created-by chip linking to the task page, or to the chat view for a chat, saying when one started in opencode", () => {
    const v = {
      ...view([], [task("tsk_1", [{}, {}, {}]), task("tsk_one", [{}])]),
      chats: [
        {
          createdAt: 1,
          id: "c_here",
          origin: "hub" as const,
          step: "session" as const,
          title: "Fix",
        },
        {
          createdAt: 1,
          id: "c_oc",
          origin: "opencode" as const,
          step: "session" as const,
          title: "Explore",
        },
      ],
    };
    expect(taskChip(v, session("s", "/w"))).toBeUndefined();
    expect(
      taskChip(v, session("s", "/w", { task: ref(1, "tsk_one") }))
    ).toStrictEqual({
      label: "task",
      title: "Task: Fix",
      to: "/p/p%201/t/tsk_one",
    });
    expect(taskChip(v, session("s", "/w", { chat: "c_here" }))).toStrictEqual({
      label: "chat",
      title: "Chat: Fix",
      to: "/chat/p%201/c_here",
    });
    expect(taskChip(v, session("s", "/w", { chat: "c_oc" }))).toStrictEqual({
      label: "started in opencode",
      title: "Found in opencode; started outside opendevhub",
      to: "/chat/p%201/c_oc",
    });
    expect(
      taskChip(
        v,
        session("s", "/w", {
          task: ref(2),
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

describe("a task's variants", () => {
  it("lists those still starting or failed, and those whose session ended", () => {
    const t = task("tsk_1", [
      { step: "image" },
      { error: "boom", step: "failed" },
      { discarded: true, error: "x", step: "failed" },
      { sessionId: "s4", step: "session" },
      { sessionId: "s5", sessionRemoved: true, step: "session" },
      { discarded: true, sessionId: "s6", sessionRemoved: true },
      { step: "session" },
    ]);
    expect(startingVariants(t).map((v) => v.n)).toStrictEqual([1, 2, 7]);
    expect(endedVariants(t).map((v) => v.n)).toStrictEqual([5]);
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
  it("goes to the task page once a variant started", () => {
    expect(
      taskDestination("p 1", {
        task: "tsk_1",
        variants: [{ directory: "/w", sessionId: "ses_1" }],
      })
    ).toBe("/p/p%201/t/tsk_1");
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
    ).toBe("/p/p/t/tsk_1");
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
    const v = view(
      [
        session("s1", wt("a"), { task: ref(1) }),
        session("s2", wt("b"), { task: ref(2) }),
        session("s3", wt("c"), { task: ref(3) }),
        session("other", wt("c")),
        session("ws", "/workspaces/demo", { task: ref(1, "tsk_2") }),
      ],
      [
        task("tsk_1", [
          { branch: "fix-a", sessionId: "s1" },
          { branch: "fix-b", sessionId: "s2" },
          { branch: "fix-c", sessionId: "s3" },
        ]),
        task("tsk_2", [{ sessionId: "ws" }]),
      ]
    );
    expect(removals(v, "tsk_1", "s2", { [wt("a")]: true })).toStrictEqual([
      { name: "fix-a", dirty: true },
    ]);
    expect(removals(v, "tsk_1", "s1", {})).toStrictEqual([{ name: "fix-b" }]);
  });

  it("marks worktrees whose branch would be kept", () => {
    const v = view(
      [
        session("s1", wt("a"), { task: ref(1) }),
        session("s2", wt("b"), { task: ref(2) }),
        session("s3", wt("c"), { task: ref(3) }),
      ],
      [
        task("tsk_1", [
          { branch: "fix-a", sessionId: "s1" },
          { branch: "fix-b", sessionId: "s2" },
          { sessionId: "s3" },
        ]),
      ]
    );
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
        "Keep claude and discard the other variant? It disappears from the dashboard; its conversation stays in opencode.",
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
    expect(startStepLabel("session")).toBe("Starting the conversation");
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

describe(specUnavailable, () => {
  it("names missing commands first, then a missing CLI", () => {
    expect(specUnavailable({ missing: [], cli: true })).toBeUndefined();
    expect(specUnavailable({ missing: [] })).toBeUndefined();
    expect(specUnavailable({ missing: ["opsx-update"], cli: false })).toMatch(
      /opsx-update/u
    );
    expect(specUnavailable({ missing: [], cli: false })).toMatch(/CLI/u);
  });
});

describe("task page", () => {
  it("selects the picked variant, else the first not discarded, else the first", () => {
    expect(defaultVariant(task("t", [{}, {}, { picked: true }]))?.n).toBe(3);
    expect(defaultVariant(task("t", [{ discarded: true }, {}, {}]))?.n).toBe(2);
    expect(
      defaultVariant(task("t", [{ discarded: true }, { discarded: true }]))?.n
    ).toBe(1);
  });

  it("selects the variant `v` names, falling back to the default", () => {
    const t = task("t", [{}, {}, { picked: true }]);
    expect(selectedVariant(t, "1")?.n).toBe(1);
    expect(selectedVariant(t, "9")?.n).toBe(3);
    expect(selectedVariant(t, null)?.n).toBe(3);
  });

  it("offers the variants not discarded, keeping a discarded one that is selected", () => {
    const t = task("t", [{}, { discarded: true }, {}]);
    expect(switchableVariants(t, t.variants[0]).map((v) => v.n)).toStrictEqual([
      1, 3,
    ]);
    expect(switchableVariants(t, t.variants[1]).map((v) => v.n)).toStrictEqual([
      1, 2, 3,
    ]);
  });

  it("shows Compare for two or more live variants and Spec for spec-first tasks", () => {
    const base = ["conversation", "changes", "terminal", "runtime"];
    expect(taskTabs(task("t", [{}]))).toStrictEqual([...base, "checks"]);
    expect(taskTabs(task("t", [{}, { discarded: true }]))).toStrictEqual([
      ...base,
      "checks",
    ]);
    expect(taskTabs(task("t", [{}, {}]))).toStrictEqual([
      ...base,
      "checks",
      "compare",
    ]);
    expect(taskTabs(task("t", [{}], { kind: "review" }))).toStrictEqual([
      ...base,
      "checks",
    ]);
    expect(
      taskTabs(task("t", [{}, {}], { spec: { first: true } }))
    ).toStrictEqual([...base, "spec", "checks", "compare"]);
  });

  it("lists the conversations in the variant's checkout, its own first, then newest first", () => {
    const v = view(
      [
        session("other-env", wt("a"), { envId: "env-2", updatedAt: 9 }),
        session("old", wt("a"), { updatedAt: 2 }),
        session("own", wt("a"), { task: ref(1), updatedAt: 1 }),
        session("new", wt("a"), { updatedAt: 5 }),
        session("elsewhere", wt("b"), { updatedAt: 7 }),
      ],
      [task("tsk_1", [{ directory: wt("a"), sessionId: "own" }])]
    );
    expect(
      conversationThreads(v, v.tasks[0].variants[0]).map((s) => s.id)
    ).toStrictEqual(["own", "new", "old"]);
  });

  it("still lists the checkout's other conversations when the variant's own is gone", () => {
    const v = view([session("new", wt("a"))]);
    expect(
      conversationThreads(v, {
        directory: wt("a"),
        envId: "p 1",
        n: 1,
        sessionId: "gone",
        sessionRemoved: true,
        step: "session",
      }).map((s) => s.id)
    ).toStrictEqual(["new"]);
  });
});

describe("active variants", () => {
  it("shows no variant UI for a single-variant task", () => {
    const t = task("t", [{ sessionId: "s1" }]);
    expect(activeVariants(t).map((v) => v.n)).toStrictEqual([1]);
    expect(showsVariants(t)).toBe(false);
    expect(comparesVariants(t)).toBe(false);
  });

  it("hides variant UI after a pick discards the others", () => {
    const t = task("t", [
      { discarded: true },
      { picked: true },
      { discarded: true },
    ]);
    expect(activeVariants(t).map((v) => v.n)).toStrictEqual([2]);
    expect(showsVariants(t)).toBe(false);
    expect(switchableVariants(t, t.variants[1]).map((v) => v.n)).toStrictEqual([
      2,
    ]);
  });

  it("counts a failed start that wasn't dismissed", () => {
    const t = task("t", [
      { sessionId: "s1" },
      { error: "boom", step: "failed" },
    ]);
    expect(showsVariants(t)).toBe(true);
    expect(variantState(t.variants[1], undefined)).toBe("failed");
  });

  it("shows variants and Compare for two running variants", () => {
    const t = task("t", [{ sessionId: "s1" }, { sessionId: "s2" }]);
    expect(showsVariants(t)).toBe(true);
    expect(comparesVariants(t)).toBe(true);
  });
});

describe("variant and task state", () => {
  const v = (over = {}) => ({
    n: 1,
    sessionId: "s1",
    step: "session" as const,
    ...over,
  });
  it("reads a variant's state from its setup and its session", () => {
    expect(
      variantState(v({ sessionId: undefined, step: "image" }), undefined)
    ).toBe("starting");
    expect(
      variantState(v(), session("s1", wt("a"), { status: "running" }))
    ).toBe("working");
    expect(
      variantState(v(), session("s1", wt("a"), { status: "needs-permission" }))
    ).toBe("needs-you");
    expect(variantState(v(), session("s1", wt("a")))).toBe("idle");
    expect(variantState(v({ sessionRemoved: true }), undefined)).toBe("idle");
  });

  it("puts Needs you before Working before Starting, then Ended or Idle", () => {
    const t = task("t", [
      { sessionId: "s1" },
      { sessionId: "s2" },
      { sessionId: undefined, step: "container" },
    ]);
    const running = session("s1", wt("a"), { status: "running" });
    const asking = session("s2", wt("b"), { status: "needs-answer" });
    expect(taskAttention(t, [running, asking])).toBe("needs-you");
    expect(taskAttention(t, [running, session("s2", wt("b"))])).toBe("working");
    expect(taskAttention(t, [])).toBe("starting");
    const done = task("t", [{ sessionId: "s1", sessionRemoved: true }], {
      state: "ended",
    });
    expect(taskAttention(done, [])).toBe("ended");
    expect(taskAttention(task("t", [{ sessionId: "s1" }]), [])).toBe("idle");
  });
});

describe(taskSteps, () => {
  const review = (over: Partial<ReviewData> = {}): ReviewData => ({
    ahead: 1,
    behind: 0,
    directory: wt("a"),
    dirty: false,
    files: [],
    mode: "working",
    pushed: false,
    workspace: { clean: true },
    ...over,
  });
  const checks = (status: "passed" | "failed"): ChecksView =>
    ({
      checks: [
        { command: "tsc", name: "typecheck", timeout: 60, where: "container" },
      ],
      current: true,
      errors: [],
      run: {
        directory: wt("a"),
        dirty: false,
        finishedAt: 2,
        results: [
          {
            command: "tsc",
            name: "typecheck",
            output: [],
            status,
            where: "container",
          },
        ],
        startedAt: 1,
      },
      teamWritable: false,
    }) as unknown as ChecksView;
  const states = (steps: ReturnType<typeof taskSteps>) =>
    steps.map((s) => `${s.label}:${s.state}`);

  it("has Agents · 2 current while both variants work", () => {
    const t = task("t", [{ sessionId: "s1" }, { sessionId: "s2" }]);
    const sessions = [
      session("s1", wt("a"), { status: "running" }),
      session("s2", wt("b"), { status: "running" }),
    ];
    expect(states(taskSteps(t, t.variants[0], { sessions }))).toStrictEqual([
      "Brief:done",
      "Agents · 2:current",
      "Pick variant:todo",
      "Review & checks:todo",
      "Publish:todo",
      "Pull request:todo",
    ]);
  });

  it("has no Pick variant step for a single-variant task", () => {
    const t = task("t", [{ sessionId: "s1" }]);
    expect(
      taskSteps(t, t.variants[0], { sessions: [] }).map((s) => s.id)
    ).toStrictEqual(["brief", "agents", "review", "publish", "pull"]);
  });

  it("makes Pull request current once the picked variant is checked and pushed", () => {
    const t = task("t", [
      { discarded: true },
      { picked: true, sessionId: "s2" },
    ]);
    const steps = taskSteps(t, t.variants[1], {
      checks: checks("passed"),
      review: review({ pushed: true }),
      sessions: [session("s2", wt("b"))],
    });
    expect(steps.find((s) => s.state === "current")?.id).toBe("pull");
    expect(steps.find((s) => s.id === "pick")?.state).toBe("done");
  });

  it("keeps Review & checks current while an AI review runs", () => {
    const t = task("t", [{ sessionId: "s1" }]);
    const input = {
      checks: checks("passed"),
      review: review(),
      sessions: [session("s1", wt("a"))],
    };
    expect(
      taskSteps(t, t.variants[0], { ...input, aiReviewRunning: true }).find(
        (s) => s.state === "current"
      )?.id
    ).toBe("review");
    expect(
      taskSteps(t, t.variants[0], input).find((s) => s.state === "current")?.id
    ).toBe("publish");
  });

  it("keeps Review & checks current while checks fail or changes aren't committed", () => {
    const t = task("t", [{ sessionId: "s1" }]);
    const sessions = [session("s1", wt("a"))];
    const current = (over: Parameters<typeof taskSteps>[2]) =>
      taskSteps(t, t.variants[0], over).find((s) => s.state === "current")?.id;
    expect(
      current({ checks: checks("failed"), review: review(), sessions })
    ).toBe("review");
    expect(
      current({
        checks: checks("passed"),
        review: review({ dirty: true }),
        sessions,
      })
    ).toBe("review");
  });

  it("counts data still loading as not done", () => {
    const t = task("t", [{ sessionId: "s1" }]);
    const steps = taskSteps(t, t.variants[0], {
      sessions: [session("s1", wt("a"))],
    });
    expect(steps.find((s) => s.state === "current")?.id).toBe("review");
    expect(
      steps.filter((s) => s.state === "done").map((s) => s.id)
    ).toStrictEqual(["brief", "agents"]);
  });

  it("has no steps for an AI review task", () => {
    const t = task("t", [{ sessionId: "s1" }], { kind: "review" });
    expect(taskSteps(t, t.variants[0], { sessions: [] })).toStrictEqual([]);
  });
});
