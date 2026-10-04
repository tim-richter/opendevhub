import { describe, expect, it } from "vitest";
import type { DashboardSnapshot, ProjectView, SessionStatus } from "../../src/shared/types";
import {
  allSessions,
  attentionCounts,
  compareSessions,
  diffForNotifications,
  pendingSummary,
  matches,
  projectCounts,
  projectTone,
  relativeTime,
  containerShellCommand,
  shellQuote,
  workspaceFolderOf,
  worktreeLabel,
} from "../../src/web/derive";

function snap(statuses: Record<string, SessionStatus>): DashboardSnapshot {
  return {
    roots: [],
    preflight: { errors: [] },
  editors: [],
    projects: [
      {
        project: { id: "p", name: "demo", path: "/p", devcontainerPath: "/p/x" },
        runtime: { projectId: "p", containerState: "running", opencode: "healthy" },
        openUrl: "http://p.localhost:7777/",
        sessions: Object.entries(statuses).map(([id, status]) => ({
          id,
          projectId: "p",
          title: `T ${id}`,
          directory: "/w",
          updatedAt: 1,
          status,
        })),
      },
    ],
  };
}

describe("diffForNotifications", () => {
  it("never notifies on the first snapshot, even if sessions need attention", () => {
    expect(diffForNotifications(undefined, snap({ a: "needs-permission", b: "needs-answer" }))).toEqual([]);
  });

  it("notifies on entering needs-permission / needs-answer and on running -> idle", () => {
    const notices = diffForNotifications(
      snap({ a: "running", b: "running", c: "running", d: "idle" }),
      snap({ a: "needs-permission", b: "needs-answer", c: "idle", d: "idle" }),
    );
    expect(notices.map((n) => [n.sessionId, n.title])).toEqual([
      ["a", "demo: permission needed"],
      ["b", "demo: question waiting"],
      ["c", "demo: finished"],
    ]);
    expect(notices[0].body).toBe("T a");
  });

  it("does not repeat while the state is unchanged, and ignores new idle sessions", () => {
    expect(diffForNotifications(snap({ a: "needs-permission" }), snap({ a: "needs-permission", z: "idle" }))).toEqual([]);
  });
});

