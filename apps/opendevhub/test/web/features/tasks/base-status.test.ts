import { describe, expect, it } from "vitest";

import type { BasePosition } from "../../../../src/shared/types";
import {
  baseStatus,
  positionRows,
  pullBlocked,
  upstreamCounts,
} from "../../../../src/web/features/tasks/base-status";

const NOW = 10 * 60 * 60_000;
const position = (o: Partial<BasePosition> = {}): BasePosition => ({
  ahead: 0,
  base: "main",
  behind: 0,
  lastFetchAt: NOW - 5000,
  remote: "origin",
  update: { kind: "up-to-date" },
  upstream: "origin/main",
  ...o,
});

describe(baseStatus, () => {
  it("says what starting a task will do with the base, and when it last fetched", () => {
    const text = (o: Partial<BasePosition>) =>
      baseStatus(position(o), NOW).text;
    expect(text({ behind: 5, update: { commits: 5, kind: "ff" } })).toBe(
      "Will update main from origin first · 5 new commits · fetched just now"
    );
    expect(text({ behind: 1, update: { commits: 1, kind: "ff" } })).toBe(
      "Will update main from origin first · 1 new commit · fetched just now"
    );
    expect(text({ lastFetchAt: NOW - 2 * 60 * 60_000 })).toBe(
      "main is up to date with origin · fetched 2 h ago"
    );
    expect(
      text({ behind: 5, update: { kind: "skip", reason: "disabled" } })
    ).toBe(
      "main is 5 behind origin; starting from local main · fetched just now"
    );
    expect(text({ update: { kind: "skip", reason: "dirty" } })).toBe(
      "Starting from local main: the main checkout has uncommitted changes · fetched just now"
    );
    expect(text({ update: { kind: "skip", reason: "diverged" } })).toBe(
      "Starting from local main: main has local commits that aren't on origin · fetched just now"
    );
    expect(
      text({
        lastFetchAt: undefined,
        update: { kind: "skip", reason: "fetch-failed" },
      })
    ).toBe("Starting from local main: fetching origin failed · never fetched");
  });

  it("leaves out the fetch time when the base has no remote", () => {
    expect(
      baseStatus(
        position({
          base: "solo",
          lastFetchAt: undefined,
          remote: undefined,
          update: { kind: "skip", reason: "no-upstream" },
          upstream: undefined,
        }),
        NOW
      )
    ).toStrictEqual({
      text: "Starting from local solo: solo has no upstream",
      tone: "warn",
    });
  });
});

describe(pullBlocked, () => {
  it("allows Pull only when the base is behind and can be fast-forwarded", () => {
    expect(
      pullBlocked(position({ update: { commits: 2, kind: "ff" } }))
    ).toBeUndefined();
    expect(
      pullBlocked(position({ update: { kind: "skip", reason: "disabled" } }))
    ).toBeUndefined();
    expect(pullBlocked(position())).toBe("main is up to date");
    expect(
      pullBlocked(position({ update: { kind: "skip", reason: "dirty" } }))
    ).toBe("The main checkout has uncommitted changes");
  });
});

const review = {
  ahead: 2,
  behind: 0,
  dirty: false,
  pushed: false,
};

describe(positionRows, () => {
  it("places the branch between the base's upstream and its own, counting each run of commits once", () => {
    const rows = positionRows({
      base: "main",
      branch: "feat/x",
      mainCheckout: false,
      position: position({
        behind: 4,
        sinceBranch: 4,
        update: { commits: 4, kind: "ff" },
      }),
      review: { ...review, pushed: true, upstreamAhead: 1 },
    });
    expect(
      rows.map((r) => [r.key, r.lane, r.label, r.edge, r.note])
    ).toStrictEqual([
      ["upstream", 0, "origin/main", undefined, "+4 new"],
      ["base", 0, "main", 4, "4 behind"],
      ["branched", 0, "branch point", 0, undefined],
      ["head", 1, "feat/x", 2, "2 ahead"],
      ["pushed", 1, "pushed", 1, "1 unpushed"],
    ]);
  });

  it("says uncommitted on HEAD, and leaves the pushed row out until it was pushed", () => {
    const rows = positionRows({
      base: "main",
      branch: "feat/x",
      mainCheckout: false,
      position: position(),
      review: { ...review, dirty: true },
    });
    expect(rows.at(-1)).toMatchObject({
      key: "head",
      note: "uncommitted",
      tone: "warn",
    });
    expect(rows[1]).toMatchObject({ note: "up to date", tone: "ok" });
  });

  it("shows only the upstream and the base for a variant in the main checkout", () => {
    const rows = positionRows({
      base: "main",
      mainCheckout: true,
      position: position({ behind: 2 }),
      review: { ...review, dirty: true },
    });
    expect(rows.map((r) => [r.key, r.note])).toStrictEqual([
      ["upstream", undefined],
      ["base", "uncommitted"],
    ]);
  });

  it("starts from the base when there is no upstream", () => {
    expect(
      positionRows({
        base: "solo",
        mainCheckout: true,
        position: position({ base: "solo", upstream: undefined }),
      }).map((r) => r.key)
    ).toStrictEqual(["base"]);
  });
});

describe(upstreamCounts, () => {
  it("counts the branch against the base's upstream, or the base itself in the main checkout", () => {
    const p = position({ ahead: 1, behind: 2, branchAhead: 3, sinceBranch: 2 });
    expect(upstreamCounts(p, false)).toStrictEqual({
      ahead: 3,
      behind: 2,
      upstream: "origin/main",
    });
    expect(upstreamCounts(p, true)).toStrictEqual({
      ahead: 1,
      behind: 2,
      upstream: "origin/main",
    });
    expect(upstreamCounts(position(), false)).toBeUndefined();
    expect(upstreamCounts(undefined, false)).toBeUndefined();
  });
});
