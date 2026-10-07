import { describe, expect, it } from "vitest";

import type { DashboardSnapshot, UsageTotals } from "../../src/shared/types";
import {
  formatUsage,
  projectName,
  projectUsage,
  share,
  shiftDay,
  taskUsage,
} from "../../src/web/usage";

const usage: UsageTotals = {
  today: { cost: 1.24, tokens: 380_000 },
  projects: {
    p: {
      today: { cost: 0.4, tokens: 1000 },
      total: { cost: 12.8, tokens: 2_000_000 },
    },
  },
  tasks: { tsk_1: { cost: 2.1, tokens: 610_000 } },
};
const snap = (u?: UsageTotals): DashboardSnapshot => ({
  roots: [],
  preflight: { errors: [] },
  editors: [],
  projects: [],
  ...(u ? { usage: u } : {}),
});

describe(formatUsage, () => {
  it("joins cost and tokens", () => {
    expect(formatUsage({ cost: 1.24, tokens: 380_000 })).toBe(
      "$1.24 · 380.0k tokens"
    );
    expect(formatUsage({ cost: 0, tokens: 0 })).toBe("$0.00 · 0 tokens");
  });
});

describe(projectUsage, () => {
  it("is undefined without a ledger, zeros for a project with no spend", () => {
    expect(projectUsage(undefined, "p")).toBeUndefined();
    expect(projectUsage(snap(), "p")).toBeUndefined();
    expect(projectUsage(snap(usage), "q")).toStrictEqual({
      today: { cost: 0, tokens: 0 },
      total: { cost: 0, tokens: 0 },
    });
    expect(projectUsage(snap(usage), "p")).toStrictEqual(usage.projects.p);
  });
});

describe(taskUsage, () => {
  it("is the task's total, or undefined when it has none", () => {
    expect(taskUsage(snap(usage), "tsk_1")).toStrictEqual({
      cost: 2.1,
      tokens: 610_000,
    });
    expect(taskUsage(snap(usage), "tsk_2")).toBeUndefined();
    expect(taskUsage(snap(), "tsk_1")).toBeUndefined();
  });
});

describe("usage page helpers", () => {
  it("steps days across month and year ends", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2026-10-25", 1)).toBe("2026-10-26");
  });

  it("names projects, falling back to the id of a removed one", () => {
    const snapshot = {
      projects: [{ project: { id: "p", name: "Inventory" } }],
    } as unknown as DashboardSnapshot;
    expect(projectName(snapshot, "p")).toBe("Inventory");
    expect(projectName(snapshot, "gone")).toBe("gone");
  });

  it("gives a project's share of the day's cost as a whole percentage", () => {
    expect(share(1, 3)).toBe("33%");
    expect(share(0.001, 10)).toBe("<1%");
    expect(share(0, 0)).toBe("—");
  });
});
