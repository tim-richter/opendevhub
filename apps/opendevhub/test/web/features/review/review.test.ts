import { describe, expect, it } from "vitest";

import type { ProjectView } from "../../../../src/shared/types";
import {
  aheadHint,
  acceptSuggestion,
  anchorFor,
  anchorFromRange,
  annotationsFor,
  commonDirectory,
  ensurePatchHeader,
  fileVersions,
  publishBlocker,
  selectionFor,
  statsDecoration,
  treeGitStatus,
  composeReviewPrompt,
  conflictPrompt,
  diffKey,
  directoryOf,
  draftKey,
  parsePatch,
  readComments,
  readDiffView,
  readReviewMode,
  targetOf,
  writeComments,
  writeDiffView,
  writeReviewMode,
} from "../../../../src/web/features/review/review";

const patch = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -40,4 +40,4 @@ export function auth() {",
  " function check(req) {",
  "   const token = read(req);",
  "-  if (!token) return deny();",
  "+  if (token == null) return next();",
  "   return verify(token);",
  "",
].join("\n");

describe(parsePatch, () => {
  it("numbers old and new lines from the hunk header and skips file headers", () => {
    const [hunk] = parsePatch(patch);
    expect(hunk.header).toBe("@@ -40,4 +40,4 @@ export function auth() {");
    expect(hunk.lines).toStrictEqual([
      { kind: "ctx", text: "function check(req) {", oldNo: 40, newNo: 40 },
      { kind: "ctx", text: "  const token = read(req);", oldNo: 41, newNo: 41 },
      { kind: "del", text: "  if (!token) return deny();", oldNo: 42 },
      { kind: "add", text: "  if (token == null) return next();", newNo: 42 },
      { kind: "ctx", text: "  return verify(token);", oldNo: 43, newNo: 43 },
    ]);
  });

  it("handles count-less hunk headers, '--' content lines and missing final newlines", () => {
    const hunks = parsePatch(
      [
        "@@ -1 +1,2 @@",
        "--- old dashes",
        "\\ No newline at end of file",
        "+++ new pluses",
        "+second",
        "@@ -9 +10 @@",
        " x",
      ].join("\n")
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines).toStrictEqual([
      { kind: "del", text: "-- old dashes", oldNo: 1 },
      { kind: "add", text: "++ new pluses", newNo: 1 },
      { kind: "add", text: "second", newNo: 2 },
    ]);
    expect(hunks[1].lines).toStrictEqual([
      { kind: "ctx", text: "x", oldNo: 9, newNo: 10 },
    ]);
  });
});

describe(anchorFor, () => {
  const { lines } = parsePatch(patch)[0];

  it("anchors added and context lines to the new side, deleted lines to the old side, quoting 2 lines before", () => {
    expect(anchorFor(lines, 3)).toStrictEqual({
      key: "new:42",
      line: 42,
      side: "new",
      quote: [
        "   const token = read(req);",
        "-  if (!token) return deny();",
        "+  if (token == null) return next();",
      ],
    });
    expect(anchorFor(lines, 2)).toMatchObject({
      key: "old:42",
      side: "old",
      line: 42,
    });
    expect(anchorFor(lines, 0).quote).toStrictEqual([" function check(req) {"]);
  });
});

