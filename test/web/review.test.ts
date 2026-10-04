import { describe, expect, it } from "vitest";
import type { ProjectView } from "../../src/shared/types";
import {
  acceptSuggestion,
  anchorFor,
  anchorFromRange,
  annotationsFor,
  ensurePatchHeader,
  selectionFor,
  statsDecoration,
  treeGitStatus,
  composeReviewPrompt,
  conflictPrompt,
  diffKey,
  directoryOf,
  draftKey,
  isLarge,
  parsePatch,
  readComments,
  targetOf,
  writeComments,
} from "../../src/web/review";

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

describe("parsePatch", () => {
  it("numbers old and new lines from the hunk header and skips file headers", () => {
    const [hunk] = parsePatch(patch);
    expect(hunk.header).toBe("@@ -40,4 +40,4 @@ export function auth() {");
    expect(hunk.lines).toEqual([
      { kind: "ctx", text: "function check(req) {", oldNo: 40, newNo: 40 },
      { kind: "ctx", text: "  const token = read(req);", oldNo: 41, newNo: 41 },
      { kind: "del", text: "  if (!token) return deny();", oldNo: 42 },
      { kind: "add", text: "  if (token == null) return next();", newNo: 42 },
      { kind: "ctx", text: "  return verify(token);", oldNo: 43, newNo: 43 },
    ]);
  });

  it("handles count-less hunk headers, '--' content lines and missing final newlines", () => {
    const hunks = parsePatch(["@@ -1 +1,2 @@", "--- old dashes", "\\ No newline at end of file", "+++ new pluses", "+second", "@@ -9 +10 @@", " x"].join("\n"));
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines).toEqual([
      { kind: "del", text: "-- old dashes", oldNo: 1 },
      { kind: "add", text: "++ new pluses", newNo: 1 },
      { kind: "add", text: "second", newNo: 2 },
    ]);
    expect(hunks[1].lines).toEqual([{ kind: "ctx", text: "x", oldNo: 9, newNo: 10 }]);
  });
});

describe("anchorFor", () => {
  const lines = parsePatch(patch)[0].lines;
  it("anchors added and context lines to the new side, deleted lines to the old side, quoting 2 lines before", () => {
    expect(anchorFor(lines, 3)).toEqual({
      key: "new:42",
      line: 42,
      side: "new",
      quote: ["   const token = read(req);", "-  if (!token) return deny();", "+  if (token == null) return next();"],
    });
    expect(anchorFor(lines, 2)).toMatchObject({ key: "old:42", side: "old", line: 42 });
    expect(anchorFor(lines, 0).quote).toEqual([" function check(req) {"]);
  });
});

describe("composeReviewPrompt", () => {
  it("matches the spec's format: line comments by file and line, general comments last", () => {
    const text = composeReviewPrompt({
      branch: "feature/login",
      base: "main",
      comments: [
        { id: "g", text: "please add a test for the redirect." },
        { id: "l", file: "src/auth.ts", line: 42, side: "new", quote: ["+  if (token == null) return next();"], text: "This skips auth for missing tokens; it should 401." },
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
      ].join("\n"),
    );
  });

  it("marks removed lines, indents multi-line comments and skips empty ones", () => {
    const text = composeReviewPrompt({
      comments: [
        { id: "a", file: "b.ts", line: 3, side: "old", quote: ["-x"], text: "why remove?\nit was used" },
        { id: "b", file: "a.ts", line: 9, side: "new", text: "  " },
      ],
    });
    expect(text).toBe(
      ["Review feedback on the working copy. Address each point, then reply with what you changed.", "", "1. b.ts:3 (removed line)", "   > -x", "   why remove?", "   it was used"].join("\n"),
    );
  });

  it("asks the agent to resolve conflicts", () => {
    expect(conflictPrompt({ branch: "x", base: "main", strategy: "rebase", files: ["a.ts", "b.ts"] })).toBe(
      "Rebase x onto main and resolve the conflicts in a.ts, b.ts. Run the tests afterwards, then reply with what you changed.",
    );
    expect(conflictPrompt({ branch: "x", base: "main", strategy: "merge", files: ["a.ts"] })).toMatch(/^Merge main into x and resolve/);
  });
});

describe("draft storage", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it("round-trips comments per project, target and base, and clears empty lists", () => {
    const s = memory();
    const key = draftKey("p", "", "main");
    expect(key).toBe("opendevhub:review:p:main-checkout:main");
    writeComments(key, [{ id: "1", text: "hi" }], s);
    expect(readComments(key, s)).toEqual([{ id: "1", text: "hi" }]);
    writeComments(key, [], s);
    expect(s.m.has(key)).toBe(false);
  });

  it("survives broken JSON, wrong shapes and storage that throws", () => {
    const s = memory();
    s.setItem("k", "{nope");
    expect(readComments("k", s)).toEqual([]);
    s.setItem("k", JSON.stringify([{ id: 1 }, { id: "ok", text: "fine" }]));
    expect(readComments("k", s)).toEqual([{ id: "ok", text: "fine" }]);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(readComments("k", throwing)).toEqual([]);
    expect(() => writeComments("k", [{ id: "1", text: "x" }], throwing)).not.toThrow();
    expect(readComments("k", undefined)).toEqual([]);
  });
});

