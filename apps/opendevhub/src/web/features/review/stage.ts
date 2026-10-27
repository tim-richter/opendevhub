import type { DiffLineAnnotation } from "@pierre/diffs/react";

import type { ReviewFile, StageAction, StageData } from "../../../shared/types";
import { parsePatch } from "./review";
import type { HunkTarget } from "./review";

export type HunkAnnotation = DiffLineAnnotation<HunkTarget>;

/**
 * One annotation per hunk of a file's patch, below the hunk's last changed line, where the Keep and Undo buttons
 * of an AI review UI sit. A hunk that only deletes lines anchors to the old side.
 */
export const hunkAnnotations = (
  file: ReviewFile,
  staged: boolean
): HunkAnnotation[] => {
  if (!file.patch) {
    return [];
  }
  return parsePatch(file.patch).flatMap((hunk, index) => {
    const last = hunk.lines.findLast((l) => l.kind !== "ctx");
    if (!last) {
      return [];
    }
    const deleted = last.kind === "del";
    return [
      {
        lineNumber: (deleted ? last.oldNo : last.newNo) ?? 1,
        metadata: { file: file.file, hunk: index, staged },
        side: deleted ? "deletions" : "additions",
      },
    ];
  });
};

/** How many hunks the files hold in total. */
export const hunkCount = (files: readonly ReviewFile[]): number =>
  files.reduce(
    (n, f) => n + (f.patch ? (f.patch.match(/^@@ /gmu)?.length ?? 0) : 0),
    0
  );

const HUNK_START = /^@@ /mu;

/** The patch without its `index`-th hunk; undefined when no hunk is left. */
export const dropHunk = (patch: string, index: number): string | undefined => {
  const starts = [...patch.matchAll(new RegExp(HUNK_START, "gmu"))].map(
    (m) => m.index
  );
  if (starts.length <= 1) {
    return undefined;
  }
  const from = starts[index];
  if (from === undefined) {
    return patch;
  }
  return patch.slice(0, from) + patch.slice(starts[index + 1] ?? patch.length);
};

/** What a stage action names: one hunk, some files, or (nothing) everything. */
export interface StageChange {
  file?: string;
  hunk?: number;
  paths?: readonly string[];
}

const without = (
  files: ReviewFile[],
  { file, hunk, paths }: StageChange
): ReviewFile[] => {
  if (file !== undefined && hunk !== undefined) {
    return files.flatMap((f) => {
      if (f.file !== file || !f.patch) {
        return [f];
      }
      const patch = dropHunk(f.patch, hunk);
      return patch === undefined ? [] : [{ ...f, patch }];
    });
  }
  return paths ? files.filter((f) => !paths.includes(f.file)) : [];
};

/**
 * The view as it will be once the server has done `action`, so the hunk leaves the screen at the click. Only the
 * side it leaves is changed; the other side arrives with the server's answer.
 */
export const optimisticStage = (
  data: StageData,
  action: StageAction,
  change: StageChange
): StageData =>
  action === "unstage"
    ? { ...data, staged: without(data.staged, change) }
    : { ...data, unstaged: without(data.unstaged, change) };

/** The file whose diff is open: which list it was picked from matters, as a file can be in both. */
export interface Selection {
  file: string;
  staged: boolean;
}

/**
 * The selection to show: the wanted one while it still has changes, else the same file in the other list (its
 * last hunk was just kept or unstaged), else the first file waiting for a decision, else the first kept one.
 */
export const pickSelection = (
  data: StageData | undefined,
  want?: Selection
): Selection | undefined => {
  if (!data) {
    return undefined;
  }
  const has = (files: ReviewFile[], file: string) =>
    files.some((f) => f.file === file);
  if (want) {
    const { unstaged, staged } = data;
    if (has(want.staged ? staged : unstaged, want.file)) {
      return want;
    }
    if (has(want.staged ? unstaged : staged, want.file)) {
      return { file: want.file, staged: !want.staged };
    }
  }
  const first = data.unstaged[0] ?? data.staged[0];
  return first && { file: first.file, staged: data.unstaged.length === 0 };
};
