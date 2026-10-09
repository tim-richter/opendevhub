import type { RequirementChange, RequirementOperation } from "./types";

const SECTION =
  /^##\s+(?<op>ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/iu;
const HEADING2 = /^##\s/u;
const REQUIREMENT = /^###\s+Requirement:\s*(?<name>.+?)\s*$/u;
const HEADING3 = /^###\s/u;
const FENCE = /^\s*(?:```|~~~)/u;
const RENAME =
  /^\s*-\s*(?<side>FROM|TO):\s*`?\s*###\s+Requirement:\s*(?<name>.+?)\s*`?\s*$/iu;

/** One `### Requirement:` block of a spec: its name and its text, heading included. */
export interface RequirementBlock {
  name: string;
  text: string;
}

export interface DeltaRequirement extends RequirementBlock {
  operation: RequirementOperation;
  /** RENAMED: the old name; `name` is the new one. */
  from?: string;
}

interface Line {
  text: string;
  /** Inside a fenced code block, where headings are text. */
  code: boolean;
}

const linesOf = (markdown: string): Line[] => {
  let code = false;
  return markdown.split(/\r?\n/u).map((text) => {
    const fence = FENCE.test(text);
    const line = { code: code || fence, text };
    if (fence) {
      code = !code;
    }
    return line;
  });
};

const blockText = (lines: Line[]): string =>
  lines
    .map((l) => l.text)
    .join("\n")
    .trim();

/** Splits lines into requirement blocks; a block ends at the next requirement or `##`/`###` heading. */
const blocksIn = (lines: Line[]): RequirementBlock[] => {
  const blocks: RequirementBlock[] = [];
  let current: { name: string; lines: Line[] } | undefined;
  const close = () => {
    if (current) {
      blocks.push({ name: current.name, text: blockText(current.lines) });
      current = undefined;
    }
  };
  for (const line of lines) {
    const name = line.code
      ? undefined
      : REQUIREMENT.exec(line.text)?.groups?.name;
    if (name !== undefined) {
      close();
      current = { lines: [line], name };
    } else if (
      !line.code &&
      (HEADING2.test(line.text) || HEADING3.test(line.text))
    ) {
      close();
    } else {
      current?.lines.push(line);
    }
  }
  close();
  return blocks;
};

/** The requirement blocks of a capability's current spec, under whatever `##` section they sit. */
export const requirementBlocks = (specMarkdown: string): RequirementBlock[] =>
  blocksIn(linesOf(specMarkdown));

/** A delta spec's requirements: the blocks under `## ADDED|MODIFIED|REMOVED Requirements`, and RENAMED's FROM/TO pairs. */
export const parseDeltaSpec = (markdown: string): DeltaRequirement[] => {
  const sections: { op: RequirementOperation; lines: Line[] }[] = [];
  let section: { op: RequirementOperation; lines: Line[] } | undefined;
  for (const line of linesOf(markdown)) {
    const op = line.code ? undefined : SECTION.exec(line.text)?.groups?.op;
    if (op) {
      section = { lines: [], op: op.toUpperCase() as RequirementOperation };
      sections.push(section);
    } else if (!line.code && HEADING2.test(line.text)) {
      section = undefined;
    } else {
      section?.lines.push(line);
    }
  }
  const out: DeltaRequirement[] = [];
  for (const { op, lines } of sections) {
    if (op !== "RENAMED") {
      out.push(...blocksIn(lines).map((b) => ({ ...b, operation: op })));
      continue;
    }
    let from: string | undefined;
    for (const { text, code } of lines) {
      const m = code ? undefined : RENAME.exec(text)?.groups;
      if (m?.side.toUpperCase() === "FROM") {
        from = m.name;
      } else if (m && from !== undefined) {
        out.push({ from, name: m.name, operation: op, text: "" });
        from = undefined;
      }
    }
  }
  return out;
};

const key = (name: string): string =>
  name.trim().replaceAll(/\s+/gu, " ").toLowerCase();

/**
 * What a capability's delta changes, matched by requirement name against its current spec. A MODIFIED
 * requirement that the same delta renames is found under its old name.
 */
export const requirementChanges = (
  capability: string,
  deltaMarkdown: string,
  currentSpec: string | undefined
): RequirementChange[] => {
  const current = new Map(
    requirementBlocks(currentSpec ?? "").map((b) => [key(b.name), b.text])
  );
  const delta = parseDeltaSpec(deltaMarkdown);
  const renamedFrom = new Map(
    delta.flatMap((d) => (d.from === undefined ? [] : [[key(d.name), d.from]]))
  );
  return delta.map((d) => {
    const old =
      d.from ??
      (d.operation === "ADDED"
        ? undefined
        : (renamedFrom.get(key(d.name)) ?? d.name));
    const before = old === undefined ? undefined : current.get(key(old));
    return {
      capability,
      delta: d.text,
      name: d.name,
      operation: d.operation,
      ...(d.from === undefined ? {} : { from: d.from }),
      ...(before === undefined ? {} : { before }),
    };
  });
};
