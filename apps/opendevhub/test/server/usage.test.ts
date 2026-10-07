import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UsageStore,
  book,
  daysBefore,
  localDay,
  observe,
  trackUsage,
} from "../../src/server/usage";
import type { Observed } from "../../src/server/usage";
import { rawSession } from "../helpers/fake-opencode";

const at = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m - 1, d, h).getTime();
const obs = (over: Partial<Observed> = {}): Observed => ({
  sessionId: "s",
  projectId: "p",
  cost: 1,
  tokens: 100,
  updatedAt: at(2026, 10, 5),
  ...over,
});
const tokens = (input: number) => ({
  input,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});
const taskMeta = (task: string, discarded = false) => ({
  opendevhub: {
    task,
    variant: 1,
    of: 2,
    title: "t",
    ...(discarded ? { discarded } : {}),
  },
});

describe(localDay, () => {
  it("formats the local date with zero padding", () => {
    expect(localDay(at(2026, 3, 7))).toBe("2026-03-07");
  });

  it("uses local time, not UTC, around midnight", () => {
    expect(localDay(new Date(2026, 9, 5, 23, 59).getTime())).toBe("2026-10-05");
    expect(localDay(new Date(2026, 9, 6, 0, 1).getTime())).toBe("2026-10-06");
  });
});

