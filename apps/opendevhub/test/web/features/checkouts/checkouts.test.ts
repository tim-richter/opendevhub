import { describe, expect, it } from "vitest";

import type {
  ProjectView,
  SessionSummary,
  TaskView,
} from "../../../../src/shared/types";
import type { ProjectTask } from "../../../../src/web/features/checkouts/checkouts";
import {
  checkoutCounts,
  checkoutOf,
  checkoutPath,
  checkoutRuntime,
  checkouts,
  checkoutTone,
  legacyPath,
  projectTasks,
  checkoutTasks,
  sessionPath,
  matchesTaskFilter,
  sessionRedirect,
  standaloneCheckouts,
  tasksPathFromSessions,
  worktreeRedirect,
} from "../../../../src/web/features/checkouts/checkouts";

const wt = (b: string) => `/workspaces/demo.worktrees/${b}`;
const session = (
  id: string,
  directory: string,
  over: Partial<SessionSummary> = {}
): SessionSummary => ({
  id,
  projectId: "p 1",
  title: id,
  directory,
  updatedAt: 1,
  status: "idle",
  ...over,
});

function view(
  sessions: SessionSummary[] = [],
  tasks: TaskView[] = []
): ProjectView {
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
        {
          path: wt("login"),
          branch: "feature/login",
          hostPath: "/src/demo.worktrees/login",
        },
        { path: wt("main") },
      ],
    },
    sessions,
    openUrl: "http://p.localhost:7777/",
    environments: [],
  };
}

