import { describe, expect, it } from "vitest";
import { type Observed, book, localDay, observe } from "../../src/server/usage";
import { rawSession } from "../helpers/fake-opencode";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const obs = (over: Partial<Observed> = {}): Observed => ({ sessionId: "s", projectId: "p", cost: 1, tokens: 100, updatedAt: at(2026, 10, 5), ...over });
const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
const taskMeta = (task: string, discarded = false) => ({ opendevhub: { task, variant: 1, of: 2, title: "t", ...(discarded ? { discarded } : {}) } });

describe("localDay", () => {
  it("formats the local date with zero padding", () => {
    expect(localDay(at(2026, 3, 7))).toBe("2026-03-07");
  });

  it("uses local time, not UTC, around midnight", () => {
    expect(localDay(new Date(2026, 9, 5, 23, 59).getTime())).toBe("2026-10-05");
    expect(localDay(new Date(2026, 9, 6, 0, 1).getTime())).toBe("2026-10-06");
  });
});

describe("observe", () => {
  it("rolls subagents up and dates the session by the latest update in its tree", () => {
    const out = observe("p", [
      rawSession("root", { cost: 1, tokens: tokens(10), time: { created: 1, updated: at(2026, 10, 4) } }),
      rawSession("sub", { parentID: "root", cost: 2, tokens: tokens(5), time: { created: 1, updated: at(2026, 10, 5) } }),
    ]);
    expect(out).toEqual([{ sessionId: "root", projectId: "p", cost: 3, tokens: 15, updatedAt: at(2026, 10, 5) }]);
  });

  it("tags a task's sessions, discarded ones included", () => {
    const out = observe("p", [rawSession("a", { metadata: taskMeta("tsk_1") }), rawSession("b", { metadata: taskMeta("tsk_1", true) })]);
    expect(out.map((o) => o.task)).toEqual(["tsk_1", "tsk_1"]);
  });

  it("counts a missing cost or tokens as 0", () => {
    const out = observe("p", [rawSession("a", { cost: 2 }), rawSession("b", { tokens: tokens(3) })]);
    expect(out.map(({ cost, tokens }) => ({ cost, tokens }))).toEqual([{ cost: 2, tokens: 0 }, { cost: 0, tokens: 3 }]);
  });
});

describe("book", () => {
  it("books everything on first sight, to the day of the last update", () => {
    expect(book([obs({ task: "tsk_1" })], new Map())).toEqual([
      { day: "2026-10-05", sessionId: "s", projectId: "p", task: "tsk_1", cost: 1, tokens: 100 },
    ]);
  });

  it("books only the increase", () => {
    const out = book([obs({ cost: 1.5, tokens: 150 })], new Map([["s", { cost: 1, tokens: 100 }]]));
    expect(out).toEqual([{ day: "2026-10-05", sessionId: "s", projectId: "p", cost: 0.5, tokens: 50 }]);
  });

  it("books nothing when nothing changed", () => {
    expect(book([obs()], new Map([["s", { cost: 1, tokens: 100 }]]))).toEqual([]);
  });

  it("books nothing for a decrease, and a later increase from the lower value", () => {
    expect(book([obs({ cost: 0.4, tokens: 40 })], new Map([["s", { cost: 1, tokens: 100 }]]))).toEqual([]);
    const later = book([obs({ cost: 0.6, tokens: 60 })], new Map([["s", { cost: 0.4, tokens: 40 }]]));
    expect(later[0]).toMatchObject({ cost: 0.6 - 0.4, tokens: 20 });
  });

  it("books a session that used tokens without a reported cost", () => {
    expect(book([obs({ cost: 0, tokens: 10 })], new Map())).toEqual([
      { day: "2026-10-05", sessionId: "s", projectId: "p", cost: 0, tokens: 10 },
    ]);
  });

  it("books nothing for a session that hasn't spent anything", () => {
    expect(book([obs({ cost: 0, tokens: 0 })], new Map())).toEqual([]);
  });
});
