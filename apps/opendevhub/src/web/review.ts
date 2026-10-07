import type {
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs/react";
import type { FileTreeRowDecoration, GitStatusEntry } from "@pierre/trees";

import type {
  ProjectView,
  ReviewData,
  ReviewFile,
  ReviewMode,
  UpdateStrategy,
} from "../shared/types";
import { workspaceFolderOf } from "./derive";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

/** Where a comment points: the new-side line, or the old-side line of a deleted line. */
export interface LineAnchor {
  key: string;
  /** The last commented line; the comment shows below it. */
  line: number;
  side: "new" | "old";
  /** The first line of a range comment; missing for a single line. */
  start?: number;
  startSide?: "new" | "old";
  /** The commented range, or the commented line and up to 2 lines before it, with their +/-/space prefix. */
  quote: string[];
}

export interface ReviewComment {
  id: string;
  /** Missing for a general comment. */
  file?: string;
  line?: number;
  side?: "new" | "old";
  start?: number;
  startSide?: "new" | "old";
  quote?: string[];
  text: string;
}

const HUNK = /^@@ -(?<g1>\d+)(?:,\d+)? \+(?<g2>\d+)(?:,\d+)? @@/u;

/** Hunks of one file's unified diff; file headers before the first hunk are skipped. */
export const parsePatch = (patch: string): Hunk[] => {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const m = raw.match(HUNK);
    if (m) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (!current || raw.startsWith("\\")) {
      continue;
    }
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", oldNo: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      current.lines.push({
        kind: "ctx",
        newNo: newNo++,
        oldNo: oldNo++,
        text: raw.slice(1),
      });
    }
  }
  return hunks;
};

const PREFIX: Record<DiffLine["kind"], string> = {
  add: "+",
  ctx: " ",
  del: "-",
};

const sideOf = (l: DiffLine) => (l.kind === "del" ? "old" : "new");
const numberOf = (l: DiffLine) => (l.kind === "del" ? l.oldNo : l.newNo) ?? 0;
const quoteOf = (lines: DiffLine[]) =>
  lines.map((q) => PREFIX[q.kind] + q.text);

export const anchorFor = (lines: DiffLine[], index: number): LineAnchor => {
  const l = lines[index];
  const side = sideOf(l);
  const line = numberOf(l);
  return {
    key: `${side}:${line}`,
    line,
    quote: quoteOf(lines.slice(Math.max(0, index - 2), index + 1)),
    side,
  };
};

/** A comment on `lines[from..to]`, quoting all of them. */
const rangeAnchor = (
  lines: DiffLine[],
  from: number,
  to: number
): LineAnchor => {
  if (from === to) {
    return anchorFor(lines, to);
  }
  const first = lines[from];
  return {
    ...anchorFor(lines, to),
    quote: quoteOf(lines.slice(from, to + 1)),
    start: numberOf(first),
    startSide: sideOf(first),
  };
};

/** "40-43", "3 (removed line)", "42 (removed) to 42": the lines a comment covers. */
export const linesLabel = (
  c: Pick<ReviewComment, "line" | "side" | "start" | "startSide">
): string => {
  const removed = c.side === "old";
  if (c.start === undefined) {
    return `${c.line}${removed ? " (removed line)" : ""}`;
  }
  if ((c.startSide ?? "new") === (c.side ?? "new")) {
    return `${c.start}-${c.line}${removed ? " (removed lines)" : ""}`;
  }
  const label = (n: number | undefined, side: "new" | "old" | undefined) =>
    `${n}${side === "old" ? " (removed)" : ""}`;
  return `${label(c.start, c.startSide)} to ${label(c.line, c.side)}`;
};

