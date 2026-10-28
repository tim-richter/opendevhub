import { describe, expect, it } from "vitest";

import {
  dropHunk,
  fileTree,
  folderPaths,
  hunkAnnotations,
  hunkCount,
  pickSelection,
  optimisticStage,
  selectionAfter,
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

  it("shows no diff when none is wanted", () => {
    expect(pickSelection(data, null)).toBeUndefined();
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

describe(selectionAfter, () => {
  const at = (name: string) => ({ ...file, file: name });
  const data = {
    directory: "/d",
    staged: [at("s.ts")],
    unstaged: [at("a.ts"), at("b.ts"), at("c.ts")],
  };

  it("moves on to the next file of the list", () => {
    expect(
      selectionAfter(data, { file: "b.ts", staged: false }, "stage", {
        paths: ["b.ts"],
      })
    ).toEqual({ file: "c.ts", staged: false });
  });

  it("goes back to the previous file when none is left after it", () => {
    expect(
      selectionAfter(data, { file: "c.ts", staged: false }, "stage", {
        paths: ["c.ts"],
      })
    ).toEqual({ file: "b.ts", staged: false });
  });

  it("shows no diff when the list is empty", () => {
    expect(
      selectionAfter(data, { file: "c.ts", staged: false }, "stage", {})
    ).toBeNull();
  });

  it("stays on a file that still has hunks", () => {
    const selection = { file: "a.ts", staged: false };
    expect(
      selectionAfter(
        { ...data, unstaged: [file] },
        { file: "a.ts", staged: false },
        "stage",
        {
          file: "a.ts",
          hunk: 0,
        }
      )
    ).toEqual(selection);
  });

  it("leaves a selection alone when the other list changes", () => {
    const selection = { file: "s.ts", staged: true };
    expect(selectionAfter(data, selection, "stage", { paths: ["a.ts"] })).toBe(
      selection
    );
  });
});

describe("fileTree", () => {
  const file = (path: string) => ({
    additions: 1,
    deletions: 0,
    file: path,
    status: "modified" as const,
  });

  it("nests files under folders, folders first, and joins single-folder chains", () => {
    const tree = fileTree([
      file("tokens.db"),
      file("storage/layout.json"),
      file("apps/web/src/a.ts"),
      file("apps/web/src/lib/b.ts"),
      file("storage/.cache/x"),
    ]);
    expect(
      tree.map((n) => (n.kind === "folder" ? `${n.path}/` : n.name))
    ).toEqual(["apps/web/src/", "storage/", "tokens.db"]);
    const [apps, storage] = tree;
    expect(apps?.kind === "folder" && apps.files.map((f) => f.file)).toEqual([
      "apps/web/src/lib/b.ts",
      "apps/web/src/a.ts",
    ]);
    expect(
      storage?.kind === "folder" && storage.children.map((n) => n.name)
    ).toEqual([".cache", "layout.json"]);
    expect(folderPaths(tree)).toEqual([
      "apps/web/src",
      "apps/web/src/lib",
      "storage",
      "storage/.cache",
    ]);
  });
});
