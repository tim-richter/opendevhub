import { describe, expect, it } from "vitest";
import { deriveSessions } from "../../src/server/status";
import { rawSession } from "../helpers/fake-opencode";

const base = { active: new Set<string>(), permissions: [], forms: [] };

describe("deriveSessions", () => {
  it("tags sessions with the environment they run in, when given", () => {
    const sessions = [rawSession("ses_1")];
    expect(deriveSessions("p", { ...base, envId: "p-feat-0a1b", sessions })[0].envId).toBe("p-feat-0a1b");
    expect(deriveSessions("p", { ...base, sessions })[0]).not.toHaveProperty("envId");
  });

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
  it("attaches pending items to the root session, keeping the asking session's id", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("root"), rawSession("child", { parentID: "root" })],
      permissions: [
        { id: "per_1", sessionID: "child", action: "bash", resources: ["npm test"], save: ["npm *"], message: "run tests" },
      ],
      forms: [{ id: "frm_1", sessionID: "root", title: "Which DB?", fields: [{ key: "db", type: "string" }] }],
    });
    expect(out[0].pending).toEqual({
      permissions: [
        { id: "per_1", sessionId: "child", action: "bash", resources: ["npm test"], save: ["npm *"], message: "run tests" },
      ],
      forms: [{ id: "frm_1", sessionId: "root", title: "Which DB?", fields: [{ key: "db", type: "string" }] }],
    });
  });

  it("omits pending when nothing is waiting and tolerates missing resources and fields", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("a"), rawSession("b")],
      permissions: [{ id: "per_1", sessionID: "a", action: "edit" }],
      forms: [{ id: "frm_1", sessionID: "a", title: "q" }],
    });
    const byId = Object.fromEntries(out.map((s) => [s.id, s]));
    expect(byId.b.pending).toBeUndefined();
    expect(byId.a.pending).toEqual({
      permissions: [{ id: "per_1", sessionId: "a", action: "edit", resources: [] }],
      forms: [{ id: "frm_1", sessionId: "a", title: "q", fields: [] }],
    });
  });

  it("orders pending items oldest first by when they were first seen", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("a")],
      permissions: [
        { id: "new", sessionID: "a", action: "bash" },
        { id: "old", sessionID: "a", action: "bash" },
      ],
      firstSeen: new Map([
        ["new", 200],
        ["old", 100],
      ]),
    });
    expect(out[0].pending?.permissions.map((p) => [p.id, p.createdAt])).toEqual([
      ["old", 100],
      ["new", 200],
    ]);
  });

  it("takes a string diff or patch from the metadata and ignores anything else", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("a")],
      permissions: [
        { id: "p1", sessionID: "a", action: "edit", metadata: { patch: "--- a\n+++ b\n" } },
        { id: "p2", sessionID: "a", action: "edit", metadata: { diff: { not: "a string" } } },
      ],
    });
    expect(out[0].pending?.permissions.map((p) => p.diff)).toEqual(["--- a\n+++ b\n", undefined]);
  });

  it("carries task metadata, model, cost and tokens, and hides discarded variants", () => {
    const meta = (variant: number, extra = {}) => ({ opendevhub: { task: "tsk_1", variant, of: 2, title: "Fix", ...extra } });
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("a", {
          metadata: meta(1),
          model: { id: "m", providerID: "p", variant: "default" },
          cost: 0.25,
          tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 0 } },
        }),
        rawSession("b", { metadata: meta(2, { discarded: true }) }),
        rawSession("c", { metadata: { opendevhub: { task: "nope" } }, model: { id: "n", providerID: "p", variant: "high" } }),
      ],
    });
    expect(out.map((s) => s.id)).toEqual(["a", "c"]);
    expect(out[0]).toMatchObject({ task: { task: "tsk_1", variant: 1, of: 2, title: "Fix" }, model: { id: "m", providerID: "p" }, cost: 0.25, tokens: 16 });
    expect(out[0].model).not.toHaveProperty("variant");
    expect(out[1]).not.toHaveProperty("task");
    expect(out[1].model).toEqual({ id: "n", providerID: "p", variant: "high" });
  });
});