describe(composeReviewPrompt, () => {
  it("matches the spec's format: line comments by file and line, general comments last", () => {
    const text = composeReviewPrompt({
      branch: "feature/login",
      base: "main",
      comments: [
        { id: "g", text: "please add a test for the redirect." },
        {
          id: "l",
          file: "src/auth.ts",
          line: 42,
          side: "new",
          quote: ["+  if (token == null) return next();"],
          text: "This skips auth for missing tokens; it should 401.",
        },
      ],
    });
    expect(text).toBe(
      [
        "Review feedback on feature/login (compared with main). Address each point, then reply with what you changed.",
        "",
        "1. src/auth.ts:42",
        "   > +  if (token == null) return next();",
        "   This skips auth for missing tokens; it should 401.",
        "",
        "2. General: please add a test for the redirect.",
      ].join("\n")
    );
  });

  it("names the uncommitted changes and leaves out the base when reviewing them", () => {
    const text = composeReviewPrompt({
      branch: "feature/login",
      base: "main",
      uncommitted: true,
      comments: [{ id: "g", text: "ok" }],
    });
    expect(text.split("\n")[0]).toBe(
      "Review feedback on the uncommitted changes on feature/login. Address each point, then reply with what you changed."
    );
  });

  it("names the turn the comments are on and leaves out the base", () => {
    const first = (turn: { latest: boolean; prompt?: string }) =>
      composeReviewPrompt({
        branch: "feature/login",
        base: "main",
        turn,
        comments: [{ id: "g", text: "ok" }],
      }).split("\n")[0];
    expect(first({ latest: true, prompt: "Fix it" })).toBe(
      "Review feedback on the changes from your last turn. Address each point, then reply with what you changed."
    );
    expect(first({ latest: false, prompt: "Fix it" })).toBe(
      'Review feedback on the changes from your turn "Fix it". Address each point, then reply with what you changed.'
    );
  });

  it("marks removed lines, indents multi-line comments and skips empty ones", () => {
    const text = composeReviewPrompt({
      comments: [
        {
          id: "a",
          file: "b.ts",
          line: 3,
          side: "old",
          quote: ["-x"],
          text: "why remove?\nit was used",
        },
        { id: "b", file: "a.ts", line: 9, side: "new", text: "  " },
      ],
    });
    expect(text).toBe(
      [
        "Review feedback on the working copy. Address each point, then reply with what you changed.",
        "",
        "1. b.ts:3 (removed line)",
        "   > -x",
        "   why remove?",
        "   it was used",
      ].join("\n")
    );
  });

  it("names the lines a range comment covers", () => {
    const text = composeReviewPrompt({
      comments: [
        {
          id: "a",
          file: "a.ts",
          line: 43,
          side: "new",
          start: 40,
          startSide: "new",
          quote: [" x", "+y"],
          text: "split this",
        },
        {
          id: "b",
          file: "b.ts",
          line: 5,
          side: "old",
          start: 3,
          startSide: "old",
          text: "keep these",
        },
        {
          id: "c",
          file: "c.ts",
          line: 42,
          side: "new",
          start: 42,
          startSide: "old",
          text: "why?",
        },
      ],
    });
    expect(text.split("\n\n").slice(1)).toStrictEqual([
      ["1. a.ts:40-43", "   >  x", "   > +y", "   split this"].join("\n"),
      ["2. b.ts:3-5 (removed lines)", "   keep these"].join("\n"),
      ["3. c.ts:42 (removed) to 42", "   why?"].join("\n"),
    ]);
  });

  it("asks the agent to resolve conflicts", () => {
    expect(
      conflictPrompt({
        branch: "x",
        base: "main",
        strategy: "rebase",
        files: ["a.ts", "b.ts"],
      })
    ).toBe(
      "Rebase x onto main and resolve the conflicts in a.ts, b.ts. Run the tests afterwards, then reply with what you changed."
    );
    expect(
      conflictPrompt({
        branch: "x",
        base: "main",
        strategy: "merge",
        files: ["a.ts"],
      })
    ).toMatch(/^Merge main into x and resolve/u);
  });
});

describe("draft storage", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      m,
    };
  };

  it("round-trips comments per project, target and diff, and clears empty lists", () => {
    const s = memory();
    const key = draftKey("p", "", "branch", "main");
    expect(key).toBe("opendevhub:review:p:main-checkout:main");
    expect(draftKey("p", "wt", "working", "main")).toBe(
      "opendevhub:review:p:wt:"
    );
    expect(
      draftKey("p", "wt", "turn", "main", { sessionId: "ses_1", from: "msg_2" })
    ).toBe("opendevhub:review:p:wt:turn:ses_1:msg_2");
    writeComments(key, [{ id: "1", text: "hi" }], s);
    expect(readComments(key, s)).toStrictEqual([{ id: "1", text: "hi" }]);
    writeComments(key, [], s);
    expect(s.m.has(key)).toBeFalsy();
  });

  it("survives broken JSON, wrong shapes and storage that throws", () => {
    const s = memory();
    s.setItem("k", "{nope");
    expect(readComments("k", s)).toStrictEqual([]);
    s.setItem("k", JSON.stringify([{ id: 1 }, { id: "ok", text: "fine" }]));
    expect(readComments("k", s)).toStrictEqual([{ id: "ok", text: "fine" }]);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(readComments("k", throwing)).toStrictEqual([]);
    expect(() =>
      writeComments("k", [{ id: "1", text: "x" }], throwing)
    ).not.toThrow();
    expect(readComments("k")).toStrictEqual([]);
  });
});