describe("targets", () => {
  const view = {
    project: { id: "p", name: "demo", path: "/src/demo", devcontainerPath: "/x" },
    runtime: {
      projectId: "p",
      containerState: "running",
      opencode: "healthy",
      workspaceFolder: "/workspaces/demo",
      worktrees: [{ path: "/workspaces/demo.worktrees/feature-x", branch: "feature/x" }],
    },
    sessions: [],
    openUrl: "",
  } as ProjectView;

  it("maps checkouts to route targets and back", () => {
    expect(targetOf(view, "/workspaces/demo")).toBe("");
    expect(targetOf(view, "/workspaces/demo.worktrees/feature-x")).toBe("feature-x");
    expect(targetOf(view, "/tmp/elsewhere")).toBeUndefined();
    expect(directoryOf(view, "")).toBe("/workspaces/demo");
    expect(directoryOf(view, "feature-x")).toBe("/workspaces/demo.worktrees/feature-x");
    expect(directoryOf(view, "nope")).toBeUndefined();
  });

  it("collapses files over 400 changed lines", () => {
    expect(isLarge({ file: "a", status: "modified", additions: 300, deletions: 101 })).toBe(true);
    expect(isLarge({ file: "a", status: "modified", additions: 300, deletions: 100 })).toBe(false);
  });

  it("keys a file's diff by its content, so a refresh with new content re-renders it", () => {
    const f = { file: "a.ts", status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" };
    expect(diffKey(f)).toBe(diffKey({ ...f }));
    expect(diffKey(f)).not.toBe(diffKey({ ...f, patch: "@@ -1 +1 @@\n-a\n+c\n" }));
    expect(diffKey(f)).not.toBe(diffKey({ ...f, additions: 2 }));
    expect(diffKey({ ...f, patch: undefined })).not.toBe(diffKey(f));
  });

  it("only fills in a suggested commit message the user hasn't overtaken", () => {
    expect(acceptSuggestion({ current: "", suggestion: "feat: x", request: 2, latest: 2 })).toBe("feat: x");
    expect(acceptSuggestion({ current: "my own", suggestion: "feat: x", request: 2, latest: 2 })).toBe("my own");
    expect(acceptSuggestion({ current: "", suggestion: "feat: old", request: 1, latest: 2 })).toBe("");
  });
});

describe("@pierre/diffs adapters", () => {
  it("turns a gutter selection into a comment anchor with its quote", () => {
    expect(anchorFromRange(patch, { start: 42, end: 42, side: "additions" })).toEqual({
      key: "new:42",
      line: 42,
      side: "new",
      quote: ["   const token = read(req);", "-  if (!token) return deny();", "+  if (token == null) return next();"],
    });
    expect(anchorFromRange(patch, { start: 42, end: 42, side: "deletions" })).toMatchObject({ key: "old:42", side: "old" });
    // A drag anchors to where it ended.
    expect(anchorFromRange(patch, { start: 40, end: 43, side: "additions", endSide: "additions" })).toMatchObject({ line: 43 });
    expect(anchorFromRange(patch, { start: 99, end: 99, side: "additions" })).toEqual({ key: "new:99", line: 99, side: "new", quote: [] });
  });

  it("places a file's comments and the open comment box as diff annotations", () => {
    const comments = [
      { id: "1", file: "src/auth.ts", line: 42, side: "new" as const, text: "a" },
      { id: "2", file: "src/auth.ts", line: 42, side: "old" as const, text: "b" },
      { id: "3", file: "other.ts", line: 1, side: "new" as const, text: "c" },
      { id: "4", text: "general" },
    ];
    expect(annotationsFor(comments, "src/auth.ts", { key: "new:7", line: 7, side: "new", quote: [] })).toEqual([
      { side: "additions", lineNumber: 42, metadata: { kind: "comment", comment: comments[0] } },
      { side: "deletions", lineNumber: 42, metadata: { kind: "comment", comment: comments[1] } },
      { side: "additions", lineNumber: 7, metadata: { kind: "draft", anchor: { key: "new:7", line: 7, side: "new", quote: [] } } },
    ]);
    expect(annotationsFor(comments, "none.ts", undefined)).toEqual([]);
  });

  it("gives a bare hunk the file headers the patch parser needs", () => {
    expect(ensurePatchHeader("@@ -1 +1 @@\n-a\n+b\n", "src/x.ts")).toBe("--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(ensurePatchHeader(patch, "ignored")).toBe(patch);
  });
});

describe("@pierre/trees adapters", () => {
  const files = [
    { file: "src/a.ts", status: "modified" as const, additions: 3, deletions: 1 },
    { file: "src/new.ts", status: "added" as const, additions: 4, deletions: 0 },
    { file: "old.txt", status: "deleted" as const, additions: 0, deletions: 2 },
    { file: "logo.png", status: "added" as const, additions: 0, deletions: 0, binary: true },
  ];

  it("gives every changed file its git status", () => {
    expect(treeGitStatus(files)).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/new.ts", status: "added" },
      { path: "old.txt", status: "deleted" },
      { path: "logo.png", status: "added" },
    ]);
  });

  it("decorates file rows with their line counts", () => {
    expect(statsDecoration(files[0])).toEqual({
      text: "+3 −1",
      title: "3 lines added, 1 removed",
      parts: [
        { text: "+3", color: "var(--ok)" },
        { text: " " },
        { text: "−1", color: "var(--danger)" },
      ],
    });
    expect(statsDecoration(files[3])).toEqual({ text: "binary", title: "binary file" });
  });
});

describe("diff selection", () => {
  it("selects the line whose comment box is open, and nothing once it closes", () => {
    expect(selectionFor({ key: "new:7", line: 7, side: "new", quote: [] })).toEqual({ start: 7, end: 7, side: "additions", endSide: "additions" });
    expect(selectionFor({ key: "old:3", line: 3, side: "old", quote: [] })).toEqual({ start: 3, end: 3, side: "deletions", endSide: "deletions" });
    expect(selectionFor(undefined)).toBeNull();
  });
});
