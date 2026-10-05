import { describe, expect, it } from "vitest";
import type { RawFileDiff } from "../../src/server/opencode/client";
import { diffMode, isBinaryPatch, resolveBase, toReviewFiles } from "../../src/server/review";

const diff = (file: string, patch: string, over: Partial<RawFileDiff> = {}): RawFileDiff => ({
  file,
  patch,
  additions: 1,
  deletions: 0,
  status: "modified",
  ...over,
});

describe("resolveBase", () => {
  it("prefers the request, then the recorded base, then opencode, then the default branch", () => {
    const all = { request: "r", config: "c", opencode: "o", defaultBranch: "d" };
    expect(resolveBase(all)).toEqual({ name: "r", source: "request" });
    expect(resolveBase({ ...all, request: undefined })).toEqual({ name: "c", source: "config" });
    expect(resolveBase({ opencode: "o", defaultBranch: "d" })).toEqual({ name: "o", source: "opencode" });
    expect(resolveBase({ defaultBranch: "d" })).toEqual({ name: "d", source: "default" });
    expect(resolveBase({})).toBeUndefined();
  });

  it("skips names git could read as options or that aren't single refs", () => {
    expect(resolveBase({ config: "-x", opencode: "a b", defaultBranch: "main" })).toEqual({ name: "main", source: "default" });
    expect(resolveBase({ config: "  ", defaultBranch: "--all" })).toBeUndefined();
  });
});

describe("diffMode", () => {
  const main = { name: "main", source: "config" as const };
  it("diffs the working copy when the main checkout is on its base, else the branch", () => {
    expect(diffMode(true, "main", main)).toBe("working");
    expect(diffMode(true, "feature", main)).toBe("branch");
    expect(diffMode(true, "main", undefined)).toBe("working");
    expect(diffMode(false, "feature", main)).toBe("branch");
    expect(diffMode(false, undefined, undefined)).toBe("working");
  });
});

describe("toReviewFiles", () => {
  it("keeps patches within the budget and lists the rest with stats only", () => {
    const out = toReviewFiles([diff("a", "x".repeat(60)), diff("b", "y".repeat(60)), diff("c", "z".repeat(30))], 100);
    expect(out.truncated).toBe(true);
    expect(out.files.map((f) => [f.file, f.patch?.length])).toEqual([
      ["a", 60],
      ["b", undefined],
      ["c", 30],
    ]);
    expect(out.files[1]).toEqual({ file: "b", status: "modified", additions: 1, deletions: 0 });
  });

  it("marks binary files and leaves their patch out", () => {
    expect(isBinaryPatch("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toBe(true);
    expect(isBinaryPatch("GIT binary patch\nliteral 12\n")).toBe(true);
    expect(isBinaryPatch("@@ -1 +1 @@\n-a\n+b\n")).toBe(false);
    const out = toReviewFiles([diff("logo.png", "Binary files a/logo.png and b/logo.png differ", { status: "added" })]);
    expect(out).toEqual({ files: [{ file: "logo.png", status: "added", additions: 1, deletions: 0, binary: true }], truncated: false });
  });
});