/** The spec's review prompt: line comments ordered by file and line, then general comments. */
export const composeReviewPrompt = (o: {
  branch?: string;
  base?: string;
  uncommitted?: boolean;
  comments: ReviewComment[];
}): string => {
  let what;
  if (o.branch) {
    if (o.uncommitted) {
      what = `Review feedback on the uncommitted changes on ${o.branch}`;
    } else {
      what = `Review feedback on ${o.branch}`;
    }
  } else {
    what = "Review feedback on the working copy";
  }
  const vs =
    !o.uncommitted && o.base && o.base !== o.branch
      ? ` (compared with ${o.base})`
      : "";
  const withText = o.comments.filter((c) => c.text.trim());
  const ordered = [
    ...withText
      .filter((c) => c.file)
      .toSorted(
        (a, b) =>
          (a.file ?? "").localeCompare(b.file ?? "") ||
          (a.line ?? 0) - (b.line ?? 0)
      ),
    ...withText.filter((c) => !c.file),
  ];
  const items = ordered.map((c, i) => {
    const n = `${i + 1}. `;
    const pad = " ".repeat(n.length);
    const body = c.text.trim().split("\n");
    if (!c.file) {
      return `${n}General: ${body.join(`\n${pad}`)}`;
    }
    const where = `${c.file}:${linesLabel(c)}`;
    return [
      `${n}${where}`,
      ...(c.quote ?? []).map((q) => `${pad}> ${q}`),
      ...body.map((l) => pad + l),
    ].join("\n");
  });
  return `${what}${vs}. Address each point, then reply with what you changed.\n\n${items.join("\n\n")}`;
};

export const conflictPrompt = (o: {
  branch: string;
  base: string;
  strategy: UpdateStrategy;
  files: string[];
}): string => {
  const how =
    o.strategy === "rebase"
      ? `Rebase ${o.branch} onto ${o.base}`
      : `Merge ${o.base} into ${o.branch}`;
  return `${how} and resolve the conflicts in ${o.files.join(", ")}. Run the tests afterwards, then reply with what you changed.`;
};

/** Drafts per diff: ends in the base when comparing with it, empty for uncommitted changes. */
export const draftKey = (
  projectId: string,
  target: string,
  mode: ReviewMode,
  base: string | undefined
): string =>
  `opendevhub:review:${projectId}:${target || "main-checkout"}:${mode === "branch" ? (base ?? "") : ""}`;

const modeKey = (projectId: string, target: string): string =>
  `opendevhub:review-mode:${projectId}:${target || "main-checkout"}`;

/** The diff a checkout's review shows; uncommitted changes unless comparing with the base was chosen there. */
export const readReviewMode = (
  projectId: string,
  target: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage()
): ReviewMode => {
  try {
    return storage?.getItem(modeKey(projectId, target)) === "branch"
      ? "branch"
      : "working";
  } catch {
    return "working";
  }
};

export const writeReviewMode = (
  projectId: string,
  target: string,
  mode: ReviewMode,
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = defaultStorage()
): void => {
  try {
    if (mode === "working") {
      storage?.removeItem(modeKey(projectId, target));
    } else {
      storage?.setItem(modeKey(projectId, target), mode);
    }
  } catch {
    // storage blocked: the choice lasts until reload
  }
};

/** The hint when there is nothing uncommitted but the branch has commits its base doesn't. */
export const aheadHint = (data: ReviewData): string | undefined => {
  if (
    data.mode !== "working" ||
    data.files.length > 0 ||
    !data.base ||
    !data.branch ||
    data.ahead === 0
  ) {
    return undefined;
  }
  if (data.branch === data.base.name) {
    return undefined;
  }
  return `${data.branch} is ${data.ahead} commit${data.ahead === 1 ? "" : "s"} ahead of ${data.base.name}.`;
};

export const sentKey = (projectId: string, target: string): string =>
  `opendevhub:review-sent:${projectId}:${target || "main-checkout"}`;

const defaultStorage = (): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

const isComment = (v: unknown): v is ReviewComment => {
  const c = v as ReviewComment;
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.id === "string" &&
    typeof c.text === "string"
  );
};

/** How the review shows diffs; remembered across reviews and reloads. */
export interface DiffView {
  split: boolean;
  fullFile: boolean;
  /** The changed-files tree beside the diffs is hidden. */
  hideFiles: boolean;
}

const DIFF_VIEW_KEY = "opendevhub:review-view";

export const readDiffView = (
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage()
): DiffView => {
  try {
    const v = JSON.parse(
      storage?.getItem(DIFF_VIEW_KEY) ?? "{}"
    ) as Partial<DiffView>;
    return {
      fullFile: v.fullFile === true,
      hideFiles: v.hideFiles === true,
      split: v.split === true,
    };
  } catch {
    return { fullFile: false, hideFiles: false, split: false };
  }
};

export const writeDiffView = (
  view: DiffView,
  storage: Pick<Storage, "setItem"> | undefined = defaultStorage()
): void => {
  try {
    storage?.setItem(DIFF_VIEW_KEY, JSON.stringify(view));
  } catch {
    // storage blocked: the choice lasts until reload
  }
};

