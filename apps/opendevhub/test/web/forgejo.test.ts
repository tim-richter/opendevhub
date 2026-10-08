import { describe, expect, it, vi, afterEach } from "vitest";

import type { ForgejoPullDetails } from "../../src/shared/forgejo";
import type { PublishInfo } from "../../src/shared/types";
import {
  defaultPullMode,
  forgejoAgentPrompt,
  forgejoRoute,
  forgejoCommentNote,
  placeAiFindings,
  suggestionComment,
  forgejoFilePatches,
  forgejoReviewComments,
  forgejoReviewFiles,
  forgejoReviewers,
  forgejoStackGraph,
  matchesForgejoCheckout,
  matchesForgejoPull,
  readForgejoPreference,
  saveForgejoPreference,
  stackForgejoPulls,
} from "../../src/web/forgejo";

const details: ForgejoPullDetails = {
  pull: {
    owner: "team",
    repo: "app",
    number: 7,
    title: "Fix",
    state: "open",
    updatedAt: "now",
    url: "https://forge.example/team/app/pulls/7",
  },
  body: "Reason",
  author: "alice",
  base: "main",
  head: "feature",
  headSha: "a".repeat(40),
  draft: false,
  labels: [],
  reviewers: [],
};
const info = (over: Partial<PublishInfo> = {}): PublishInfo => ({
  remotes: ["origin"],
  forge: { kind: "forgejo", webBase: "https://forge.example/team/app" },
  strategies: ["agit"],
  strategy: "agit",
  pushFrom: "host",
  branch: "feature",
  ...over,
});
afterEach(() => vi.unstubAllGlobals());
describe("Forgejo handoff and navigation", () => {
  it("matches full repository URLs and recorded PR URLs, including AGit refs", () => {
    expect(matchesForgejoPull(details, info())).toBeTruthy();
    expect(
      matchesForgejoPull(
        details,
        info({
          forge: { kind: "forgejo", webBase: "https://other.example/team/app" },
        })
      )
    ).toBeFalsy();
    expect(matchesForgejoCheckout(details, info())).toBeTruthy();
    expect(
      matchesForgejoPull(
        { ...details, headRepository: "alice/fork" },
        info({
          forge: {
            kind: "forgejo",
            webBase: "https://forge.example/alice/fork",
          },
        })
      )
    ).toBeTruthy();
    const agit = { ...details, head: "refs/pull/7/head" };
    expect(matchesForgejoCheckout(agit, info())).toBeFalsy();
    expect(matchesForgejoCheckout(agit, info(), details.headSha)).toBeTruthy();
    expect(
      matchesForgejoCheckout(
        agit,
        info({ branch: "topic", pr: details.pull.url })
      )
    ).toBeTruthy();
  });

  it("includes selected feedback, failing check context and an explicit commit check", () => {
    const prompt = forgejoAgentPrompt(details, {
      comments: [
        {
          id: 1,
          author: "bob",
          body: "Handle null",
          path: "a.ts",
          line: 9,
          updatedAt: "now",
          diffHunk: "+x",
        },
      ],
      checks: [
        {
          id: 2,
          name: "tests",
          status: "failure",
          description: "Null case failed",
          url: "https://ci.example/job",
        },
      ],
    });
    for (const value of [
      details.pull.url,
      details.headSha,
      "Base: main",
      "a.ts:9",
      "Handle null",
      "Null case failed",
      "verify this checkout",
      "external context",
    ]) {
      expect(prompt).toContain(value);
    }
    expect(
      forgejoAgentPrompt({ ...details, body: "x".repeat(100_000) }, {}).length
    ).toBeLessThan(100_000);
  });

  it("splits multi-file diffs while preserving renames, deletions and binary changes", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\ndiff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    const files = forgejoFilePatches(patch);
    expect(files.map((f) => f.name)).toStrictEqual([
      "a.ts",
      "new name",
      "gone",
      "img.png",
    ]);
    expect(files.map((f) => [f.additions, f.deletions])).toStrictEqual([
      [1, 1],
      [0, 0],
      [0, 1],
      [0, 0],
    ]);
    expect(files.map((f) => f.patch).join("")).toBe(patch);
  });

  it("turns a patch into review files with git status and binary markers", () => {
    const files = forgejoReviewFiles(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+hi\ndiff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n"
    );
    expect(
      files.map(({ file, status, binary }) => ({ binary, file, status }))
    ).toStrictEqual([
      { binary: false, file: "a.ts", status: "modified" },
      { binary: false, file: "n.ts", status: "added" },
      { binary: false, file: "gone", status: "deleted" },
      { binary: true, file: "img.png", status: "modified" },
    ]);
    expect(files[1]).toMatchObject({ additions: 1, deletions: 0 });
  });

  it("anchors range comments to their last line and names the range", () => {
    expect(
      forgejoReviewComments([
        { file: "a.ts", id: "1", line: 4, side: "new", start: 2, text: "x" },
        { file: "a.ts", id: "2", line: 3, side: "old", text: "y" },
        { id: "3", text: "general" },
      ])
    ).toStrictEqual([
      { body: "Lines 2-4:\nx", new_position: 4, old_position: 0, path: "a.ts" },
      { body: "y", new_position: 0, old_position: 3, path: "a.ts" },
    ]);
  });

  it("counts changed lines beginning with diff-header-like text", () => {
    const files = forgejoFilePatches(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n---old\n+++new\n"
    );
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("continues to work when browser preference storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error();
      },
      setItem: () => {
        throw new Error();
      },
    });
    expect(readForgejoPreference("inbox")).toBe("");
    expect(() => saveForgejoPreference("layout", "split")).not.toThrow();
  });
});

