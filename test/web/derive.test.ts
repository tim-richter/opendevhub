import { describe, expect, it } from "vitest";
import type { DashboardSnapshot, SessionStatus } from "../../src/shared/types";
import { attentionCounts, diffForNotifications, relativeTime } from "../../src/web/derive";

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
