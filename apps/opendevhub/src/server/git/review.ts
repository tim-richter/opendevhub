import type {
  ReviewBase,
  ReviewFile,
  ReviewMode,
  ReviewTurnPrompt,
} from "../../shared/types";
import type { RawFileDiff, RawUserMessage } from "../opencode/client";

export const PATCH_BUDGET_BYTES = 2 * 1024 * 1024;

/** A name git can only read as a ref: no leading "-", no whitespace. */
const usable = (name: string | undefined): name is string =>
  !!name && /^[^-\s]\S*$/u.test(name);

/** The base to compare with: the request, the base recorded at worktree creation, opencode's guess, the default branch. */
export const resolveBase = (c: {
  request?: string;
  config?: string;
  opencode?: string;
  defaultBranch?: string;
}): ReviewBase | undefined => {
  const order: [string | undefined, ReviewBase["source"]][] = [
    [c.request, "request"],
    [c.config, "config"],
    [c.opencode, "opencode"],
    [c.defaultBranch, "default"],
  ];
  for (const [name, source] of order) {
    const trimmed = name?.trim();
    if (trimmed && usable(trimmed)) {
      return { name: trimmed, source };
    }
  }
  return undefined;
};

/**
 * The diff asked for. Comparing with the base needs one and a turn needs a session; without them the review shows
 * uncommitted changes.
 */
export const diffMode = (
  requested: ReviewMode | undefined,
  base: ReviewBase | undefined,
  hasSession = false
): ReviewMode => {
  if (requested === "branch" && base) {
    return "branch";
  }
  if (requested === "turn" && hasSession) {
    return "turn";
  }
  return "working";
};

/** How many recent prompts the turn picker offers. */
export const TURN_PROMPTS = 20;
const PROMPT_PREVIEW_CHARS = 120;

/** A user message id opencode accepts as a turn (`from`). */
export const isMessageId = (id: string): boolean => /^msg_[\w-]+$/u.test(id);

/** A prompt's first non-empty line, cut short, for the turn picker. */
const preview = (text: string): string => {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return line.length > PROMPT_PREVIEW_CHARS
    ? `${line.slice(0, PROMPT_PREVIEW_CHARS - 1)}…`
    : line;
};

export const toTurnPrompts = (raw: RawUserMessage[]): ReviewTurnPrompt[] =>
  raw.map((m) => ({
    created: m.time.created,
    id: m.id,
    text: preview(m.text),
  }));

export const isBinaryPatch = (patch: string): boolean =>
  /^Binary files .* differ$/mu.test(patch) ||
  /^GIT binary patch$/mu.test(patch);

export interface PatchLimits {
  /** Bytes of patches in one response. */
  budget: number;
  /** A file changing more lines than this is large. */
  fileLines: number;
  /** A patch bigger than this is large; opencode's patches hold the whole file, so a small change to a lockfile is big. */
  fileBytes: number;
}

export const OVERVIEW_LIMITS: PatchLimits = {
  budget: PATCH_BUDGET_BYTES,
  fileBytes: 256 * 1024,
  fileLines: 400,
};
export const NO_LIMITS: PatchLimits = {
  budget: Infinity,
  fileBytes: Infinity,
  fileLines: Infinity,
};

/**
 * Keeps patches within the budget in order; files that don't fit, large ones (marked) and binaries are listed
 * with stats only, for the review to load one by one.
 */
export const toReviewFiles = (
  raw: RawFileDiff[],
  limits: Partial<PatchLimits> = {}
): { files: ReviewFile[]; truncated: boolean } => {
  const { budget, fileLines, fileBytes } = { ...OVERVIEW_LIMITS, ...limits };
  let used = 0;
  let truncated = false;
  const files = raw.map(
    ({ file, status, additions, deletions, patch }): ReviewFile => {
      const stats = { additions, deletions, file, status };
      if (isBinaryPatch(patch)) {
        return { ...stats, binary: true };
      }
      const bytes = Buffer.byteLength(patch);
      if (additions + deletions > fileLines || bytes > fileBytes) {
        return { ...stats, large: true };
      }
      if (used + bytes > budget) {
        truncated = true;
        return stats;
      }
      used += bytes;
      return { ...stats, patch };
    }
  );
  return { files, truncated };
};