describe("stacked pull requests", () => {
  const pull = (number: number, parent?: number, repo = "app") => ({
    ...details.pull,
    number,
    repo,
    title: `PR ${number}`,
    ...(parent
      ? {
          stack: {
            base: `feat/${parent}`,
            parent: { number: parent, title: `PR ${parent}` },
          },
        }
      : {}),
  });

  it("puts stacked pull requests under their listed parent", () => {
    const ordered = stackForgejoPulls([
      pull(3, 2),
      pull(9),
      pull(2, 1),
      pull(1),
      // Not listed, or in another repository: shown at the top level.
      pull(5, 4),
      pull(6, 1, "other"),
    ]);
    expect(ordered.map((p) => [p.pull.number, p.depth])).toEqual([
      [9, 0],
      [1, 0],
      [2, 1],
      [3, 2],
      [5, 0],
      [6, 0],
    ]);
  });

  it("keeps branches that target each other in a loop", () => {
    const ordered = stackForgejoPulls([pull(1, 2), pull(2, 1)]);
    expect(ordered.map((p) => [p.pull.number, p.depth])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });
});

describe("a pull request's stack", () => {
  const entry = (number: number) => ({
    number,
    title: `PR ${number}`,
    base: "b",
    head: "h",
  });

  it("draws what builds on it above, itself, then what it builds on", () => {
    expect(forgejoStackGraph(details).rows).toEqual([]);
    const { rows, lanes } = forgejoStackGraph({
      ...details,
      stack: {
        ancestors: [entry(1), entry(2)],
        descendants: [
          { ...entry(8), children: [{ ...entry(9), children: [] }] },
          { ...entry(10), children: [] },
        ],
      },
    });
    expect(lanes).toBe(2);
    expect(
      rows.map((r) => [
        r.number,
        r.lane,
        r.current,
        r.continues,
        r.merges,
        r.through,
      ])
    ).toEqual([
      [10, 1, false, false, [], []],
      [9, 0, false, false, [], [1]],
      [8, 0, false, true, [], [1]],
      [7, 0, true, true, [1], []],
      [2, 0, false, true, [], []],
      [1, 0, false, true, [], []],
    ]);
  });

  it("keeps a linear stack in one column", () => {
    const { rows, lanes } = forgejoStackGraph({
      ...details,
      stack: {
        ancestors: [entry(1)],
        descendants: [{ ...entry(8), children: [] }],
      },
    });
    expect(lanes).toBe(1);
    expect(rows.map((r) => r.number)).toEqual([8, 7, 1]);
  });
});

describe("forgejoReviewers", () => {
  const review = (
    author: string,
    state: string,
    submittedAt: string,
    dismissed = false
  ) => ({
    author,
    body: "",
    commentsCount: 0,
    commit: "c",
    dismissed,
    id: submittedAt.length + author.length,
    stale: false,
    state,
    submittedAt,
  });

  it("keeps each reviewer's latest review, replaced by an open review request", () => {
    expect(
      forgejoReviewers(
        [
          review("bob", "APPROVED", "2026-01-03"),
          review("alice", "REQUEST_CHANGES", "2026-01-01"),
          review("alice", "APPROVED", "2026-01-02"),
          review("dan", "APPROVED", "2026-01-04", true),
          review("erin", "PENDING", "2026-01-05"),
        ],
        ["bob", "carol"]
      )
    ).toEqual([
      { name: "alice", state: "APPROVED" },
      { name: "bob", state: "REQUEST_REVIEW" },
      { name: "carol", state: "REQUEST_REVIEW" },
    ]);
  });
});

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,5 @@",
  " ten",
  "-eleven",
  "+eleven!",
  "+eleven and a half",
  " twelve",
  " thirteen",
].join("\n");
const files = forgejoReviewFiles(PATCH);

