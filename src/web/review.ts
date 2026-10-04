import type { ProjectView, ReviewFile, UpdateStrategy } from "../shared/types";
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
  line: number;
  side: "new" | "old";
  /** The commented line and up to 2 lines before it, with their +/-/space prefix. */
  quote: string[];
}

export interface ReviewComment {
  id: string;
  /** Missing for a general comment. */
  file?: string;
  line?: number;
  side?: "new" | "old";
  quote?: string[];
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Hunks of one file's unified diff; file headers before the first hunk are skipped. */
export function parsePatch(patch: string): Hunk[] {
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
    if (!current || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) current.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    else if (raw.startsWith("-")) current.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    else if (raw.startsWith(" ")) current.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return hunks;
}

const PREFIX: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: " " };

export function anchorFor(lines: DiffLine[], index: number): LineAnchor {
  const l = lines[index];
  const side = l.kind === "del" ? "old" : "new";
  const line = (side === "old" ? l.oldNo : l.newNo) ?? 0;
  const quote = lines.slice(Math.max(0, index - 2), index + 1).map((q) => PREFIX[q.kind] + q.text);
  return { key: `${side}:${line}`, line, side, quote };
}

/** The spec's review prompt: line comments ordered by file and line, then general comments. */
export function composeReviewPrompt(o: { branch?: string; base?: string; comments: ReviewComment[] }): string {
  const what = o.branch ? `Review feedback on ${o.branch}` : "Review feedback on the working copy";
  const vs = o.base && o.base !== o.branch ? ` (compared with ${o.base})` : "";
  const withText = o.comments.filter((c) => c.text.trim());
  const ordered = [
    ...withText.filter((c) => c.file).sort((a, b) => a.file!.localeCompare(b.file!) || (a.line ?? 0) - (b.line ?? 0)),
    ...withText.filter((c) => !c.file),
  ];
  const items = ordered.map((c, i) => {
    const n = `${i + 1}. `;
    const pad = " ".repeat(n.length);
    const body = c.text.trim().split("\n");
    if (!c.file) return `${n}General: ${body.join(`\n${pad}`)}`;
    const where = `${c.file}:${c.line}${c.side === "old" ? " (removed line)" : ""}`;
    return [`${n}${where}`, ...(c.quote ?? []).map((q) => `${pad}> ${q}`), ...body.map((l) => pad + l)].join("\n");
  });
  return `${what}${vs}. Address each point, then reply with what you changed.\n\n${items.join("\n\n")}`;
}

export function conflictPrompt(o: { branch: string; base: string; strategy: UpdateStrategy; files: string[] }): string {
  const how = o.strategy === "rebase" ? `Rebase ${o.branch} onto ${o.base}` : `Merge ${o.base} into ${o.branch}`;
  return `${how} and resolve the conflicts in ${o.files.join(", ")}. Run the tests afterwards, then reply with what you changed.`;
}

export function draftKey(projectId: string, target: string, base: string | undefined): string {
  return `opendevhub:review:${projectId}:${target || "main-checkout"}:${base ?? ""}`;
}

export function sentKey(projectId: string, target: string): string {
  return `opendevhub:review-sent:${projectId}:${target || "main-checkout"}`;
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isComment(v: unknown): v is ReviewComment {
  const c = v as ReviewComment;
  return !!c && typeof c === "object" && typeof c.id === "string" && typeof c.text === "string";
}

/** Drafts survive a reload; unavailable or corrupt storage just means no drafts. */
export function readComments(key: string, storage: Pick<Storage, "getItem"> | undefined = defaultStorage()): ReviewComment[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isComment) : [];
  } catch {
    return [];
  }
}

export function writeComments(
  key: string,
  comments: ReviewComment[],
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = defaultStorage(),
): void {
  try {
    if (comments.length === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(comments));
  } catch {
    // storage full or blocked: drafts stay in memory only
  }
}

export function isLarge(f: ReviewFile): boolean {
  return f.additions + f.deletions > 400;
}

/** The route target for a checkout: "" for the main checkout, the worktree's folder name otherwise. */
export function targetOf(view: ProjectView, directory: string): string | undefined {
  if (directory === workspaceFolderOf(view)) return "";
  const wt = view.runtime.worktrees?.find((w) => w.path === directory);
  return wt ? wt.path.split("/").filter(Boolean).at(-1) : undefined;
}

export function directoryOf(view: ProjectView, target: string): string | undefined {
  if (!target) return workspaceFolderOf(view);
  return view.runtime.worktrees?.find((w) => w.path.split("/").filter(Boolean).at(-1) === target)?.path;
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A cheap content fingerprint (FNV-1a), so a refreshed diff re-renders when its text changes. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** React key for a file's diff: changes whenever its stats or patch change. */
export function diffKey(f: ReviewFile): string {
  return `${f.file}:${f.additions}:${f.deletions}:${f.patch === undefined ? "-" : `${f.patch.length}.${fingerprint(f.patch)}`}`;
}

/** A generated commit message fills the box only if it is the latest request and the user hasn't typed one. */
export function acceptSuggestion(o: { current: string; suggestion: string; request: number; latest: number }): string {
  return o.request === o.latest && !o.current.trim() ? o.suggestion : o.current;
}