describe(daysBefore, () => {
  it("lists the days ending at a day, across month ends and a DST change", () => {
    expect(daysBefore("2026-03-02", 3)).toStrictEqual([
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(daysBefore("2026-10-26", 2)).toStrictEqual([
      "2026-10-25",
      "2026-10-26",
    ]);
  });
});

describe(observe, () => {
  it("rolls subagents up and dates the session by the latest update in its tree", () => {
    const out = observe("p", [
      rawSession("root", {
        cost: 1,
        tokens: tokens(10),
        time: { created: 1, updated: at(2026, 10, 4) },
      }),
      rawSession("sub", {
        parentID: "root",
        cost: 2,
        tokens: tokens(5),
        time: { created: 1, updated: at(2026, 10, 5) },
      }),
    ]);
    expect(out).toStrictEqual([
      {
        sessionId: "root",
        projectId: "p",
        cost: 3,
        tokens: 15,
        updatedAt: at(2026, 10, 5),
      },
    ]);
  });

  it("tags a task's sessions, discarded ones included", () => {
    const out = observe("p", [
      rawSession("a", { metadata: taskMeta("tsk_1") }),
      rawSession("b", { metadata: taskMeta("tsk_1", true) }),
    ]);
    expect(out.map((o) => o.task)).toStrictEqual(["tsk_1", "tsk_1"]);
  });

  it("counts a missing cost or tokens as 0", () => {
    const out = observe("p", [
      rawSession("a", { cost: 2 }),
      rawSession("b", { tokens: tokens(3) }),
    ]);
    expect(out.map(({ cost, tokens }) => ({ cost, tokens }))).toStrictEqual([
      { cost: 2, tokens: 0 },
      { cost: 0, tokens: 3 },
    ]);
  });
});

describe(book, () => {
  it("books everything on first sight, to the day of the last update", () => {
    expect(book([obs({ task: "tsk_1" })], new Map())).toStrictEqual([
      {
        day: "2026-10-05",
        sessionId: "s",
        projectId: "p",
        task: "tsk_1",
        cost: 1,
        tokens: 100,
      },
    ]);
  });

  it("books only the increase", () => {
    const out = book(
      [obs({ cost: 1.5, tokens: 150 })],
      new Map([["s", { cost: 1, tokens: 100 }]])
    );
    expect(out).toStrictEqual([
      {
        day: "2026-10-05",
        sessionId: "s",
        projectId: "p",
        cost: 0.5,
        tokens: 50,
      },
    ]);
  });

  it("books nothing when nothing changed", () => {
    expect(
      book([obs()], new Map([["s", { cost: 1, tokens: 100 }]]))
    ).toStrictEqual([]);
  });

  it("books nothing for a decrease, and a later increase from the lower value", () => {
    expect(
      book(
        [obs({ cost: 0.4, tokens: 40 })],
        new Map([["s", { cost: 1, tokens: 100 }]])
      )
    ).toStrictEqual([]);
    const later = book(
      [obs({ cost: 0.6, tokens: 60 })],
      new Map([["s", { cost: 0.4, tokens: 40 }]])
    );
    expect(later[0]).toMatchObject({ cost: 0.6 - 0.4, tokens: 20 });
  });

  it("books a session that used tokens without a reported cost", () => {
    expect(book([obs({ cost: 0, tokens: 10 })], new Map())).toStrictEqual([
      {
        day: "2026-10-05",
        sessionId: "s",
        projectId: "p",
        cost: 0,
        tokens: 10,
      },
    ]);
  });

  it("books nothing for a session that hasn't spent anything", () => {
    expect(book([obs({ cost: 0, tokens: 0 })], new Map())).toStrictEqual([]);
  });
});

describe(UsageStore, () => {
  const today = localDay(at(2026, 10, 5));
  const s = (
    id: string,
    cost: number,
    over: Parameters<typeof rawSession>[1] = {}
  ) =>
    rawSession(id, {
      cost,
      tokens: tokens(cost * 100),
      time: { created: 1, updated: at(2026, 10, 5) },
      ...over,
    });
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "odh-usage-"));
    dirs.push(d);
    return path.join(d, "usage.db");
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("books only the increase across two records, and says whether it booked", () => {
    const u = UsageStore.open(":memory:")!;
    expect(u.record("p", [s("a", 1)])).toBeTruthy();
    expect(u.record("p", [s("a", 1)])).toBeFalsy();
    expect(u.record("p", [s("a", 1.5)])).toBeTruthy();
    expect(u.totals(today).today).toStrictEqual({ cost: 1.5, tokens: 150 });
  });

  it("sums per project (today and all time), per task and for today", () => {
    const u = UsageStore.open(":memory:")!;
    u.record("p", [
      s("old", 2, { time: { created: 1, updated: at(2026, 10, 1) } }),
      s("v1", 1, {
        metadata: {
          opendevhub: { task: "tsk_1", variant: 1, of: 2, title: "t" },
        },
      }),
      s("v2", 0.5, {
        metadata: {
          opendevhub: {
            task: "tsk_1",
            variant: 2,
            of: 2,
            title: "t",
            discarded: true,
          },
        },
      }),
    ]);
    u.record("q", [s("other", 4)]);
    expect(u.totals(today)).toStrictEqual({
      today: { cost: 5.5, tokens: 550 },
      projects: {
        p: {
          today: { cost: 1.5, tokens: 150 },
          total: { cost: 3.5, tokens: 350 },
        },
        q: { today: { cost: 4, tokens: 400 }, total: { cost: 4, tokens: 400 } },
      },
      tasks: { tsk_1: { cost: 1.5, tokens: 150 } },
    });
  });

  it("keeps a session's spend after it disappears, and books nothing twice when it comes back", () => {
    const u = UsageStore.open(":memory:")!;
    u.record("p", [s("a", 1), s("b", 2)]);
    u.record("p", [s("b", 2)]);
    expect(u.totals(today).today.cost).toBe(3);
    expect(u.record("p", [s("a", 1), s("b", 2)])).toBeFalsy();
    expect(u.totals(today).today.cost).toBe(3);
  });

  it("reports all time, today, a chosen day by project, and the last days ending today", () => {
    const u = UsageStore.open(":memory:")!;
    u.record("p", [
      s("old", 2, { time: { created: 1, updated: at(2026, 10, 1) } }),
      s("a", 1),
    ]);
    u.record("q", [
      s("b", 4, { time: { created: 1, updated: at(2026, 10, 1) } }),
    ]);
    const r = u.report("2026-10-01", today, 3);
    expect(r).toStrictEqual({
      total: { cost: 7, tokens: 700 },
      today: { cost: 1, tokens: 100 },
      day: "2026-10-01",
      dayTotal: { cost: 6, tokens: 600 },
      projects: [
        { projectId: "q", cost: 4, tokens: 400 },
        { projectId: "p", cost: 2, tokens: 200 },
      ],
      days: [
        { day: "2026-10-03", cost: 0, tokens: 0 },
        { day: "2026-10-04", cost: 0, tokens: 0 },
        { day: "2026-10-05", cost: 1, tokens: 100 },
      ],
    });
    expect(
      UsageStore.open(":memory:")!.report("2026-09-01", today, 1)
    ).toStrictEqual({
      total: { cost: 0, tokens: 0 },
      today: { cost: 0, tokens: 0 },
      day: "2026-09-01",
      dayTotal: { cost: 0, tokens: 0 },
      projects: [],
      days: [{ day: today, cost: 0, tokens: 0 }],
    });
  });

  it("reports zeros when nothing was booked", () => {
    expect(UsageStore.open(":memory:")!.totals(today)).toStrictEqual({
      today: { cost: 0, tokens: 0 },
      projects: {},
      tasks: {},
    });
  });

  it("books nothing twice after reopening the file", () => {
    const file = tmp();
    const first = UsageStore.open(file)!;
    first.record("p", [s("a", 1)]);
    first.close();
    const second = UsageStore.open(file)!;
    expect(second.record("p", [s("a", 1)])).toBeFalsy();
    expect(second.totals(today).today.cost).toBe(1);
    second.close();
  });

  it("returns undefined and logs once for a file that isn't a database", () => {
    const file = tmp();
    fs.writeFileSync(
      file,
      "not a database, just text that is long enough to be read as a header".repeat(
        10
      )
    );
    const log = vi.fn();
    expect(UsageStore.open(file, log)).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/usage tracking is off/u);
  });

  it("returns undefined for a database written by a newer opendevhub", () => {
    const file = tmp();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 2");
    db.close();
    const log = vi.fn();
    expect(UsageStore.open(file, log)).toBeUndefined();
    expect(log.mock.calls[0][0]).toMatch(/newer opendevhub/u);
  });
});