/** Drafts survive a reload; unavailable or corrupt storage just means no drafts. */
export const readComments = (
  key: string,
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage()
): ReviewComment[] => {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isComment) : [];
  } catch {
    return [];
  }
};

export const writeComments = (
  key: string,
  comments: ReviewComment[],
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = defaultStorage()
): void => {
  try {
    if (comments.length === 0) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, JSON.stringify(comments));
    }
  } catch {
    // storage full or blocked: drafts stay in memory only
  }
};

/** The route target for a checkout: "" for the main checkout, the worktree's folder name otherwise. */
export const targetOf = (
  view: ProjectView,
  directory: string
): string | undefined => {
  if (directory === workspaceFolderOf(view)) {
    return "";
  }
  const wt = view.runtime.worktrees?.find((w) => w.path === directory);
  return wt ? wt.path.split("/").findLast(Boolean) : undefined;
};

export const directoryOf = (
  view: ProjectView,
  target: string
): string | undefined => {
  if (!target) {
    return workspaceFolderOf(view);
  }
  return view.runtime.worktrees?.find(
    (w) => w.path.split("/").findLast(Boolean) === target
  )?.path;
};

export const newId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A cheap content fingerprint (FNV-1a), so a refreshed diff re-renders when its text changes. */
const fingerprint = (text: string): string => {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01_00_01_93);
  }
  return (h >>> 0).toString(36);
};

/** React key for a file's diff: changes whenever its stats or patch change. */
export const diffKey = (f: ReviewFile): string =>
  `${f.file}:${f.additions}:${f.deletions}:${f.patch === undefined ? "-" : `${f.patch.length}.${fingerprint(f.patch)}`}`;

/** A generated commit message fills the box only if it is the latest request and the user hasn't typed one. */
export const acceptSuggestion = (o: {
  current: string;
  suggestion: string;
  request: number;
  latest: number;
}): string =>
  o.request === o.latest && !o.current.trim() ? o.suggestion : o.current;

/** What a review annotation in the diff shows: a saved comment, or the box for writing one. */
export type ReviewAnnotation =
  | { kind: "comment"; comment: ReviewComment }
  | { kind: "draft"; anchor: LineAnchor };

const toSide = (side: "new" | "old") =>
  side === "old" ? "deletions" : "additions";

/**
 * The comment anchor for a gutter click or drag in the diff (deleted lines anchor to the old side). A click
 * quotes its line with up to 2 lines before it; a drag within one hunk covers and quotes every line it selected,
 * whichever way it went. A drag across hunks only comments on the line where it ended.
 */
export const anchorFromRange = (
  patch: string,
  range: SelectedLineRange
): LineAnchor => {
  const endSide = (range.endSide ?? range.side) === "deletions" ? "old" : "new";
  const startSide =
    (range.side ?? range.endSide) === "deletions" ? "old" : "new";
  const find = (lines: DiffLine[], side: "new" | "old", line: number) =>
    lines.findIndex((l) => sideOf(l) === side && numberOf(l) === line);
  for (const hunk of parsePatch(patch)) {
    const end = find(hunk.lines, endSide, range.end);
    if (end < 0) {
      continue;
    }
    const start = find(hunk.lines, startSide, range.start);
    if (start < 0) {
      return anchorFor(hunk.lines, end);
    }
    return rangeAnchor(hunk.lines, Math.min(start, end), Math.max(start, end));
  }
  return {
    key: `${endSide}:${range.end}`,
    line: range.end,
    quote: [],
    side: endSide,
  };
};

/** One file's comments, plus the open comment box, as annotations for `@pierre/diffs`. */
export const annotationsFor = (
  comments: ReviewComment[],
  file: string,
  open: LineAnchor | undefined
): DiffLineAnnotation<ReviewAnnotation>[] => {
  const annotations: DiffLineAnnotation<ReviewAnnotation>[] = comments.flatMap(
    (comment) =>
      comment.file === file && comment.line !== undefined
        ? [
            {
              lineNumber: comment.line,
              metadata: { comment, kind: "comment" as const },
              side: toSide(comment.side ?? "new"),
            },
          ]
        : []
  );
  if (open) {
    annotations.push({
      lineNumber: open.line,
      metadata: { anchor: open, kind: "draft" },
      side: toSide(open.side),
    });
  }
  return annotations;
};

