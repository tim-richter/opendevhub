import { describe, expect, it } from "vitest";

import type { CheckResult, ChecksView } from "../../../../src/shared/types";
import {
  checkSections,
  checksState,
  fixPrompt,
  formatDuration,
  groupState,
  needingApproval,
  publishWarning,
  withRun,
} from "../../../../src/web/features/checks/checks";

const lint = {
  name: "lint",
  command: "pnpm lint",
  where: "container" as const,
  timeout: 900,
  approved: true,
  source: "team" as const,
};
const img = {
  name: "img",
  command: "docker build .",
  where: "host" as const,
  timeout: 900,
  approved: false,
  source: "team" as const,
};
const result = (
  name: string,
  status: CheckResult["status"],
  extra: Partial<CheckResult> = {}
): CheckResult => ({
  name,
  command: name === "img" ? img.command : lint.command,
  where: name === "img" ? "host" : "container",
  status,
  output: [],
  ...extra,
});
const view = (extra: Partial<ChecksView> = {}): ChecksView => ({
  checks: [lint, img],
  team: [lint, img],
  personal: [],
  teamWritable: true,
  errors: [],
  ...extra,
});
const run = (results: CheckResult[], finished = true) => ({
  directory: "/w",
  head: "abc",
  dirty: false,
  startedAt: 1,
  ...(finished ? { finishedAt: 2 } : {}),
  results,
});

describe(checksState, () => {
  it("covers each state", () => {
    expect(checksState(undefined)).toBe("none");
    expect(checksState(view({ checks: [] }))).toBe("none");
    expect(checksState(view())).toBe("idle");
    expect(
      checksState(
        view({ run: run([result("lint", "running")], false), current: true })
      )
    ).toBe("running");
    expect(
      checksState(
        view({
          run: run([result("lint", "passed"), result("img", "passed")]),
          current: false,
        })
      )
    ).toBe("stale");
    expect(
      checksState(
        view({
          run: run([result("lint", "passed"), result("img", "passed")]),
          current: true,
        })
      )
    ).toBe("passed");
    expect(
      checksState(
        view({
          run: run([result("lint", "passed"), result("img", "error")]),
          current: true,
        })
      )
    ).toBe("failed");
  });

  it("isn't passed while a configured check has no result, or its command changed since", () => {
    expect(
      checksState(view({ run: run([result("lint", "passed")]), current: true }))
    ).toBe("idle");
    const changed = run([
      result("lint", "passed", { command: "eslint" }),
      result("img", "passed"),
    ]);
    expect(checksState(view({ run: changed, current: true }))).toBe("idle");
  });
});

describe(publishWarning, () => {
  it("names failed checks and stays quiet when all passed", () => {
    expect(publishWarning(view({ checks: [] }))).toBeUndefined();
    expect(
      publishWarning(
        view({
          run: run([result("lint", "passed"), result("img", "passed")]),
          current: true,
        })
      )
    ).toBeUndefined();
    expect(
      publishWarning(
        view({
          run: run([result("lint", "failed"), result("img", "passed")]),
          current: true,
        })
      )
    ).toBe("Checks failed on this commit: lint.");
    expect(publishWarning(view())).toBe("Checks haven't run on this commit.");
  });
});

describe("needingApproval / withRun / formatDuration", () => {
  it("lists unapproved host checks among those selected", () => {
    expect(needingApproval(view()).map((c) => c.name)).toStrictEqual(["img"]);
    expect(needingApproval(view(), ["lint"])).toStrictEqual([]);
  });

  it("folds a polled run in", () => {
    const r = run([]);
    expect(withRun(view({ current: true }), r)).toMatchObject({
      run: r,
      current: true,
    });
    expect(withRun(view(), undefined).run).toBeUndefined();
  });

  it("formats durations", () => {
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
  });
});

describe("checkSections / groupState", () => {
  const test = { ...lint, name: "test", group: "fast" };
  const e2e = { ...lint, name: "e2e", group: "slow" };
  const types = { ...lint, name: "types", group: "fast" };

  it("puts ungrouped checks first, then each group in order", () => {
    expect(checkSections([test, lint, e2e, types])).toStrictEqual([
      { checks: [lint] },
      { checks: [test, types], group: "fast" },
      { checks: [e2e], group: "slow" },
    ]);
    expect(checkSections([test])).toStrictEqual([
      { checks: [test], group: "fast" },
    ]);
  });

  it("sums up a group from its checks' results", () => {
    const a = { ...lint, name: "a" };
    const b = { ...lint, name: "b" };
    expect(groupState(undefined, [a, b])).toStrictEqual({
      passed: 0,
      state: "idle",
    });
    expect(
      groupState(run([result("a", "passed"), result("b", "running")], false), [
        a,
        b,
      ])
    ).toStrictEqual({ passed: 1, state: "running" });
    expect(
      groupState(run([result("a", "passed"), result("b", "failed")]), [a, b])
    ).toStrictEqual({ passed: 1, state: "failed" });
    expect(
      groupState(run([result("a", "passed"), result("b", "passed")]), [a, b])
    ).toStrictEqual({ passed: 2, state: "passed" });
    expect(groupState(run([result("a", "passed")]), [a, b])).toStrictEqual({
      passed: 1,
      state: "idle",
    });
  });
});

describe(fixPrompt, () => {
  it("lists each failed check with the end of its output", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const text = fixPrompt({
      branch: "feat",
      results: [
        result("lint", "failed", { exitCode: 2, output }),
        result("img", "failed", { timedOut: true }),
        result("ok", "passed"),
      ],
    });
    expect(text).toContain("These project checks failed on feat.");
    expect(text).toContain("### lint: `pnpm lint` failed with exit code 2");
    expect(text).toContain("line 20\nline 21");
    expect(text).not.toContain("line 19\n");
    expect(text).toContain(
      "### img: `docker build .` (runs on the host, outside your container) timed out\n\n(no output)"
    );
    expect(text).not.toContain("### ok");
  });
});
