import type { ReviewFile } from "../../shared/types";

const FILE_START = /^diff --git /mu;
const HUNK_START = /^@@ /mu;
const NEW_FILE = /^\+\+\+ b\/(?<path>.+)$/mu;
const OLD_FILE = /^--- a\/(?<path>.+)$/mu;
const GIT_HEADER = /^diff --git a\/(?<a>.+) b\/(?<b>.+)$/mu;

/** One file of a `git diff`: its header lines and its hunks, each hunk with its `@@` line. */
export interface FilePatch {
  file: string;
  status: ReviewFile["status"];
  header: string;
  hunks: string[];
}

const statusOf = (header: string): ReviewFile["status"] => {
  if (/^new file mode/mu.test(header)) {
    return "added";
  }
  return /^deleted file mode/mu.test(header) ? "deleted" : "modified";
};

const pathOf = (header: string): string => {
  const named = NEW_FILE.exec(header) ?? OLD_FILE.exec(header);
  if (named?.groups?.path) {
    return named.groups.path;
  }
  // Binary files and pure renames have no ---/+++ lines.
  return GIT_HEADER.exec(header)?.groups?.b ?? "";
};

/** Splits the output of `git diff` into one entry per file. Binary files have a header and no hunks. */
export const splitDiff = (diff: string): FilePatch[] => {
  const starts: number[] = [];
  for (const m of diff.matchAll(new RegExp(FILE_START, "gmu"))) {
    starts.push(m.index);
  }
  return starts.map((start, i) => {
    const chunk = diff.slice(start, starts[i + 1] ?? diff.length);
    const first = HUNK_START.exec(chunk)?.index ?? chunk.length;
    const header = chunk.slice(0, first);
    const hunks: string[] = [];
    const hunkStarts: number[] = [];
    for (const m of chunk.matchAll(new RegExp(HUNK_START, "gmu"))) {
      hunkStarts.push(m.index);
    }
    for (const [h, at] of hunkStarts.entries()) {
      hunks.push(chunk.slice(at, hunkStarts[h + 1] ?? chunk.length));
    }
    return { file: pathOf(header), header, hunks, status: statusOf(header) };
  });
};

/** A patch holding only hunk `index` of `file`, ready for `git apply`; undefined when there is no such hunk. */
export const hunkPatch = (
  diff: string,
  file: string,
  index: number
): string | undefined => {
  const found = splitDiff(diff).find((f) => f.file === file);
  const hunk = found?.hunks[index];
  if (!found || hunk === undefined) {
    return undefined;
  }
  return `${found.header}${hunk.endsWith("\n") ? hunk : `${hunk}\n`}`;
};