describe("targets", () => {
  const view = {
    project: {
      id: "p",
      name: "demo",
      path: "/src/demo",
      devcontainerPath: "/x",
    },
    runtime: {
      projectId: "p",
      containerState: "running",
      opencode: "healthy",
      workspaceFolder: "/workspaces/demo",
      worktrees: [
        { path: "/workspaces/demo.worktrees/feature-x", branch: "feature/x" },
      ],
    },
    sessions: [],
    openUrl: "",
    environments: [],
  } as ProjectView;

  it("maps checkouts to route targets and back", () => {
    expect(targetOf(view, "/workspaces/demo")).toBe("");
    expect(targetOf(view, "/workspaces/demo.worktrees/feature-x")).toBe(
      "feature-x"
    );
    expect(targetOf(view, "/tmp/elsewhere")).toBeUndefined();
    expect(directoryOf(view, "")).toBe("/workspaces/demo");
    expect(directoryOf(view, "feature-x")).toBe(
      "/workspaces/demo.worktrees/feature-x"
    );
    expect(directoryOf(view, "nope")).toBeUndefined();
  });

  it("keys a file's diff by its content, so a refresh with new content re-renders it", () => {
    const f = {
      file: "a.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    };
    expect(diffKey(f)).toBe(diffKey({ ...f }));
    expect(diffKey(f)).not.toBe(
      diffKey({ ...f, patch: "@@ -1 +1 @@\n-a\n+c\n" })
    );
    expect(diffKey(f)).not.toBe(diffKey({ ...f, additions: 2 }));
    expect(diffKey({ ...f, patch: undefined })).not.toBe(diffKey(f));
  });

  it("only fills in a suggested commit message the user hasn't overtaken", () => {
    expect(
      acceptSuggestion({
        current: "",
        suggestion: "feat: x",
        request: 2,
        latest: 2,
      })
    ).toBe("feat: x");
    expect(
      acceptSuggestion({
        current: "my own",
        suggestion: "feat: x",
        request: 2,
        latest: 2,
      })
    ).toBe("my own");
    expect(
      acceptSuggestion({
        current: "",
        suggestion: "feat: old",
        request: 1,
        latest: 2,
      })
    ).toBe("");
  });
});

describe("@pierre/diffs adapters", () => {
  it("turns a gutter selection into a comment anchor with its quote", () => {
    expect(
      anchorFromRange(patch, { start: 42, end: 42, side: "additions" })
    ).toStrictEqual({
      key: "new:42",
      line: 42,
      side: "new",
      quote: [
        "   const token = read(req);",
        "-  if (!token) return deny();",
        "+  if (token == null) return next();",
      ],
    });
    expect(
      anchorFromRange(patch, { start: 42, end: 42, side: "deletions" })
    ).toMatchObject({ key: "old:42", side: "old" });
    expect(
      anchorFromRange(patch, { start: 99, end: 99, side: "additions" })
    ).toStrictEqual({ key: "new:99", line: 99, side: "new", quote: [] });
  });

  it("turns a drag into a comment on the whole range, anchored where it ends and quoting every selected line", () => {
    const range = {
      key: "new:43",
      line: 43,
      side: "new",
      start: 40,
      startSide: "new",
      quote: [
        " function check(req) {",
        "   const token = read(req);",
        "-  if (!token) return deny();",
        "+  if (token == null) return next();",
        "   return verify(token);",
      ],
    };
    expect(
      anchorFromRange(patch, {
        start: 40,
        end: 43,
        side: "additions",
        endSide: "additions",
      })
    ).toStrictEqual(range);
    // Dragging upwards selects the same range.
    expect(
      anchorFromRange(patch, {
        start: 43,
        end: 40,
        side: "additions",
        endSide: "additions",
      })
    ).toStrictEqual(range);
    // A range can start on a removed line and end on an added one.
    expect(
      anchorFromRange(patch, {
        start: 42,
        end: 42,
        side: "deletions",
        endSide: "additions",
      })
    ).toStrictEqual({
      key: "new:42",
      line: 42,
      side: "new",
      start: 42,
      startSide: "old",
      quote: [
        "-  if (!token) return deny();",
        "+  if (token == null) return next();",
      ],
    });
    // A start outside the patch falls back to a comment on the end line.
    expect(
      anchorFromRange(patch, {
        start: 99,
        end: 43,
        side: "additions",
        endSide: "additions",
      })
    ).not.toHaveProperty("start");
  });

  it("places a file's comments and the open comment box as diff annotations", () => {
    const comments = [
      {
        id: "1",
        file: "src/auth.ts",
        line: 42,
        side: "new" as const,
        text: "a",
      },
      {
        id: "2",
        file: "src/auth.ts",
        line: 42,
        side: "old" as const,
        text: "b",
      },
      { id: "3", file: "other.ts", line: 1, side: "new" as const, text: "c" },
      { id: "4", text: "general" },
    ];
    expect(
      annotationsFor(comments, "src/auth.ts", {
        key: "new:7",
        line: 7,
        side: "new",
        quote: [],
      })
    ).toStrictEqual([
      {
        side: "additions",
        lineNumber: 42,
        metadata: { kind: "comment", comment: comments[0] },
      },
      {
        side: "deletions",
        lineNumber: 42,
        metadata: { kind: "comment", comment: comments[1] },
      },
      {
        side: "additions",
        lineNumber: 7,
        metadata: {
          kind: "draft",
          anchor: { key: "new:7", line: 7, side: "new", quote: [] },
        },
      },
    ]);
    expect(annotationsFor(comments, "none.ts", undefined)).toStrictEqual([]);
  });

  it("gives a bare hunk the file headers the patch parser needs", () => {
    expect(ensurePatchHeader("@@ -1 +1 @@\n-a\n+b\n", "src/x.ts")).toBe(
      "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n"
    );
    expect(ensurePatchHeader(patch, "ignored")).toBe(patch);
  });
});

describe("review mode", () => {
  it("defaults to uncommitted changes and remembers a comparison per checkout", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    expect(readReviewMode("p", "wt", storage)).toBe("working");
    writeReviewMode("p", "wt", "branch", storage);
    expect(readReviewMode("p", "wt", storage)).toBe("branch");
    expect(readReviewMode("p", "", storage)).toBe("working");
    // Turns are reviewed on the session page now.
    writeReviewMode("p", "wt", "turn", storage);
    expect(readReviewMode("p", "wt", storage)).toBe("working");
    writeReviewMode("p", "wt", "working", storage);
    expect(store.size).toBe(0);
    expect(
      readReviewMode("p", "wt", {
        getItem: () => {
          throw new Error("blocked");
        },
      })
    ).toBe("working");
  });
});

