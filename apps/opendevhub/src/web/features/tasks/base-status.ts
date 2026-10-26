import { baseSkipText } from "../../../shared/base-position";
import type { BasePosition, ReviewData } from "../../../shared/types";
import { relativeTime } from "../../derive";

/** How the base status line reads, and whether it is good news, a warning or neither. */
export interface BaseStatus {
  text: string;
  tone: "ok" | "warn" | "muted";
}

/** What starting a task will do with its base, as the new task dialog says under Base. */
export const baseStatus = (
  position: BasePosition,
  now = Date.now()
): BaseStatus => {
  const { base, update, behind } = position;
  const remote = position.remote ?? "its upstream";
  let text: string;
  let tone: BaseStatus["tone"];
  if (update.kind === "ff") {
    text = `Will update ${base} from ${remote} first · ${update.commits} new ${update.commits === 1 ? "commit" : "commits"}`;
    tone = "ok";
  } else if (update.kind === "up-to-date") {
    text = `${base} is up to date with ${remote}`;
    tone = "ok";
  } else if (update.reason === "disabled") {
    text = `${base} is ${behind} behind ${remote}; starting from local ${base}`;
    tone = "muted";
  } else {
    text = `Starting from local ${base}: ${baseSkipText(update.reason, base, position.remote)}`;
    tone = "warn";
  }
  if (position.remote) {
    text += ` · ${
      position.lastFetchAt === undefined
        ? "never fetched"
        : `fetched ${relativeTime(position.lastFetchAt, now)}`
    }`;
  }
  return { text, tone };
};

/** Why Pull can't run, or undefined when it can (the base is behind and can be fast-forwarded). */
export const pullBlocked = (position: BasePosition): string | undefined => {
  const { update, base } = position;
  if (update.kind === "ff") {
    return undefined;
  }
  if (update.kind === "up-to-date") {
    return `${base} is up to date`;
  }
  if (update.reason === "disabled") {
    return undefined;
  }
  const why = baseSkipText(update.reason, base, position.remote);
  return `${why.charAt(0).toUpperCase()}${why.slice(1)}`;
};

/** One ref in the rail's Position diagram, top to bottom; `edge` counts the commits between it and the row above. */
export interface PositionRow {
  key: "upstream" | "base" | "branched" | "head" | "pushed";
  /** 0: the base's line; 1: the branch's. */
  lane: 0 | 1;
  label: string;
  /** A ref name, shown in monospace. */
  mono: boolean;
  note?: string;
  tone?: "ok" | "warn";
  edge?: number;
}

/**
 * The rows of a variant's Position diagram: the base's upstream, the local base, where the branch was made, its HEAD
 * and its pushed upstream. A variant in the main checkout is on the base itself, so it gets the first two only.
 */
export const positionRows = (input: {
  position?: BasePosition;
  review?: Pick<
    ReviewData,
    "ahead" | "behind" | "dirty" | "pushed" | "upstreamAhead"
  >;
  base: string;
  branch?: string;
  mainCheckout: boolean;
}): PositionRow[] => {
  const { position, review, base, mainCheckout } = input;
  const rows: PositionRow[] = [];
  if (position?.upstream) {
    const since = mainCheckout ? undefined : position.sinceBranch;
    rows.push({
      key: "upstream",
      label: position.upstream,
      lane: 0,
      mono: true,
      ...(since ? { note: `+${since} new` } : {}),
    });
  }
  const behind = position?.behind ?? 0;
  let baseNote: Pick<PositionRow, "note" | "tone"> = {};
  if (behind > 0) {
    baseNote = { note: `${behind} behind`, tone: "warn" };
  } else if (position?.upstream) {
    baseNote = { note: "up to date", tone: "ok" };
  }
  if (mainCheckout && review?.dirty) {
    baseNote = { note: "uncommitted", tone: "warn" };
  }
  rows.push({
    key: "base",
    label: base,
    lane: 0,
    mono: true,
    ...baseNote,
    ...(position?.upstream ? { edge: behind } : {}),
  });
  if (mainCheckout || !review) {
    return rows;
  }
  rows.push(
    {
      edge: review.behind,
      key: "branched",
      label: "branch point",
      lane: 0,
      mono: false,
    },
    {
      edge: review.ahead,
      key: "head",
      label: input.branch ?? "HEAD",
      lane: 1,
      mono: true,
      // The edge above already counts the commits; uncommitted changes matter more than repeating it.
      note: review.dirty ? "uncommitted" : `${review.ahead} ahead`,
      ...(review.dirty ? { tone: "warn" as const } : {}),
    }
  );
  if (review.pushed) {
    const unpushed = review.upstreamAhead;
    rows.push({
      key: "pushed",
      label: "pushed",
      lane: 1,
      mono: false,
      ...(unpushed === undefined ? {} : { edge: unpushed }),
      note:
        unpushed === undefined || unpushed === 0
          ? "all pushed"
          : `${unpushed} unpushed`,
      ...(unpushed ? { tone: "warn" as const } : {}),
    });
  }
  return rows;
};

/**
 * Commits ahead of and behind the base's upstream, for the status strip: the branch's own, or the base's when the
 * variant runs in the main checkout. Undefined until both are known.
 */
export const upstreamCounts = (
  position: BasePosition | null | undefined,
  mainCheckout: boolean
): { ahead: number; behind: number; upstream: string } | undefined => {
  if (!position?.upstream) {
    return undefined;
  }
  if (mainCheckout) {
    return {
      ahead: position.ahead,
      behind: position.behind,
      upstream: position.upstream,
    };
  }
  if (
    position.branchAhead === undefined ||
    position.sinceBranch === undefined
  ) {
    return undefined;
  }
  return {
    ahead: position.branchAhead,
    behind: position.sinceBranch,
    upstream: position.upstream,
  };
};
