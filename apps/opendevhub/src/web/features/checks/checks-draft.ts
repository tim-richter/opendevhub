import type { CheckDef, CheckOverlay, CheckWhere } from "../../../shared/types";
import { checkSections } from "./checks";

export const DEFAULT_TIMEOUT = 900;

/** A check as the editor holds it: text fields, keyed so rows keep their inputs while moving. */
export interface DraftRow {
  key: number;
  name: string;
  command: string;
  where: CheckWhere;
  timeout: string;
}

/** A section of the editor. The first is always the checks without a group (`loose`). */
export interface DraftGroup {
  key: number;
  name: string;
  loose?: true;
  rows: DraftRow[];
}

let nextKey = 1;
export const newKey = (): number => nextKey++;

export const emptyRow = (): DraftRow => ({
  command: "",
  key: newKey(),
  name: "",
  timeout: String(DEFAULT_TIMEOUT),
  where: "container",
});

const toRow = (c: CheckDef): DraftRow => ({
  command: c.command,
  key: newKey(),
  name: c.name,
  timeout: String(c.timeout),
  where: c.where,
});

/** The checks in editor sections: those without a group first, then each group in order. */
export const toDraft = (checks: CheckDef[]): DraftGroup[] => {
  const sections = checkSections(checks);
  const loose = sections.find((s) => !s.group);
  return [
    {
      key: newKey(),
      loose: true,
      name: "",
      rows: (loose?.checks ?? []).map(toRow),
    },
    ...sections
      .filter((s) => s.group)
      .map((s) => ({
        key: newKey(),
        name: s.group ?? "",
        rows: s.checks.map(toRow),
      })),
  ];
};

/** The checks to save, in the editor's order, or what's wrong with the groups. Empty groups are dropped. */
export const fromDraft = (
  draft: DraftGroup[]
): { checks: CheckDef[] } | { error: string } => {
  const named = draft.filter((g) => !g.loose && g.rows.length > 0);
  if (named.some((g) => !g.name.trim())) {
    return { error: "Name each group, or remove the ones you don't need." };
  }
  const names = named.map((g) => g.name.trim());
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) {
    return { error: `There are two groups named "${twice}".` };
  }
  return {
    checks: draft.flatMap((g) =>
      g.rows.map((r) => ({
        command: r.command.trim(),
        name: r.name.trim(),
        timeout: Number(r.timeout) || DEFAULT_TIMEOUT,
        where: r.where,
        ...(g.loose ? {} : { group: g.name.trim() }),
      }))
    ),
  };
};

const locate = (
  draft: DraftGroup[],
  rowKey: number
): { group: number; index: number } | undefined => {
  for (const [group, g] of draft.entries()) {
    const index = g.rows.findIndex((r) => r.key === rowKey);
    if (index !== -1) {
      return { group, index };
    }
  }
  return undefined;
};

/** Moves a row to `index` in the group keyed `groupKey` (its index after the move). */
export const moveRow = (
  draft: DraftGroup[],
  rowKey: number,
  groupKey: number,
  index: number
): DraftGroup[] => {
  const from = locate(draft, rowKey);
  const to = draft.findIndex((g) => g.key === groupKey);
  if (!from || to === -1) {
    return draft;
  }
  const row = draft[from.group]?.rows[from.index];
  if (!row || (from.group === to && from.index === index)) {
    return draft;
  }
  const without = draft.map((g, i) =>
    i === from.group
      ? { ...g, rows: g.rows.filter((r) => r.key !== rowKey) }
      : g
  );
  return without.map((g, i) => {
    if (i !== to) {
      return g;
    }
    const rows = [...g.rows];
    rows.splice(Math.max(0, Math.min(index, rows.length)), 0, row);
    return { ...g, rows };
  });
};

/**
 * Moves a row one place up or down. Past the first or last row of its group it moves into the
 * neighbouring group, at the end nearest to where it came from.
 */
export const shiftRow = (
  draft: DraftGroup[],
  rowKey: number,
  by: -1 | 1
): DraftGroup[] => {
  const at = locate(draft, rowKey);
  const group = at && draft[at.group];
  if (!at || !group) {
    return draft;
  }
  const index = at.index + by;
  if (index >= 0 && index < group.rows.length) {
    return moveRow(draft, rowKey, group.key, index);
  }
  const next = draft[at.group + by];
  if (!next) {
    return draft;
  }
  return moveRow(draft, rowKey, next.key, by === 1 ? 0 : next.rows.length);
};

/** The user's own checks laid into the team's list: same names replace the team's, new ones are added. */
export const mergeIntoTeam = (
  team: CheckDef[],
  own: CheckDef[]
): CheckDef[] => [
  ...team.map((t) => own.find((o) => o.name === t.name) ?? t),
  ...own.filter((o) => !team.some((t) => t.name === o.name)),
];

const same = (a: CheckDef, b: CheckDef): boolean =>
  a.name === b.name &&
  a.command === b.command &&
  a.where === b.where &&
  a.timeout === b.timeout &&
  (a.group ?? "") === (b.group ?? "");

/** The user's own entries that still change something once `team` is saved; turned-off ones always do. */
export const stillOwn = (
  personal: CheckOverlay[],
  team: CheckDef[]
): CheckOverlay[] =>
  personal.filter((c) => "disabled" in c || !team.some((t) => same(t, c)));