describe("placeAiFindings", () => {
  it("keeps findings on shown lines, snaps near ones and makes the rest general", () => {
    const { inline, general } = placeAiFindings(
      [
        { file: "src/a.ts", line: 11, severity: "major", body: "on" },
        { file: "src/a.ts", line: 16, severity: "minor", body: "near" },
        { file: "src/a.ts", line: 40, severity: "minor", body: "far" },
        {
          file: "src/a.ts",
          line: 11,
          side: "old",
          severity: "nit",
          body: "old",
        },
        {
          file: "src/a.ts",
          line: 12,
          start: 10,
          severity: "minor",
          body: "range",
        },
        { file: "other.ts", line: 1, severity: "minor", body: "elsewhere" },
        { severity: "blocker", body: "overall" },
      ],
      files,
      "r"
    );
    expect(inline).toEqual([
      {
        id: "r-0",
        file: "src/a.ts",
        line: 11,
        side: "new",
        severity: "major",
        body: "on",
      },
      {
        id: "r-1",
        file: "src/a.ts",
        line: 14,
        side: "new",
        severity: "minor",
        body: "near",
      },
      {
        id: "r-3",
        file: "src/a.ts",
        line: 11,
        side: "old",
        severity: "nit",
        body: "old",
      },
      {
        id: "r-4",
        file: "src/a.ts",
        line: 12,
        start: 10,
        side: "new",
        severity: "minor",
        body: "range",
      },
    ]);
    expect(general.map((g) => g.id)).toEqual(["r-2", "r-5", "r-6"]);
    expect(suggestionComment(inline[3], "edited")).toEqual({
      id: "r-4",
      file: "src/a.ts",
      line: 12,
      side: "new",
      start: 10,
      startSide: "new",
      text: "edited",
    });
  });
});

describe("forgejoCommentNote", () => {
  const comment = { id: 5, author: "bob", body: "x", updatedAt: "now" };
  it("places inline comments on lines still in the diff", () => {
    expect(
      forgejoCommentNote({ ...comment, path: "src/a.ts", line: 12 }, files)
    ).toEqual({ id: "comments-5", file: "src/a.ts", line: 12, side: "new" });
    expect(
      forgejoCommentNote({ ...comment, path: "src/a.ts", oldLine: 11 }, files)
    ).toEqual({ id: "comments-5", file: "src/a.ts", line: 11, side: "old" });
    expect(
      forgejoCommentNote({ ...comment, path: "src/a.ts", line: 99 }, files)
    ).toBeUndefined();
    expect(forgejoCommentNote(comment, files)).toBeUndefined();
  });
});

describe("defaultPullMode", () => {
  it("opens review inboxes in review mode", () => {
    expect(defaultPullMode("review-requested")).toBe("review");
    expect(defaultPullMode("review")).toBe("review");
    expect(defaultPullMode("authored")).toBe("address");
    expect(defaultPullMode(null)).toBe("address");
  });
});

describe("forgejoAgentPrompt with AI findings", () => {
  it("lists picked AI findings with their place", () => {
    const prompt = forgejoAgentPrompt(details, {
      ai: [
        {
          file: "a.ts",
          line: 9,
          start: 7,
          side: "new",
          severity: "major",
          body: "Null",
        },
        { severity: "minor", body: "Docs" },
      ],
    });
    expect(prompt).toContain("AI review finding (major) on a.ts:7-9:\nNull");
    expect(prompt).toContain("AI review finding (minor):\nDocs");
  });
});

describe("forgejoRoute", () => {
  it("maps a pull request on the configured instance to its dashboard page", () => {
    expect(
      forgejoRoute(
        "https://git.acme.dev/acme/web/pulls/42",
        "https://git.acme.dev/"
      )
    ).toBe("/forgejo/acme/web/42");
    expect(
      forgejoRoute(
        "https://acme.dev/forgejo/acme/web/pulls/7",
        "https://acme.dev/forgejo"
      )
    ).toBe("/forgejo/acme/web/7");
  });

  it("leaves other hosts and non-PR URLs alone", () => {
    expect(
      forgejoRoute(
        "https://github.com/acme/web/pull/42",
        "https://git.acme.dev"
      )
    ).toBeUndefined();
    expect(
      forgejoRoute(
        "https://git.acme.dev/acme/web/compare/main...x",
        "https://git.acme.dev"
      )
    ).toBeUndefined();
    expect(
      forgejoRoute("https://git.acme.dev/a/b/pulls/1", undefined)
    ).toBeUndefined();
  });
});
