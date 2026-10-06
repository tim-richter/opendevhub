import { describe, expect, it } from "vitest";
import type { RawFileDiff } from "../../src/server/opencode/client";
import { diffMode, isBinaryPatch, NO_LIMITS, resolveBase, toReviewFiles } from "../../src/server/review";

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
  it("shows uncommitted changes unless a comparison with a known base is asked for", () => {
    expect(diffMode(undefined, main)).toBe("working");
    expect(diffMode("working", main)).toBe("working");
    expect(diffMode("branch", main)).toBe("branch");
    expect(diffMode("branch", undefined)).toBe("working");
  });
});

describe("toReviewFiles", () => {
  it("keeps patches within the budget and lists the rest with stats only", () => {
    const out = toReviewFiles([diff("a", "x".repeat(60)), diff("b", "y".repeat(60)), diff("c", "z".repeat(30))], { budget: 100 });
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

  it("leaves out the patch of a large diff, by changed lines or by size, without spending budget on it", () => {
    const out = toReviewFiles(
      [
        diff("lines", "x", { additions: 300, deletions: 101 }),
        diff("bytes", "y".repeat(50)),
        diff("small", "z".repeat(40), { additions: 300, deletions: 100 }),
      ],
      { budget: 100, fileBytes: 49 },
    );
    expect(out.truncated).toBe(false);
    expect(out.files).toEqual([
      { file: "lines", status: "modified", additions: 300, deletions: 101, large: true },
      { file: "bytes", status: "modified", additions: 1, deletions: 0, large: true },
      { file: "small", status: "modified", additions: 300, deletions: 100, patch: "z".repeat(40) },
    ]);
  });

  it("keeps any patch when there are no limits, as for a single file asked for by name", () => {
    const out = toReviewFiles([diff("lock", "y".repeat(500), { additions: 900 })], NO_LIMITS);
    expect(out.files[0].patch).toHaveLength(500);
  });
});