/** `@pierre/diffs` parses file patches; a bare hunk (as in some permission requests) gets `---`/`+++` headers. */
export const ensurePatchHeader = (patch: string, name: string): string => {
  const firstHunk = patch.search(/^@@ /mu);
  const head = firstHunk < 0 ? patch : patch.slice(0, firstHunk);
  return /^--- /mu.test(head)
    ? patch
    : `--- a/${name}\n+++ b/${name}\n${patch}`;
};

/**
 * Both versions of a file whose patch holds all of it: opencode diffs with the whole file as context, so a changed
 * file is one hunk from line 1. `@pierre/diffs` can then hide the unchanged lines and expand them on demand.
 * Missing for any other patch, and for added or deleted files, which have no unchanged lines.
 */
export const fileVersions = (
  patch: string
): { old: string; new: string } | undefined => {
  const hunks = [
    ...patch.matchAll(/^@@ -(?<g1>\d+)(?:,\d+)? \+(?<g2>\d+)(?:,\d+)? @@/gmu),
  ];
  if (hunks.length !== 1 || hunks[0][1] !== "1" || hunks[0][2] !== "1") {
    return undefined;
  }
  const old: string[] = [];
  const next: string[] = [];
  let oldEnd = true;
  let newEnd = true;
  let last = "";
  for (const raw of patch.slice(hunks[0].index).split("\n").slice(1)) {
    const [kind] = raw;
    if (kind === "\\") {
      if (last !== "+") {
        oldEnd = false;
      }
      if (last !== "-") {
        newEnd = false;
      }
      continue;
    }
    if (kind === " " || kind === "-") {
      old.push(raw.slice(1));
    }
    if (kind === " " || kind === "+") {
      next.push(raw.slice(1));
    }
    if (kind === " " || kind === "-" || kind === "+") {
      last = kind;
    }
  }
  const text = (lines: string[], end: boolean) =>
    lines.join("\n") + (end ? "\n" : "");
  return { new: text(next, newEnd), old: text(old, oldEnd) };
};

/** The folder all `paths` share, as "a/b/" (or "" when none); the review's file tree shows it once, above the tree. */
export const commonDirectory = (paths: string[]): string => {
  if (paths.length === 0) {
    return "";
  }
  let shared = paths[0].split("/").slice(0, -1);
  for (const path of paths.slice(1)) {
    const dirs = path.split("/").slice(0, -1);
    let i = 0;
    while (i < shared.length && i < dirs.length && shared[i] === dirs[i]) {
      i += 1;
    }
    shared = shared.slice(0, i);
  }
  return shared.length ? `${shared.join("/")}/` : "";
};

/** The changed files' status, for the file tree's built-in git markers; paths are relative to the tree's `root`. */
export const treeGitStatus = (
  files: ReviewFile[],
  root = ""
): GitStatusEntry[] =>
  files.map((f) => ({
    path: f.file.slice(root.length),
    status: f.status,
  }));

/** "+3 −1" next to a file in the tree. */
export const statsDecoration = (f: ReviewFile): FileTreeRowDecoration => {
  if (f.binary) {
    return { text: "binary", title: "binary file" };
  }
  const added = `+${f.additions}`;
  const removed = `−${f.deletions}`;
  return {
    parts: [
      { color: "var(--ok)", text: added },
      { text: " " },
      { color: "var(--destructive)", text: removed },
    ],
    text: `${added} ${removed}`,
    title: `${f.additions} line${f.additions === 1 ? "" : "s"} added, ${f.deletions} removed`,
  };
};

/**
 * The diff's line selection: the lines whose comment box is open, else none. A gutter "+" click selects its line
 * inside @pierre/diffs, and the "+" stays pinned to that selection, so it must be cleared once the box closes.
 */
export const selectionFor = (
  open: LineAnchor | undefined
): SelectedLineRange | null => {
  if (!open) {
    return null;
  }
  const endSide = toSide(open.side);
  if (open.start === undefined) {
    return { end: open.line, endSide, side: endSide, start: open.line };
  }
  return {
    end: open.line,
    endSide,
    side: toSide(open.startSide ?? open.side),
    start: open.start,
  };
};

/** Why the branch can't be published yet, or undefined when it can. */
export const publishBlocker = (data: ReviewData): string | undefined => {
  if (!data.branch) {
    return "Not on a branch";
  }
  if (data.branch === data.base?.name) {
    return "This is the base branch";
  }
  if (data.dirty) {
    return "Commit the changes first";
  }
  if (data.ahead === 0) {
    return "Nothing to publish";
  }
  return undefined;
};