describe("attentionCounts", () => {
  it("counts sessions needing attention and running", () => {
    expect(attentionCounts(snap({ a: "needs-permission", b: "needs-answer", c: "running", d: "idle" }))).toEqual({
      attention: 2,
      running: 1,
    });
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it.each([
    [now - 10_000, "just now"],
    [now - 5 * 60_000, "5 min ago"],
    [now - 3 * 3_600_000, "3 h ago"],
    [now - 2 * 86_400_000, "2 d ago"],
    [now + 5000, "just now"],
  ])("%d", (ts, expected) => expect(relativeTime(ts, now)).toBe(expected));
});

describe("session ordering", () => {
  it("puts attention first, then running, then idle, newest first within a group", () => {
    const s = snap({ a: "idle", b: "running", c: "needs-answer", d: "idle" });
    s.projects[0]!.sessions.find((x) => x.id === "d")!.updatedAt = 5;
    expect(allSessions(s).map((e) => e.session.id)).toEqual(["c", "b", "d", "a"]);
    expect([...s.projects[0]!.sessions].sort(compareSessions)[0]!.id).toBe("c");
  });
});

describe("projectCounts / projectTone", () => {
  it("counts sessions by bucket and only forwarded ports", () => {
    const s = snap({ a: "needs-permission", b: "running", c: "idle", d: "idle" });
    s.projects[0]!.runtime.ports = [
      { status: "forwarded", containerPort: 3000, hostPort: 3000 },
      { status: "failed", containerPort: 4000, reason: "x" },
    ];
    expect(projectCounts(s.projects[0]!)).toEqual({ attention: 1, running: 1, idle: 2, ports: 1 });
  });

  it("lets the worst signal win", () => {
    const view = snap({ a: "running" }).projects[0]!;
    expect(projectTone(view)).toBe("running");
    expect(projectTone({ ...view, sessions: [] })).toBe("ok");
    expect(projectTone({ ...view, runtime: { ...view.runtime, opencode: "unhealthy" } })).toBe("error");
    expect(projectTone(snap({ a: "needs-answer" }).projects[0]!)).toBe("attention");
    expect(projectTone({ ...view, sessions: [], runtime: { projectId: "p", containerState: "stopped", opencode: "absent" } })).toBe("off");
  });
});

describe("matches", () => {
  it("matches case-insensitively on any field and treats blank queries as a match", () => {
    expect(matches("", "x")).toBe(true);
    expect(matches("API", "my-api", undefined)).toBe(true);
    expect(matches("nope", "my-api")).toBe(false);
  });
});

describe("worktree helpers", () => {
  const view = (runtime: Partial<ProjectView["runtime"]> = {}): ProjectView => ({
    project: { id: "demo-1", name: "demo", path: "/src/demo", devcontainerPath: "/x" },
    runtime: { projectId: "demo-1", containerState: "running", opencode: "healthy", ...runtime },
    sessions: [],
    openUrl: "http://demo-1.localhost:7777/",
  });

  it("falls back to /workspaces/<name> before the first start", () => {
    expect(workspaceFolderOf(view())).toBe("/workspaces/demo");
    expect(workspaceFolderOf(view({ workspaceFolder: "/code/demo" }))).toBe("/code/demo");
  });

  it("labels worktree sessions by branch, else by folder", () => {
    const v = view({ worktrees: [{ path: "/workspaces/demo.worktrees/feature-x", branch: "feature/x" }] });
    expect(worktreeLabel(v, "/workspaces/demo")).toBeUndefined();
    expect(worktreeLabel(v, "/workspaces/demo.worktrees/feature-x")).toBe("feature/x");
    expect(worktreeLabel(v, "/home/node/.local/share/opencode/worktree/p/y")).toBe("y");
  });

  it("quotes only what needs quoting", () => {
    expect(shellQuote("/src/demo.worktrees/feature-x")).toBe("/src/demo.worktrees/feature-x");
    expect(shellQuote("/my dir/it's")).toBe(`'/my dir/it'\\''s'`);
  });

  it("builds a docker exec into the checkout as the remote user", () => {
    expect(containerShellCommand(view(), "/w")).toBeUndefined();
    expect(containerShellCommand(view({ containerName: "demo_c1", remoteUser: "node" }), "/workspaces/demo")).toBe(
      "docker exec -it -u node -w /workspaces/demo demo_c1 sh -c 'command -v bash >/dev/null && exec bash -l || exec sh -l'",
    );
  });
});

describe("pendingSummary and notifications", () => {
  it("says what is being asked", () => {
    const base = snap({ a: "needs-permission" }).projects[0].sessions[0];
    expect(pendingSummary(base)).toBeUndefined();
    expect(
      pendingSummary({
        ...base,
        pending: { permissions: [{ id: "p", sessionId: "a", action: "bash", resources: ["npm test", "npm run lint"] }], forms: [] },
      }),
    ).toBe("wants bash: npm test (+1 more)");
    expect(
      pendingSummary({ ...base, pending: { permissions: [], forms: [{ id: "f", sessionId: "a", title: "Which DB?", fields: [] }] } }),
    ).toBe("asks: Which DB?");
  });

  it("puts the ask in the notification title when it is known", () => {
    const next = snap({ a: "needs-permission" });
    next.projects[0].sessions[0].pending = {
      permissions: [{ id: "p", sessionId: "a", action: "bash", resources: ["npm test"] }],
      forms: [],
    };
    const [notice] = diffForNotifications(snap({ a: "running" }), next);
    expect(notice).toMatchObject({ title: "demo · wants bash: npm test", body: "T a" });
  });
});
