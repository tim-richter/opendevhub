import { describe, expect, it } from "vitest";
import type { DashboardSnapshot, SessionStatus } from "../../src/shared/types";
import {
  allSessions,
  attentionCounts,
  compareSessions,
  diffForNotifications,
  matches,
  projectCounts,
  projectTone,
  relativeTime,
} from "../../src/web/derive";

function snap(statuses: Record<string, SessionStatus>): DashboardSnapshot {
  return {
    roots: [],
    preflight: { errors: [] },
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
