import { describe, expect, it } from "vitest";

import type { CheckDef } from "../../../../src/shared/types";
import {
  fromDraft,
  mergeIntoTeam,
  moveRow,
  shiftRow,
  stillOwn,
  toDraft,
} from "../../../../src/web/features/checks/checks-draft";
import type { DraftGroup } from "../../../../src/web/features/checks/checks-draft";

const check = (name: string, group?: string): CheckDef => ({
  command: `run ${name}`,
  name,
  timeout: 900,
  where: "container",
  ...(group ? { group } : {}),
});

/** Each section's name and its rows' names, to compare drafts by shape. */
const shape = (draft: DraftGroup[]) =>
  draft.map((g) => [g.loose ? "-" : g.name, g.rows.map((r) => r.name)]);

const keyOf = (draft: DraftGroup[], name: string): number =>
  draft.flatMap((g) => g.rows).find((r) => r.name === name)?.key ?? -1;

describe("toDraft / fromDraft", () => {
  it("puts checks without a group first, then each group, and saves them back in that order", () => {
    const draft = toDraft([
      check("lint", "static"),
      check("test"),
      check("types", "static"),
      check("e2e", "slow"),
    ]);
    expect(shape(draft)).toStrictEqual([
      ["-", ["test"]],
      ["static", ["lint", "types"]],
      ["slow", ["e2e"]],
    ]);
    expect(fromDraft(draft)).toStrictEqual({
      checks: [
        check("test"),
        check("lint", "static"),
        check("types", "static"),
        check("e2e", "slow"),
      ],
    });
  });

  it("always has the section without a group, even when empty", () => {
    expect(shape(toDraft([check("a", "g")]))).toStrictEqual([
      ["-", []],
      ["g", ["a"]],
    ]);
  });

  it("drops empty groups and asks for names that are missing or used twice", () => {
    const draft = toDraft([check("a", "g"), check("b", "h")]);
    expect(
      fromDraft([...draft, { key: 99, name: "", rows: [] }])
    ).toStrictEqual(fromDraft(draft));
    expect(
      fromDraft(draft.map((g) => (g.name === "h" ? { ...g, name: " " } : g)))
    ).toStrictEqual({
      error: "Name each group, or remove the ones you don't need.",
    });
    expect(
      fromDraft(draft.map((g) => (g.name === "h" ? { ...g, name: "g " } : g)))
    ).toStrictEqual({ error: 'There are two groups named "g".' });
  });
});

describe("moveRow / shiftRow", () => {
  const draft = toDraft([
    check("a"),
    check("b", "g"),
    check("c", "g"),
    check("d", "h"),
  ]);

  it("moves a row within its group and into another one", () => {
    const g = draft[1]?.key ?? -1;
    const h = draft[2]?.key ?? -1;
    expect(shape(moveRow(draft, keyOf(draft, "c"), g, 0))).toStrictEqual([
      ["-", ["a"]],
      ["g", ["c", "b"]],
      ["h", ["d"]],
    ]);
    expect(shape(moveRow(draft, keyOf(draft, "a"), h, 1))).toStrictEqual([
      ["-", []],
      ["g", ["b", "c"]],
      ["h", ["d", "a"]],
    ]);
    expect(moveRow(draft, keyOf(draft, "b"), g, 0)).toBe(draft);
  });

  it("steps over a group's edge into the next group, and stops at the ends", () => {
    expect(shape(shiftRow(draft, keyOf(draft, "b"), 1))).toStrictEqual([
      ["-", ["a"]],
      ["g", ["c", "b"]],
      ["h", ["d"]],
    ]);
    expect(shape(shiftRow(draft, keyOf(draft, "c"), 1))).toStrictEqual([
      ["-", ["a"]],
      ["g", ["b"]],
      ["h", ["c", "d"]],
    ]);
    expect(shape(shiftRow(draft, keyOf(draft, "b"), -1))).toStrictEqual([
      ["-", ["a", "b"]],
      ["g", ["c"]],
      ["h", ["d"]],
    ]);
    expect(shiftRow(draft, keyOf(draft, "a"), -1)).toBe(draft);
    expect(shiftRow(draft, keyOf(draft, "d"), 1)).toBe(draft);
  });
});

describe("mergeIntoTeam / stillOwn", () => {
  const team = [check("lint"), check("test")];
  const mine = { ...check("test"), command: "pnpm test --bail" };

  it("replaces the team's checks of the same name in place and adds new ones", () => {
    expect(mergeIntoTeam(team, [mine, check("e2e", "slow")])).toStrictEqual([
      check("lint"),
      mine,
      check("e2e", "slow"),
    ]);
  });

  it("keeps only the user's entries that still differ from the team's, and every turned-off one", () => {
    const off = { disabled: true as const, name: "lint" };
    expect(
      stillOwn([mine, check("e2e"), off], [check("lint"), mine])
    ).toStrictEqual([check("e2e"), off]);
    expect(stillOwn([check("lint", "g")], [check("lint")])).toStrictEqual([
      check("lint", "g"),
    ]);
  });
});