describe(aheadHint, () => {
  const data = {
    directory: "/w",
    branch: "feature/x",
    base: { name: "main", source: "config" as const },
    mode: "working" as const,
    ahead: 3,
    behind: 0,
    dirty: false,
    pushed: false,
    workspace: { clean: true },
    files: [],
  };

  it("points at the commits when nothing is uncommitted", () => {
    expect(aheadHint(data)).toBe("feature/x is 3 commits ahead of main.");
    expect(aheadHint({ ...data, ahead: 1 })).toBe(
      "feature/x is 1 commit ahead of main."
    );
    expect(aheadHint({ ...data, ahead: 0 })).toBeUndefined();
    expect(aheadHint({ ...data, mode: "branch" })).toBeUndefined();
    expect(
      aheadHint({
        ...data,
        files: [{ file: "a", status: "modified", additions: 1, deletions: 0 }],
      })
    ).toBeUndefined();
    expect(aheadHint({ ...data, branch: "main" })).toBeUndefined();
  });
});

describe("diff view", () => {
  it("defaults to unified, changes only, and remembers a choice", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readDiffView(storage)).toStrictEqual({
      split: false,
      fullFile: false,
      hideFiles: false,
    });
    writeDiffView({ split: true, fullFile: true, hideFiles: true }, storage);
    expect(readDiffView(storage)).toStrictEqual({
      split: true,
      fullFile: true,
      hideFiles: true,
    });
  });

  it("falls back to the defaults on corrupt storage", () => {
    expect(readDiffView({ getItem: () => "{nope" })).toStrictEqual({
      split: false,
      fullFile: false,
      hideFiles: false,
    });
  });
});

