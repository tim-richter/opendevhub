import { describe, expect, it } from "vitest";

import { contextOf, deriveSessions, rollUp } from "../../src/server/status";
import { rawSession } from "../helpers/fake-opencode";

const base = { active: new Set<string>(), permissions: [], forms: [] };

describe(deriveSessions, () => {
  it("tags sessions with the environment they run in, when given", () => {
    const sessions = [rawSession("ses_1")];
    expect(
      deriveSessions("p", { ...base, envId: "p-feat-0a1b", sessions })[0].envId
    ).toBe("p-feat-0a1b");
    expect(deriveSessions("p", { ...base, sessions })[0]).not.toHaveProperty(
      "envId"
    );
  });

  it("maps sessions to idle summaries with titles and directories", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("ses_1", { title: "  " })],
    });
    expect(out).toStrictEqual([
      {
        id: "ses_1",
        projectId: "p",
        title: "Untitled session",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "idle",
      },
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
    expect(Object.fromEntries(out.map((s) => [s.id, s.status]))).toStrictEqual({
      a: "needs-permission",
      b: "needs-answer",
      c: "running",
    });
  });

  it("rolls child (subagent) sessions up into their root parent and hides them", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("root"),
        rawSession("child", { parentID: "root" }),
        rawSession("grand", { parentID: "child" }),
      ],
      permissions: [{ id: "p1", sessionID: "grand", action: "edit" }],
    });
    expect(out.map((s) => [s.id, s.status])).toStrictEqual([
      ["root", "needs-permission"],
    ]);
  });

  it("survives parent cycles", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("x", { parentID: "y" }),
        rawSession("y", { parentID: "x" }),
      ],
      active: new Set(["x"]),
    });
    expect(out).toStrictEqual([]);
  });

  it("hides archived sessions", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("a", { time: { created: 1, updated: 1, archived: 2 } }),
      ],
    });
    expect(out).toStrictEqual([]);
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
    expect(out.map((s) => s.id)).toStrictEqual(["ask", "new", "old"]);
  });

  it("attaches pending items to the root session, keeping the asking session's id", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("root"), rawSession("child", { parentID: "root" })],
      permissions: [
        {
          id: "per_1",
          sessionID: "child",
          action: "bash",
          resources: ["npm test"],
          save: ["npm *"],
          message: "run tests",
        },
      ],
      forms: [
        {
          id: "frm_1",
          sessionID: "root",
          title: "Which DB?",
          fields: [{ key: "db", type: "string" }],
        },
      ],
    });
    expect(out[0].pending).toStrictEqual({
      permissions: [
        {
          id: "per_1",
          sessionId: "child",
          action: "bash",
          resources: ["npm test"],
          save: ["npm *"],
          message: "run tests",
        },
      ],
      forms: [
        {
          id: "frm_1",
          sessionId: "root",
          title: "Which DB?",
          fields: [{ key: "db", type: "string" }],
        },
      ],
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
    expect(byId.a.pending).toStrictEqual({
      permissions: [
        { id: "per_1", sessionId: "a", action: "edit", resources: [] },
      ],
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
    expect(
      out[0].pending?.permissions.map((p) => [p.id, p.createdAt])
    ).toStrictEqual([
      ["old", 100],
      ["new", 200],
    ]);
  });

  it("takes a string diff or patch from the metadata and ignores anything else", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("a")],
      permissions: [
        {
          id: "p1",
          sessionID: "a",
          action: "edit",
          metadata: { patch: "--- a\n+++ b\n" },
        },
        {
          id: "p2",
          sessionID: "a",
          action: "edit",
          metadata: { diff: { not: "a string" } },
        },
      ],
    });
    expect(out[0].pending?.permissions.map((p) => p.diff)).toStrictEqual([
      "--- a\n+++ b\n",
      undefined,
    ]);
  });

  it("carries task metadata, model, cost and tokens, and hides discarded variants", () => {
    const meta = (variant: number, extra = {}) => ({
      opendevhub: { task: "tsk_1", variant, of: 2, title: "Fix", ...extra },
    });
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("a", {
          metadata: meta(1),
          model: { id: "m", providerID: "p", variant: "default" },
          cost: 0.25,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 1,
            cache: { read: 100, write: 0 },
          },
        }),
        rawSession("b", { metadata: meta(2, { discarded: true }) }),
        rawSession("c", {
          metadata: { opendevhub: { task: "nope" } },
          model: { id: "n", providerID: "p", variant: "high" },
        }),
      ],
    });
    expect(out.map((s) => s.id)).toStrictEqual(["a", "c"]);
    expect(out[0]).toMatchObject({
      task: { task: "tsk_1", variant: 1, of: 2, title: "Fix" },
      model: { id: "m", providerID: "p" },
      cost: 0.25,
      tokens: 116,
    });
    expect(out[0].model).not.toHaveProperty("variant");
    expect(out[1]).not.toHaveProperty("task");
    expect(out[1].model).toStrictEqual({
      id: "n",
      providerID: "p",
      variant: "high",
    });
  });
});

