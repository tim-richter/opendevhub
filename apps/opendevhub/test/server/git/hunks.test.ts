import { describe, expect, it } from "vitest";

import { hunkPatch, splitDiff } from "../../../src/server/git/hunks";

const DIFF = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-one
+uno
 two
@@ -10,2 +10,3 @@
 ten
+eleven
 twelve
diff --git a/new.ts b/new.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+hello
`;

describe(splitDiff, () => {
  it("lists each file with its status and hunks", () => {
    const files = splitDiff(DIFF);
    expect(files.map((f) => [f.file, f.status, f.hunks.length])).toEqual([
      ["a.ts", "modified", 2],
      ["new.ts", "added", 1],
    ]);
  });

  it("is empty for an empty diff", () => {
    expect(splitDiff("")).toEqual([]);
  });
});

describe(hunkPatch, () => {
  it("keeps the file header and only the chosen hunk", () => {
    const patch = hunkPatch(DIFF, "a.ts", 1);
    expect(patch).toContain("--- a/a.ts");
    expect(patch).toContain("+eleven");
    expect(patch).not.toContain("+uno");
    expect(patch?.endsWith("\n")).toBe(true);
  });

  it("is undefined for an unknown file or hunk", () => {
    expect(hunkPatch(DIFF, "a.ts", 2)).toBeUndefined();
    expect(hunkPatch(DIFF, "nope.ts", 0)).toBeUndefined();
  });
});