describe(fileVersions, () => {
  it("rebuilds both sides of a whole-file patch", () => {
    const whole = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n");
    expect(fileVersions(whole)).toStrictEqual({
      old: "one\ntwo\nthree\n",
      new: "one\nTWO\nthree\n",
    });
  });

  it("keeps a missing final newline on the side that lacks it", () => {
    const whole = [
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "\\ No newline at end of file",
      "+two",
      "",
    ].join("\n");
    expect(fileVersions(whole)).toStrictEqual({
      old: "one\ntwo",
      new: "one\ntwo\n",
    });
  });

  it("gives nothing for a patch that doesn't hold the whole file", () => {
    expect(fileVersions(patch)).toBeUndefined();
    const twoHunks = [
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -9,1 +9,1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    expect(fileVersions(twoHunks)).toBeUndefined();
  });

  it("gives nothing for an added or deleted file, which has no unchanged lines to hide", () => {
    expect(
      fileVersions(["@@ -0,0 +1,2 @@", "+a", "+b", ""].join("\n"))
    ).toBeUndefined();
    expect(
      fileVersions(["@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n"))
    ).toBeUndefined();
  });
});

describe(commonDirectory, () => {
  it("is the folder every path shares, ending in a slash", () => {
    expect(
      commonDirectory([
        "packages/ui/src/a.ts",
        "packages/ui/src/deep/b.ts",
        "packages/ui/test/c.ts",
      ])
    ).toBe("packages/ui/");
  });

  it("never swallows a file name", () => {
    expect(commonDirectory(["packages/ui/src/a.ts"])).toBe("packages/ui/src/");
    expect(commonDirectory(["src/ab.ts", "src/a.ts"])).toBe("src/");
  });

  it("is empty when the paths share no folder", () => {
    expect(commonDirectory(["src/a.ts", "README.md"])).toBe("");
    expect(commonDirectory([])).toBe("");
  });
});

describe("@pierre/trees adapters", () => {
  const files = [
    {
      file: "src/a.ts",
      status: "modified" as const,
      additions: 3,
      deletions: 1,
    },
    {
      file: "src/new.ts",
      status: "added" as const,
      additions: 4,
      deletions: 0,
    },
    { file: "old.txt", status: "deleted" as const, additions: 0, deletions: 2 },
    {
      file: "logo.png",
      status: "added" as const,
      additions: 0,
      deletions: 0,
      binary: true,
    },
  ];

  it("gives every changed file its git status", () => {
    expect(treeGitStatus(files)).toStrictEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/new.ts", status: "added" },
      { path: "old.txt", status: "deleted" },
      { path: "logo.png", status: "added" },
    ]);
  });

  it("gives git status relative to the tree's root folder", () => {
    expect(treeGitStatus(files.slice(0, 2), "src/")).toStrictEqual([
      { path: "a.ts", status: "modified" },
      { path: "new.ts", status: "added" },
    ]);
  });

  it("decorates file rows with their line counts", () => {
    expect(statsDecoration(files[0])).toStrictEqual({
      text: "+3 −1",
      title: "3 lines added, 1 removed",
      parts: [
        { text: "+3", color: "var(--ok)" },
        { text: " " },
        { text: "−1", color: "var(--destructive)" },
      ],
    });
    expect(statsDecoration(files[3])).toStrictEqual({
      text: "binary",
      title: "binary file",
    });
  });
});

describe("diff selection", () => {
  it("selects the line whose comment box is open, and nothing once it closes", () => {
    expect(
      selectionFor({ key: "new:7", line: 7, side: "new", quote: [] })
    ).toStrictEqual({
      start: 7,
      end: 7,
      side: "additions",
      endSide: "additions",
    });
    expect(
      selectionFor({ key: "old:3", line: 3, side: "old", quote: [] })
    ).toStrictEqual({
      start: 3,
      end: 3,
      side: "deletions",
      endSide: "deletions",
    });
    expect(
      selectionFor({
        key: "new:43",
        line: 43,
        side: "new",
        start: 42,
        startSide: "old",
        quote: [],
      })
    ).toStrictEqual({
      start: 42,
      end: 43,
      side: "deletions",
      endSide: "additions",
    });
    expect(selectionFor(undefined)).toBeNull();
  });
});

describe(publishBlocker, () => {
  const data = {
    directory: "/w",
    branch: "feature/x",
    base: { name: "main", source: "config" as const },
    mode: "branch" as const,
    ahead: 1,
    behind: 0,
    dirty: false,
    pushed: false,
    workspace: { clean: true },
    files: [],
  };

  it("allows publishing a clean branch that is ahead of its base", () => {
    expect(publishBlocker(data)).toBeUndefined();
    expect(publishBlocker({ ...data, ahead: 0 })).toBe("Nothing to publish");
    expect(publishBlocker({ ...data, dirty: true })).toBe(
      "Commit the changes first"
    );
    expect(publishBlocker({ ...data, branch: undefined })).toBe(
      "Not on a branch"
    );
    expect(publishBlocker({ ...data, branch: "main" })).toBe(
      "This is the base branch"
    );
  });
});
