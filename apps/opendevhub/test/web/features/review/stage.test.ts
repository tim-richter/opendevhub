import { describe, expect, it } from "vitest";

import {
  dropHunk,
  hunkAnnotations,
  hunkCount,
  pickSelection,
  optimisticStage,
} from "../../../../src/web/features/review/stage";

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-two
+deux
 three
@@ -20,3 +20,2 @@
 twenty
-gone
 end
`;
const file = {
  additions: 1,
  deletions: 2,
  file: "a.ts",
  patch,
  status: "modified" as const,
};

describe(hunkAnnotations, () => {
  it("anchors each hunk to its last changed line", () => {
    expect(hunkAnnotations(file, false)).toEqual([
      {
        lineNumber: 2,
        metadata: { file: "a.ts", hunk: 0, staged: false },
        side: "additions",
      },
      {
        lineNumber: 21,
        metadata: { file: "a.ts", hunk: 1, staged: false },
        side: "deletions",
      },
    ]);
  });

  it("has none without a patch", () => {
    expect(hunkAnnotations({ ...file, patch: undefined }, true)).toEqual([]);
  });
});

describe(hunkCount, () => {
  it("adds up the hunks of every file", () => {
    expect(hunkCount([file, file])).toBe(4);
  });
});

describe(dropHunk, () => {
  it("removes one hunk and keeps the header", () => {
    const rest = dropHunk(patch, 0);
    expect(rest).toContain("+++ b/a.ts");
    expect(rest).toContain("-gone");
    expect(rest).not.toContain("+deux");
  });

  it("is undefined when it was the last hunk", () => {
    expect(dropHunk(dropHunk(patch, 0) ?? "", 0)).toBeUndefined();
  });
});

describe(optimisticStage, () => {
  const data = { directory: "/d", staged: [file], unstaged: [file] };

  it("takes a kept or undone hunk out of the changes", () => {
    const next = optimisticStage(data, "stage", { file: "a.ts", hunk: 1 });
    expect(hunkCount(next.unstaged)).toBe(1);
    expect(next.staged).toBe(data.staged);
  });

  it("takes an unstaged hunk out of the kept side", () => {
    const next = optimisticStage(data, "unstage", { file: "a.ts", hunk: 0 });
    expect(hunkCount(next.staged)).toBe(1);
    expect(next.unstaged).toBe(data.unstaged);
  });

  it("clears a side for all, and drops named files", () => {
    expect(optimisticStage(data, "stage", {}).unstaged).toEqual([]);
    expect(
      optimisticStage(data, "stage", { paths: ["a.ts"] }).unstaged
    ).toEqual([]);
  });
});

describe(pickSelection, () => {
  const other = { ...file, file: "b.ts" };
  const data = { directory: "/w", staged: [other], unstaged: [file] };

  it("keeps a selection that still has changes", () => {
    expect(pickSelection(data, { file: "b.ts", staged: true })).toEqual({
      file: "b.ts",
      staged: true,
    });
  });

  it("follows a file to the other list", () => {
    expect(pickSelection(data, { file: "b.ts", staged: false })).toEqual({
      file: "b.ts",
      staged: true,
    });
  });

  it("falls back to the first file waiting for a decision", () => {
    expect(pickSelection(data, { file: "gone.ts", staged: false })).toEqual({
      file: "a.ts",
      staged: false,
    });
  });

  it("falls back to a kept file when nothing waits", () => {
    expect(pickSelection({ ...data, unstaged: [] })).toEqual({
      file: "b.ts",
      staged: true,
    });
  });

  it("has none without changes", () => {
    expect(
      pickSelection({ ...data, staged: [], unstaged: [] })
    ).toBeUndefined();
  });
});
