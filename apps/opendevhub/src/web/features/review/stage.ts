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
  paths?: string[];
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
 * The selection to show: the wanted one while it still has changes, else the first file waiting for a decision,
 * else the first kept one. `null` is a wish to show no diff.
 */
export const pickSelection = (
  data: StageData | undefined,
  want?: Selection | null
): Selection | undefined => {
  if (!data || want === null) {
    return undefined;
  }
  if (
    want &&
    (want.staged ? data.staged : data.unstaged).some(
      (f) => f.file === want.file
    )
  ) {
    return want;
  }
  const first = data.unstaged[0] ?? data.staged[0];
  return first && { file: first.file, staged: data.unstaged.length === 0 };
};

/**
 * Where the selection goes once `action` has been done: it stays while its file has hunks left on its side,
 * else it moves to the next file of that list, else the previous one, else to no diff at all.
 */
export const selectionAfter = (
  data: StageData,
  selection: Selection | undefined,
  action: StageAction,
  change: StageChange
): Selection | null | undefined => {
  if (!selection || selection.staged !== (action === "unstage")) {
    return selection;
  }
  const files = selection.staged ? data.staged : data.unstaged;
  const after = optimisticStage(data, action, change);
  const left = selection.staged ? after.staged : after.unstaged;
  if (left.some((f) => f.file === selection.file)) {
    return selection;
  }
  const index = files.findIndex((f) => f.file === selection.file);
  const remains = (f: ReviewFile) => left.some((l) => l.file === f.file);
  const next =
    files.slice(index + 1).find(remains) ??
    files.slice(0, index).findLast(remains);
  return next ? { file: next.file, staged: selection.staged } : null;
};
