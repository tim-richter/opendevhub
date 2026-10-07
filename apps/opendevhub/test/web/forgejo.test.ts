import { describe, expect, it, vi, afterEach } from "vitest";

import type { ForgejoPullDetails } from "../../src/shared/forgejo";
import type { PublishInfo } from "../../src/shared/types";
import {
  forgejoAgentPrompt,
  forgejoFilePatches,
  matchesForgejoCheckout,
  matchesForgejoPull,
  readForgejoPreference,
  saveForgejoPreference,
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
