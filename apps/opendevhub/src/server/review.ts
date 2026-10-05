import type { ReviewBase, ReviewFile } from "../shared/types";
import type { RawFileDiff } from "./opencode/client";

export const PATCH_BUDGET_BYTES = 2 * 1024 * 1024;

/** A name git can only read as a ref: no leading "-", no whitespace. */
function usable(name: string | undefined): name is string {
  return !!name && /^[^-\s]\S*$/.test(name);
}

/** The base to compare with: the request, the base recorded at worktree creation, opencode's guess, the default branch. */
export function resolveBase(c: { request?: string; config?: string; opencode?: string; defaultBranch?: string }): ReviewBase | undefined {
  const order: [string | undefined, ReviewBase["source"]][] = [
    [c.request, "request"],
    [c.config, "config"],
    [c.opencode, "opencode"],
    [c.defaultBranch, "default"],
  ];
  for (const [name, source] of order) if (usable(name?.trim())) return { name: name!.trim(), source };
  return undefined;
}

/** The main checkout on its base shows its uncommitted work; anything else shows everything since the base. */
export function diffMode(isMain: boolean, branch: string | undefined, base: ReviewBase | undefined): "working" | "branch" {
  if (!base) return "working";
  return isMain && branch === base.name ? "working" : "branch";
}

export function isBinaryPatch(patch: string): boolean {
  return /^Binary files .* differ$/m.test(patch) || patch.includes("GIT binary patch");
}

/** Keeps patches within `budget` bytes in order; files that don't fit (and binaries) are listed with stats only. */
export function toReviewFiles(raw: RawFileDiff[], budget = PATCH_BUDGET_BYTES): { files: ReviewFile[]; truncated: boolean } {
  let used = 0;
  let truncated = false;
  const files = raw.map(({ file, status, additions, deletions, patch }): ReviewFile => {
    const stats = { file, status, additions, deletions };
    if (isBinaryPatch(patch)) return { ...stats, binary: true };
    const bytes = Buffer.byteLength(patch);
    if (used + bytes > budget) {
      truncated = true;
      return stats;
    }
    used += bytes;
    return { ...stats, patch };
  });
  return { files, truncated };
}
