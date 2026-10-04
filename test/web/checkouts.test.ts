import { describe, expect, it } from "vitest";
import type { ProjectView, SessionSummary, TaskMeta } from "../../src/shared/types";
import {
  checkoutCounts,
  checkoutOf,
  checkoutPath,
  checkouts,
  checkoutTone,
  legacyPath,
  orphanSessions,
  projectTasks,
  sessionPath,
} from "../../src/web/checkouts";

const wt = (b: string) => `/workspaces/demo.worktrees/${b}`;
const session = (id: string, directory: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  projectId: "p 1",
  title: id,
  directory,
  updatedAt: 1,
  status: "idle",
  ...over,
});

function view(sessions: SessionSummary[] = []): ProjectView {
  return {
    project: { id: "p 1", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/x" },
    runtime: {
      projectId: "p 1",
      containerState: "running",
      opencode: "healthy",
      workspaceFolder: "/workspaces/demo",
      worktrees: [{ path: wt("login"), branch: "feature/login", hostPath: "/src/demo.worktrees/login" }, { path: wt("main") }],
    },
    sessions,
    openUrl: "http://p.localhost:7777/",
  };
}

describe("checkouts", () => {
  it("lists the main checkout first, then each worktree by folder name", () => {
    const list = checkouts(view());
    expect(list.map((c) => [c.target, c.label, c.directory])).toEqual([
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
    expect(checkoutPath("p 1", "a b", "review")).toBe("/p/p%201/w/a%20b/review");
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
    expect(checkoutCounts(v, wt("login"))).toEqual({ attention: 1, running: 1, idle: 0 });
    expect(checkoutCounts(v, "/workspaces/demo")).toEqual({ attention: 0, running: 1, idle: 1 });
    expect(checkoutTone(v, wt("login"))).toBe("attention");
    expect(checkoutTone(v, "/workspaces/demo")).toBe("running");
    expect(checkoutTone(v, wt("main"))).toBe("ok");
    expect(checkoutTone({ ...v, runtime: { ...v.runtime, containerState: "stopped" } }, wt("main"))).toBe("off");
  });

  it("links a session to its checkout, or to the project when its checkout is unknown", () => {
    const v = view([session("a", wt("login")), session("b", "/gone")]);
    expect(sessionPath(v, v.sessions[0])).toBe("/p/p%201/w/login?session=a");
    expect(sessionPath(v, v.sessions[1])).toBe("/p/p%201?session=b");
    expect(orphanSessions(v).map((s) => s.id)).toEqual(["b"]);
  });

  it("lists multi-variant tasks once, needing attention when any variant does", () => {
    const meta = (task: string, variant: number, of: number): TaskMeta => ({ task, variant, of, title: `T ${task}` });
    const v = view([
      session("a", wt("login"), { task: meta("t1", 1, 2), updatedAt: 5 }),
      session("b", wt("main"), { task: meta("t1", 2, 2), status: "needs-permission", updatedAt: 3 }),
      session("c", "/workspaces/demo", { task: meta("t2", 1, 1) }),
      session("d", wt("login"), { task: meta("t3", 1, 3), updatedAt: 9 }),
    ]);
    expect(projectTasks(v)).toEqual([
      { task: "t3", title: "T t3", variants: 1, attention: false, running: false, updatedAt: 9 },
      { task: "t1", title: "T t1", variants: 2, attention: true, running: false, updatedAt: 5 },
    ]);
  });

  it("maps the old project tab URLs to worktree URLs", () => {
    expect(legacyPath("p 1", "review")).toBe("/p/p%201/main/review");
    expect(legacyPath("p 1", "review", "login")).toBe("/p/p%201/w/login/review");
    expect(legacyPath("p 1", "ports")).toBe("/p/p%201/main/ports");
    expect(legacyPath("p 1", "logs")).toBe("/p/p%201/main/logs");
    expect(legacyPath("p 1", "worktrees")).toBe("/p/p%201");
  });
});