describe(trackUsage, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets totals at once, after each booking, and when the day changes without new spend", () => {
    let clock = new Date(2026, 9, 5, 23, 59, 30).getTime();
    const u = UsageStore.open(":memory:")!;
    const store = { setUsage: vi.fn() };
    const tracker = trackUsage(u, store, () => clock);
    expect(store.setUsage).toHaveBeenLastCalledWith({
      today: { cost: 0, tokens: 0 },
      projects: {},
      tasks: {},
    });

    tracker.record("p", [
      rawSession("a", {
        cost: 1,
        tokens: tokens(10),
        time: { created: 1, updated: clock },
      }),
    ]);
    expect(store.setUsage.mock.lastCall![0].today).toStrictEqual({
      cost: 1,
      tokens: 10,
    });

    const calls = store.setUsage.mock.calls.length;
    tracker.record("p", [
      rawSession("a", {
        cost: 1,
        tokens: tokens(10),
        time: { created: 1, updated: clock },
      }),
    ]);
    expect(store.setUsage).toHaveBeenCalledTimes(calls);

    clock = new Date(2026, 9, 6, 0, 0, 30).getTime();
    vi.advanceTimersByTime(60_000);
    expect(store.setUsage.mock.lastCall![0].today).toStrictEqual({
      cost: 0,
      tokens: 0,
    });
    expect(store.setUsage.mock.lastCall![0].projects.p.total).toStrictEqual({
      cost: 1,
      tokens: 10,
    });
    tracker.stop();
  });

  it("logs and keeps the old totals when reading them fails", () => {
    const store = { setUsage: vi.fn() };
    const log = vi.fn();
    const broken = {
      record: () => true,
      totals: () => {
        throw new Error("disk I/O error");
      },
    };
    const tracker = trackUsage(broken, store, Date.now, log);
    tracker.record("p", []);
    expect(store.setUsage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/disk I\/O error/u));
    tracker.stop();
  });
});
