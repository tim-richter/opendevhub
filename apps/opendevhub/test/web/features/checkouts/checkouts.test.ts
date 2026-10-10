import { describe, expect, it } from "vitest";

import type {
  ProjectView,
  SessionSummary,
  TaskView,
} from "../../../../src/shared/types";
import {
  checkoutCounts,
  checkoutOf,
  checkoutPath,
  checkoutRuntime,
  checkouts,
  checkoutTone,
  legacyPath,
  orphanSessions,
  projectTasks,
  sessionPath,
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

  it("links a session to its checkout, or to the project when its checkout is unknown", () => {
    const v = view([session("a", wt("login")), session("b", "/gone")]);
    expect(sessionPath(v, v.sessions[0])).toBe("/p/p%201/w/login/s/a");
    expect(sessionPath(v, v.sessions[1])).toBe("/p/p%201?session=b");
    expect(orphanSessions(v).map((s) => s.id)).toStrictEqual(["b"]);
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

  it("lists multi-variant tasks once, needing attention when any variant does", () => {
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
        // One variant: the session stands for it, in its checkout.
        task("t2", [{ sessionId: "c" }]),
        task("t3", [{ sessionId: "d" }, {}, {}], { state: "starting" }),
        // A manual task is its session.
        task("t4", [{ sessionId: "e" }], { kind: "manual" }),
      ]
    );
    expect(projectTasks(v)).toStrictEqual([
      {
        attention: false,
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
        kind: "task",
        running: false,
        state: "running",
        task: "t1",
        title: "T t1",
        updatedAt: 5,
        variants: 2,
      },
    ]);
  });

  it("lists starting tasks with one variant, failed starts, and ended tasks of either kind", () => {
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
          kind: "manual",
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
