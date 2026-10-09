import { describe, expect, it } from "vitest";

import {
  diffMode,
  isBinaryPatch,
  isRepoPath,
  isMessageId,
  NO_LIMITS,
  resolveBase,
  toReviewFiles,
  toTurnPrompts,
} from "../../../src/server/git/review";
import type { RawFileDiff } from "../../../src/server/opencode/client";

const diff = (
  file: string,
  patch: string,
  over: Partial<RawFileDiff> = {}
): RawFileDiff => ({
  file,
  patch,
  additions: 1,
  deletions: 0,
  status: "modified",
  ...over,
});

describe(resolveBase, () => {
  it("prefers the request, then the recorded base, then opencode, then the default branch", () => {
    const all = {
      request: "r",
      config: "c",
      opencode: "o",
      defaultBranch: "d",
    };
    expect(resolveBase(all)).toStrictEqual({ name: "r", source: "request" });
    expect(resolveBase({ ...all, request: undefined })).toStrictEqual({
      name: "c",
      source: "config",
    });
    expect(resolveBase({ opencode: "o", defaultBranch: "d" })).toStrictEqual({
      name: "o",
      source: "opencode",
    });
    expect(resolveBase({ defaultBranch: "d" })).toStrictEqual({
      name: "d",
      source: "default",
    });
    expect(resolveBase({})).toBeUndefined();
  });

  it("skips names git could read as options or that aren't single refs", () => {
    expect(
      resolveBase({ config: "-x", opencode: "a b", defaultBranch: "main" })
    ).toStrictEqual({ name: "main", source: "default" });
    expect(
      resolveBase({ config: "  ", defaultBranch: "--all" })
    ).toBeUndefined();
  });
});

describe(diffMode, () => {
  const main = { name: "main", source: "config" as const };

  it("shows uncommitted changes unless a comparison with a known base is asked for", () => {
    expect(diffMode(undefined, main)).toBe("working");
    expect(diffMode("working", main)).toBe("working");
    expect(diffMode("branch", main)).toBe("branch");
    expect(diffMode("branch", undefined)).toBe("working");
  });

  it("shows a turn only when there is a session to take it from", () => {
    expect(diffMode("turn", main, true)).toBe("turn");
    expect(diffMode("turn", main)).toBe("working");
    expect(diffMode("branch", main, true)).toBe("branch");
  });
});

describe(toTurnPrompts, () => {
  it("keeps each prompt's first non-empty line, cut short", () => {
    const prompts = toTurnPrompts([
      {
        id: "msg_2",
        text: "\n  Fix the login\nand more",
        time: { created: 2 },
      },
      { id: "msg_1", text: "x".repeat(200), time: { created: 1 } },
    ]);
    expect(prompts[0]).toStrictEqual({
      created: 2,
      id: "msg_2",
      text: "Fix the login",
    });
    expect(prompts[1].text).toHaveLength(120);
    expect(prompts[1].text.endsWith("…")).toBeTruthy();
  });
});

describe(isMessageId, () => {
  it("accepts opencode message ids only", () => {
    expect(isMessageId("msg_01ABCdef")).toBeTruthy();
    expect(isMessageId("ses_1")).toBeFalsy();
    expect(isMessageId("msg_1&to=x")).toBeFalsy();
  });
});

describe(toReviewFiles, () => {
  it("keeps patches within the budget and lists the rest with stats only", () => {
    const out = toReviewFiles(
      [
        diff("a", "x".repeat(60)),
        diff("b", "y".repeat(60)),
        diff("c", "z".repeat(30)),
      ],
      { budget: 100 }
    );
    expect(out.truncated).toBeTruthy();
    expect(out.files.map((f) => [f.file, f.patch?.length])).toStrictEqual([
      ["a", 60],
      ["b", undefined],
      ["c", 30],
    ]);
    expect(out.files[1]).toStrictEqual({
      file: "b",
      status: "modified",
      additions: 1,
      deletions: 0,
    });
  });

  it("accepts only relative paths inside the checkout", () => {
    expect(isRepoPath("img/logo.png")).toBeTruthy();
    expect(isRepoPath("a b/ü.png")).toBeTruthy();
    for (const bad of [
      "../x.png",
      "img/../../x.png",
      "/etc/x.png",
      "-x.png",
      "./x.png",
      "img//x.png",
      "x\n.png",
      "",
    ]) {
      expect(isRepoPath(bad)).toBeFalsy();
    }
  });

  it("marks binary files and leaves their patch out", () => {
    expect(
      isBinaryPatch("diff --git a/x b/x\nBinary files a/x and b/x differ\n")
    ).toBeTruthy();
    expect(isBinaryPatch("GIT binary patch\nliteral 12\n")).toBeTruthy();
    expect(isBinaryPatch("@@ -1 +1 @@\n-a\n+b\n")).toBeFalsy();
    const out = toReviewFiles([
      diff("logo.png", "Binary files a/logo.png and b/logo.png differ", {
        status: "added",
      }),
    ]);
    expect(out).toStrictEqual({
      files: [
        {
          file: "logo.png",
          status: "added",
          additions: 1,
          deletions: 0,
          binary: true,
        },
      ],
      truncated: false,
    });
  });

  it.each(["+", "-", " "])(
    "keeps text patches containing a %j line mentioning the binary marker",
    (prefix) => {
      const patch = `@@ -1 +1 @@\n${prefix}GIT binary patch\n`;
      expect(isBinaryPatch(patch)).toBeFalsy();
      expect(toReviewFiles([diff("notes.txt", patch)])).toStrictEqual({
        files: [diff("notes.txt", patch)],
        truncated: false,
      });
    }
  );

  it("leaves out the patch of a large diff, by changed lines or by size, without spending budget on it", () => {
    const out = toReviewFiles(
      [
        diff("lines", "x", { additions: 300, deletions: 101 }),
        diff("bytes", "y".repeat(50)),
        diff("small", "z".repeat(40), { additions: 300, deletions: 100 }),
      ],
      { budget: 100, fileBytes: 49 }
    );
    expect(out.truncated).toBeFalsy();
    expect(out.files).toStrictEqual([
      {
        file: "lines",
        status: "modified",
        additions: 300,
        deletions: 101,
        large: true,
      },
      {
        file: "bytes",
        status: "modified",
        additions: 1,
        deletions: 0,
        large: true,
      },
      {
        file: "small",
        status: "modified",
        additions: 300,
        deletions: 100,
        patch: "z".repeat(40),
      },
    ]);
  });

  it("keeps any patch when there are no limits, as for a single file asked for by name", () => {
    const out = toReviewFiles(
      [diff("lock", "y".repeat(500), { additions: 900 })],
      NO_LIMITS
    );
    expect(out.files[0].patch).toHaveLength(500);
  });
});