describe(checkouts, () => {
  it("lists the main checkout first, then each worktree by folder name", () => {
    const list = checkouts(view());
    expect(list.map((c) => [c.target, c.label, c.directory])).toStrictEqual([
      ["", "Main checkout", "/workspaces/demo"],
      ["login", "feature/login", wt("login")],
      ["main", "main", wt("main")],
    ]);
    expect(list[0].hostPath).toBe("/src/demo");
    expect(list[1].worktree?.branch).toBe("feature/login");
  });

  it("builds URLs that keep the main checkout apart from a worktree named main", () => {
    expect(checkoutPath("p 1", "")).toBe("/p/p%201/main");
    expect(checkoutPath("p 1", "main")).toBe("/p/p%201/w/main");
    expect(checkoutPath("p 1", "a b", "review")).toBe(
      "/p/p%201/w/a%20b/review"
    );
  });

  it("finds the checkout a directory belongs to", () => {
    const v = view();
    expect(checkoutOf(v, "/workspaces/demo")?.target).toBe("");
    expect(checkoutOf(v, wt("login"))?.target).toBe("login");
    expect(checkoutOf(v, "/elsewhere")).toBeUndefined();
  });

  it("counts and colours a checkout from its own sessions only", () => {
    const v = view([
      session("a", wt("login"), { status: "needs-answer" }),
      session("b", wt("login"), { status: "running" }),
      session("c", "/workspaces/demo", { status: "running" }),
      session("d", "/workspaces/demo"),
    ]);
    expect(checkoutCounts(v, wt("login"))).toStrictEqual({
      attention: 1,
      running: 1,
      idle: 0,
    });
    expect(checkoutCounts(v, "/workspaces/demo")).toStrictEqual({
      attention: 0,
      running: 1,
      idle: 1,
    });
    expect(checkoutTone(v, wt("login"))).toBe("attention");
    expect(checkoutTone(v, "/workspaces/demo")).toBe("running");
    expect(checkoutTone(v, wt("main"))).toBe("ok");
    expect(
      checkoutTone(
        { ...v, runtime: { ...v.runtime, containerState: "stopped" } },
        wt("main")
      )
    ).toBe("off");
  });

  it("links a session without a task to its checkout, or to the project when its checkout is unknown", () => {
    const v = view([session("a", wt("login")), session("b", "/gone")]);
    expect(sessionPath(v, v.sessions[0])).toBe("/p/p%201/w/login");
    expect(sessionPath(v, v.sessions[1])).toBe("/p/p%201?session=b");
  });

  it("links a session to its task's Conversation tab with its variant, as a thread when it isn't the variant's own", () => {
    const v = view(
      [
        session("a", wt("login"), { task: ref("t1", 2) }),
        session("b", wt("login"), { task: ref("t1", 2) }),
      ],
      [task("t1", [{ sessionId: "x" }, { sessionId: "a" }])]
    );
    expect(sessionPath(v, v.sessions[0])).toBe("/p/p%201/t/t1?v=2");
    expect(sessionPath(v, v.sessions[1])).toBe("/p/p%201/t/t1?v=2&thread=b");
  });

  const ref = (id: string, n: number) => ({
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
    title: `T ${id}`,
    variants: variants.map((v, i) => ({ n: i + 1, step: "session", ...v })),
    ...over,
  });

  it("lists every task, most recent first, with the variant that waits on the user", () => {
    const v = view(
      [
        session("a", wt("login"), { task: ref("t1", 1), updatedAt: 5 }),
        session("b", wt("main"), {
          task: ref("t1", 2),
          status: "needs-permission",
          updatedAt: 3,
        }),
        session("c", "/workspaces/demo", { task: ref("t2", 1) }),
        session("d", wt("login"), { task: ref("t3", 1), updatedAt: 9 }),
      ],
      [
        task("t1", [{ sessionId: "a" }, { sessionId: "b" }]),
        task("t2", [{ sessionId: "c" }], { createdAt: 4 }),
        task("t3", [{ sessionId: "d" }, {}, {}], { state: "starting" }),
      ]
    );
    expect(projectTasks(v)).toStrictEqual([
      {
        attention: false,
        directories: [wt("login")],
        kind: "task",
        running: true,
        state: "starting",
        task: "t3",
        title: "T t3",
        updatedAt: 9,
        variants: 3,
      },
      {
        attention: true,
        directories: [wt("login"), wt("main")],
        kind: "task",
        running: false,
        state: "running",
        task: "t1",
        title: "T t1",
        updatedAt: 5,
        variants: 2,
        waiting: 2,
      },
      {
        attention: false,
        directories: ["/workspaces/demo"],
        kind: "task",
        running: false,
        state: "running",
        task: "t2",
        title: "T t2",
        updatedAt: 4,
        variants: 1,
      },
    ]);
    expect(
      checkoutTasks(v, "/workspaces/demo").map((t) => t.task)
    ).toStrictEqual(["t2"]);
  });

  it("marks a task made from a chat, and never puts a draft in Needs you", () => {
    const v = view(
      [session("e", "/workspaces/demo", { task: ref("t4", 1) })],
      [
        task("t4", [{ sessionId: "e" }], { fromChat: "c_1" }),
        task("t6", [], { state: "draft" }),
      ]
    );
    const [made, draft] = projectTasks(v).toSorted((a, b) =>
      a.task.localeCompare(b.task)
    );
    expect(made.fromChat).toBe(true);
    expect(draft).toMatchObject({ attention: false, state: "draft" });
  });

  it("lists failed starts and ended tasks of either kind", () => {
    const v = view(
      [],
      [
        task("t1", [{ step: "image" }], { createdAt: 3, state: "starting" }),
        task("t9", [{ error: "boom", step: "failed" }], {
          createdAt: 7,
          state: "starting",
        }),
        task("t5", [{ sessionId: "gone", sessionRemoved: true }], {
          createdAt: 1,
          kind: "review",
          state: "ended",
        }),
      ]
    );
    expect(
      projectTasks(v).map((t) => [t.task, t.state, t.attention, t.running])
    ).toStrictEqual([
      ["t9", "starting", true, true],
      ["t1", "starting", false, true],
      ["t5", "ended", false, false],
    ]);
  });

  it("sends a worktree a task variant created to that task, mapping its tabs", () => {
    const v = view([], [task("t1", [{}, {}])]);
    const created = {
      ...v,
      runtime: {
        ...v.runtime,
        worktrees: [
          {
            createdBy: { by: "variant" as const, n: 2, task: "t1", title: "T" },
            path: wt("login"),
          },
          {
            createdBy: {
              by: "variant" as const,
              n: 1,
              task: "archived",
              title: "A",
            },
            path: wt("old"),
          },
          { createdBy: { by: "pull" as const }, path: wt("pr") },
        ],
      },
    };
    const [main, login, old, pr] = checkouts(created);
    expect(worktreeRedirect(created, login)).toBe("/p/p%201/t/t1?v=2");
    expect(worktreeRedirect(created, login, "review")).toBe(
      "/p/p%201/t/t1/review?v=2"
    );
    expect(worktreeRedirect(created, login, "terminal")).toBe(
      "/p/p%201/t/t1/terminal?v=2"
    );
    expect(worktreeRedirect(created, login, "runtime")).toBe(
      "/p/p%201/t/t1/runtime?v=2"
    );
    expect(worktreeRedirect(created, main)).toBeUndefined();
    expect(worktreeRedirect(created, pr)).toBeUndefined();
    // Its task was archived: the worktree keeps its page.
    expect(worktreeRedirect(created, old)).toBeUndefined();
    expect(standaloneCheckouts(created).map((c) => c.target)).toStrictEqual([
      "",
      "old",
      "pr",
    ]);
  });

  it("keeps the worktrees of failed or discarded variants on their own page and lists them standalone", () => {
    const v = view(
      [],
      [task("t1", [{}, { step: "failed" }, { discarded: true }])]
    );
    const created = {
      ...v,
      runtime: {
        ...v.runtime,
        worktrees: [
          {
            createdBy: { by: "variant" as const, n: 1, task: "t1", title: "T" },
            path: wt("home"),
          },
          {
            createdBy: { by: "variant" as const, n: 2, task: "t1", title: "T" },
            path: wt("login"),
          },
          {
            createdBy: { by: "variant" as const, n: 3, task: "t1", title: "T" },
            path: wt("pr"),
          },
        ],
      },
    };
    const [, alive, failed, discarded] = checkouts(created);
    // n=1 is still starting: its worktree lives under the task.
    expect(worktreeRedirect(created, alive)).toBe("/p/p%201/t/t1?v=1");
    // n=2 failed and n=3 discarded: the worktree keeps its own page.
    expect(worktreeRedirect(created, failed)).toBeUndefined();
    expect(worktreeRedirect(created, failed, "runtime")).toBeUndefined();
    expect(worktreeRedirect(created, discarded)).toBeUndefined();
    expect(standaloneCheckouts(created).map((c) => c.target)).toStrictEqual([
      "",
      "login",
      "pr",
    ]);
  });

  it("sends an old session link to its task, else to its checkout", () => {
    const v = view(
      [
        session("a", wt("login"), { task: ref("t1", 1) }),
        session("x", wt("login")),
      ],
      [
        task("t1", [
          { sessionId: "a" },
          { sessionId: "gone", sessionRemoved: true },
        ]),
      ]
    );
    expect(sessionRedirect(v, "login", "a")).toBe("/p/p%201/t/t1?v=1");
    // The session is gone from opencode, but its variant still names it.
    expect(sessionRedirect(v, "login", "gone")).toBe("/p/p%201/t/t1?v=2");
    expect(sessionRedirect(v, "login", "x")).toBe("/p/p%201/w/login");
    expect(sessionRedirect(v, "", "unknown")).toBe("/p/p%201/main");
  });

  it("filters tasks by what needs the user and by state", () => {
    const t = (over: Partial<ProjectTask>): ProjectTask => ({
      attention: false,
      directories: [],
      kind: "task",
      running: false,
      state: "running",
      task: "t",
      title: "T",
      updatedAt: 1,
      variants: 1,
      ...over,
    });
    const tasks = {
      ended: t({ state: "ended" }),
      idle: t({}),
      running: t({ running: true }),
      waiting: t({ attention: true, running: true }),
    };
    const pick = (f: Parameters<typeof matchesTaskFilter>[1]) =>
      Object.entries(tasks)
        .filter(([, x]) => matchesTaskFilter(x, f))
        .map(([k]) => k);
    expect(pick("all")).toStrictEqual(["ended", "idle", "running", "waiting"]);
    expect(pick("attention")).toStrictEqual(["waiting"]);
    expect(pick("running")).toStrictEqual(["running"]);
    expect(pick("idle")).toStrictEqual(["idle"]);
    expect(pick("ended")).toStrictEqual(["ended"]);
  });

  it("keeps the old Sessions page's status filter on the Tasks page", () => {
    expect(tasksPathFromSessions("running")).toBe("/tasks?status=running");
    expect(tasksPathFromSessions("attention")).toBe("/tasks?status=attention");
    expect(tasksPathFromSessions("needs-permission")).toBe(
      "/tasks?status=attention"
    );
    expect(tasksPathFromSessions(undefined)).toBe("/tasks");
  });

  it("maps the old project tab URLs to worktree URLs", () => {
    expect(legacyPath("p 1", "review")).toBe("/p/p%201/main/review");
    expect(legacyPath("p 1", "review", "login")).toBe(
      "/p/p%201/w/login/review"
    );
    expect(legacyPath("p 1", "ports")).toBe("/p/p%201/main/runtime");
    expect(legacyPath("p 1", "logs")).toBe("/p/p%201/main/runtime");
    expect(legacyPath("p 1", "worktrees")).toBe("/p/p%201");
  });
});

