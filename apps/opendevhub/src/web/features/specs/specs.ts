import type {
  RequirementChange,
  ReviewData,
  SessionSummary,
  SpecArtifact,
  SpecChange,
  SpecPhase,
  SpecView,
} from "../../../shared/types";
import type { MarkdownBlock } from "../../components/markdown-body";
import { linesLabel } from "../review/review";
import type { ReviewComment } from "../review/review";

export const PHASE_LABEL: Record<SpecPhase, string> = {
  archived: "Archived",
  implement: "Implementing",
  propose: "Proposing",
};

/** A task's spec-first variants, one per checkout. */
export const specSessions = (sessions: SessionSummary[]): SessionSummary[] => {
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (!s.task?.spec || seen.has(s.directory)) {
      return false;
    }
    seen.add(s.directory);
    return true;
  });
};

const TITLES: Record<string, string> = {
  "design.md": "Design",
  "proposal.md": "Proposal",
  "tasks.md": "Tasks",
};

/**
 * The change's documents as tabs: proposal, design and tasks, then any other markdown outside `specs/`. Once
 * archived, the main specs it updated follow, as `openspec/specs/<capability>/spec.md`.
 */
export const documentTabs = (
  change: SpecChange
): { id: string; label: string; content: string }[] => [
  ...change.documents
    .filter((d) => !d.path.startsWith("specs/"))
    .map((d) => ({
      content: d.content,
      id: d.path,
      label: TITLES[d.path] ?? d.path.replace(/\.md$/u, ""),
    })),
  ...(change.updatedSpecs ?? []).map((d) => ({
    content: d.content,
    id: `openspec/specs/${d.path}`,
    label: `${d.path.replace(/\/spec\.md$/u, "")} spec`,
  })),
];

/** An artifact's name as the chain shows it: `specs` → `Specs`. */
export const artifactLabel = (artifact: SpecArtifact): string =>
  artifact.id.charAt(0).toUpperCase() + artifact.id.slice(1);

/** Requirement changes grouped by capability, in the order they first appear. */
export const byCapability = (
  requirements: RequirementChange[]
): [string, RequirementChange[]][] => {
  const groups = new Map<string, RequirementChange[]>();
  for (const r of requirements) {
    groups.set(r.capability, [...(groups.get(r.capability) ?? []), r]);
  }
  return [...groups];
};

