import { describe, expect, it } from "vitest";
import { deriveSessions } from "../../src/server/status";
import { rawSession } from "../helpers/fake-opencode";

const base = { active: new Set<string>(), permissions: [], forms: [] };

describe("deriveSessions", () => {
  it("maps sessions to idle summaries with titles and directories", () => {
    const out = deriveSessions("p", { ...base, sessions: [rawSession("ses_1", { title: "  " })] });
    expect(out).toEqual([
      { id: "ses_1", projectId: "p", title: "Untitled session", directory: "/workspaces/demo", updatedAt: 1, status: "idle" },
    ]);
  });

  it("applies precedence permission > answer > running", () => {
    const out = deriveSessions("p", {
      sessions: [rawSession("a"), rawSession("b"), rawSession("c")],
      active: new Set(["a", "b", "c"]),
      forms: [
        { id: "f1", sessionID: "a", title: "q" },
        { id: "f2", sessionID: "b", title: "q" },
      ],
      permissions: [{ id: "p1", sessionID: "a", action: "bash" }],
    });
    expect(Object.fromEntries(out.map((s) => [s.id, s.status]))).toEqual({
      a: "needs-permission",
      b: "needs-answer",
      c: "running",
    });
  });

  it("rolls child (subagent) sessions up into their root parent and hides them", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("root"), rawSession("child", { parentID: "root" }), rawSession("grand", { parentID: "child" })],
      permissions: [{ id: "p1", sessionID: "grand", action: "edit" }],
    });
    expect(out.map((s) => [s.id, s.status])).toEqual([["root", "needs-permission"]]);
  });

  it("survives parent cycles", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("x", { parentID: "y" }), rawSession("y", { parentID: "x" })],
      active: new Set(["x"]),
    });
    expect(out).toEqual([]);
  });

  it("hides archived sessions", () => {
    const out = deriveSessions("p", { ...base, sessions: [rawSession("a", { time: { created: 1, updated: 1, archived: 2 } })] });
    expect(out).toEqual([]);
  });

  it("sorts attention first, then most recently updated", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("old", { time: { created: 1, updated: 10 } }),
        rawSession("new", { time: { created: 1, updated: 20 } }),
        rawSession("ask", { time: { created: 1, updated: 5 } }),
      ],
      forms: [{ id: "f", sessionID: "ask", title: "?" }],
    });
    expect(out.map((s) => s.id)).toEqual(["ask", "new", "old"]);
  });
});
