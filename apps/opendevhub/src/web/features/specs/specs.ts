import type {
  RequirementChange,
  SessionSummary,
  SpecArtifact,
  SpecChange,
  SpecPhase,
} from "../../../shared/types";

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

/** The change's documents as tabs: proposal, design and tasks, then any other markdown outside `specs/`. */
export const documentTabs = (
  change: SpecChange
): { id: string; label: string; content: string }[] =>
  change.documents
    .filter((d) => !d.path.startsWith("specs/"))
    .map((d) => ({
      content: d.content,
      id: d.path,
      label: TITLES[d.path] ?? d.path.replace(/\.md$/u, ""),
    }));

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