/** The text a requirement shows without its `### Requirement:` heading, which the row already names. */
export const requirementBody = (block: string): string =>
  block.replace(/^###\s+Requirement:.*(?:\r?\n)?/u, "").trim();

/** Spec comment drafts, per checkout and change. */
export const specDraftKey = (
  projectId: string,
  directory: string,
  change: string
): string => `opendevhub:spec-review:${projectId}:${directory}:${change}`;

export type SpecAnchor = Pick<
  ReviewComment,
  "file" | "line" | "start" | "quote"
>;

const QUOTE_LINES = 3;

/** The first few non-blank lines of what a comment points at. */
const quoteOf = (lines: string[]): string[] => {
  const text = lines.filter((l) => l.trim());
  return text.length > QUOTE_LINES
    ? [...text.slice(0, QUOTE_LINES), "…"]
    : text;
};

/** Where a comment on a block of one of the change's files points, `file` relative to the change folder. */
export const blockAnchor = (
  file: string,
  block: MarkdownBlock
): SpecAnchor => ({
  file,
  line: block.end,
  ...(block.end > block.start ? { start: block.start } : {}),
  quote: quoteOf(block.source),
});

/** Where a comment on a whole requirement points: its block in the capability's delta spec. */
export const requirementAnchor = (
  change: SpecChange,
  requirement: RequirementChange
): SpecAnchor => {
  const file = `specs/${requirement.capability}/spec.md`;
  const lines = requirement.delta.split("\n");
  const heading = quoteOf(lines).slice(0, 1);
  const content = change.documents.find((d) => d.path === file)?.content;
  const at = content?.indexOf(requirement.delta) ?? -1;
  if (content === undefined || at < 0) {
    return { file, quote: heading };
  }
  const start = content.slice(0, at).split("\n").length;
  const end = start + lines.length - 1;
  return {
    file,
    line: end,
    ...(end > start ? { start } : {}),
    quote: heading,
  };
};

/** Identifies an anchor; the quote tells apart requirements whose lines couldn't be found. */
export const anchorKey = (a: SpecAnchor): string =>
  [a.file ?? "", a.start ?? "", a.line ?? "", a.quote?.[0] ?? ""].join(":");

/** Whether a comment points at this anchor, to show it there. */
export const isAt = (comment: ReviewComment, anchor: SpecAnchor): boolean =>
  anchorKey(comment) === anchorKey(anchor);

/** `proposal.md:3-5`, or just the file for a comment without lines. */
export const whereLabel = (comment: ReviewComment): string => {
  if (!comment.file) {
    return "General";
  }
  return comment.line === undefined
    ? comment.file
    : `${comment.file}:${linesLabel(comment)}`;
};

/**
 * The feedback `/opsx-update <change>` gets: comments by file and line, then general ones, with paths from the
 * repository root so the agent finds them.
 */
export const composeSpecFeedback = (
  change: string,
  comments: ReviewComment[]
): string => {
  const withText = comments.filter((c) => c.text.trim());
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
    return [
      `${n}openspec/changes/${change}/${whereLabel(c)}`,
      ...(c.quote ?? []).map((q) => `${pad}> ${q}`),
      ...body.map((l) => pad + l),
    ].join("\n");
  });
  return `Review feedback on the proposed change. Revise its planning artifacts to address each point and keep them coherent, without touching any code, then reply with what you changed.\n\n${items.join("\n\n")}`;
};

/** Files the checkout changes outside `openspec/`: code the agent wrote before the spec was approved. */
export const codeChanges = (review: ReviewData | null | undefined): string[] =>
  (review?.files ?? [])
    .map((f) => f.file)
    .filter((f) => !f.startsWith("openspec/"));

/** Why the shown change can't be approved yet, if it can't. */
export const approveBlocker = (
  change: SpecChange,
  busy: boolean
): string | undefined => {
  if (busy) {
    return "The agent is working; approve when its turn ends.";
  }
  if (!change.planningComplete) {
    const missing = change.artifacts
      .filter((a) => a.status !== "done")
      .map(artifactLabel);
    return missing.length > 0
      ? `Waits for ${missing.join(", ")}.`
      : "The change isn't ready to implement yet.";
  }
  return undefined;
};

const MAX_LISTED_FILES = 5;

/** What approving has to confirm first: code written before approval, and a change that doesn't validate. */
export const approveWarnings = (
  change: SpecChange,
  code: string[]
): string[] => {
  const warnings: string[] = [];
  if (code.length > 0) {
    const listed = code.slice(0, MAX_LISTED_FILES).join(", ");
    const more =
      code.length > MAX_LISTED_FILES
        ? ` and ${code.length - MAX_LISTED_FILES} more`
        : "";
    warnings.push(`The agent changed code before approval: ${listed}${more}.`);
  }
  if (!change.validation.valid) {
    warnings.push(
      `openspec validate finds ${change.validation.issues.length === 1 ? "a problem" : `${change.validation.issues.length} problems`}.`
    );
  }
  return warnings;
};

/** The shown change's tasks: how many of them the agent has ticked off. */
export const taskProgress = (
  view: SpecView | null | undefined
): { completed: number; total: number } | undefined => {
  const name = view?.change?.name;
  const summary = view?.changes.find((c) => c.name === name);
  if (!summary || summary.totalTasks === 0) {
    return undefined;
  }
  return { completed: summary.completedTasks, total: summary.totalTasks };
};

/** Every one of the change's tasks is done, so it can be archived. */
export const tasksDone = (
  progress: { completed: number; total: number } | undefined
): boolean => progress !== undefined && progress.completed >= progress.total;