const tokens = (input: number, output = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cache: { read: 7, write: 7 },
});

describe(rollUp, () => {
  it("adds children and grandchildren into the root, cache tokens included", () => {
    const out = rollUp([
      rawSession("root", {
        cost: 1,
        tokens: tokens(10, 5, 1),
        time: { created: 1, updated: 100 },
      }),
      rawSession("child", {
        parentID: "root",
        cost: 0.5,
        tokens: tokens(4),
        time: { created: 1, updated: 300 },
      }),
      rawSession("grand", {
        parentID: "child",
        cost: 0.25,
        tokens: tokens(2),
        time: { created: 1, updated: 200 },
      }),
    ]);
    expect([...out.keys()]).toStrictEqual(["root"]);
    expect(out.get("root")).toStrictEqual({
      cost: 1.75,
      tokens: 64,
      updatedAt: 300,
    });
  });

  it("leaves cost and tokens undefined when nobody reports them, and counts a missing one as absent", () => {
    const out = rollUp([rawSession("a"), rawSession("b", { cost: 2 })]);
    expect(out.get("a")).toStrictEqual({ updatedAt: 1 });
    expect(out.get("b")).toStrictEqual({ cost: 2, updatedAt: 1 });
  });

  it("treats a child whose parent is missing as its own root", () => {
    const out = rollUp([rawSession("orphan", { parentID: "gone", cost: 1 })]);
    expect(out.get("orphan")).toStrictEqual({ cost: 1, updatedAt: 1 });
  });

  it("survives parent cycles", () => {
    const out = rollUp([
      rawSession("x", { parentID: "y", cost: 1 }),
      rawSession("y", { parentID: "x", cost: 1 }),
    ]);
    expect([...out.values()].reduce((n, r) => n + (r.cost ?? 0), 0)).toBe(2);
  });
});

describe("deriveSessions cost", () => {
  it("includes the subagents' cost and tokens in the root's summary", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("root", { cost: 1, tokens: tokens(10) }),
        rawSession("child", { parentID: "root", cost: 0.5, tokens: tokens(5) }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "root", cost: 1.5, tokens: 43 });
  });
});

describe(contextOf, () => {
  it("is everything the newest assistant message with usage processed, skipping one still streaming", () => {
    expect(
      contextOf([
        {
          id: "m4",
          type: "assistant",
          tokens: { ...tokens(0), cache: { read: 0, write: 0 } },
        },
        { id: "m3", type: "user" },
        { id: "m2", type: "assistant", tokens: tokens(10, 5, 1) },
        { id: "m1", type: "assistant", tokens: tokens(1000) },
      ])
    ).toBe(30);
  });

  it("is undefined when no assistant message reports usage", () => {
    expect(contextOf([{ id: "m1", type: "user" }])).toBeUndefined();
  });
});

describe("deriveSessions context", () => {
  it("carries the root's own context, not its subagents'", () => {
    const out = deriveSessions("p", {
      ...base,
      contexts: new Map([
        ["root", 1234],
        ["child", 99],
      ]),
      sessions: [
        rawSession("root"),
        rawSession("child", { parentID: "root" }),
        rawSession("other"),
      ],
    });
    expect(out.find((s) => s.id === "root")?.context).toBe(1234);
    expect(out.find((s) => s.id === "other")).not.toHaveProperty("context");
  });
});