describe("checkouts with their own container", () => {
  const own = (
    containerState: "running" | "stopped" | "starting",
    opencode: "healthy" | "absent" | "unhealthy" = "healthy"
  ) => ({
    ...view(),
    environments: [
      {
        id: "p-login-0a1b",
        worktree: {
          path: wt("login"),
          hostPath: "/src/demo.worktrees/login",
          branch: "feature/login",
        },
        worktreeId: 1,
        runtime: {
          projectId: "p 1",
          containerState,
          opencode,
          ports: [
            {
              status: "forwarded" as const,
              containerPort: 3000,
              hostPort: 3001,
            },
          ],
        },
        openUrl: "http://p-login-0a1b.localhost:7777/",
      },
    ],
  });

  it("reads a worktree's container state, ports and opencode from its own container", () => {
    expect(checkoutRuntime(own("running"), wt("login")).ports).toStrictEqual([
      { status: "forwarded", containerPort: 3000, hostPort: 3001 },
    ]);
    expect(checkoutRuntime(own("running"), wt("main"))).toStrictEqual(
      own("running").runtime
    );
    expect(
      checkoutRuntime(own("running"), "/workspaces/demo").workspaceFolder
    ).toBe("/workspaces/demo");
  });

  it("tones a worktree by its own container", () => {
    expect(checkoutTone(own("stopped", "absent"), wt("login"))).toBe("off");
    expect(checkoutTone(own("stopped", "absent"), wt("main"))).toBe("ok");
    expect(checkoutTone(own("starting", "absent"), wt("login"))).toBe("busy");
    expect(checkoutTone(own("running"), wt("login"))).toBe("ok");
  });
});
