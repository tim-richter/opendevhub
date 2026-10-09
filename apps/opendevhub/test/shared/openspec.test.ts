import { describe, expect, it } from "vitest";

import {
  parseDeltaSpec,
  requirementBlocks,
  requirementChanges,
} from "../../src/shared/openspec";

const CURRENT = `# auth Specification

## Purpose
Auth things.

## Requirements
### Requirement: Session timeout
The system SHALL expire sessions after 30 minutes.

#### Scenario: Idle
- **WHEN** idle 30 minutes
- **THEN** session expires

### Requirement: Old thing
The system SHALL do old thing.

### Requirement: Legacy name
The system SHALL keep its name.
`;

const DELTA = `## ADDED Requirements
### Requirement: Login
The system SHALL let users log in.

#### Scenario: Valid
- **WHEN** valid creds
- **THEN** logged in

## MODIFIED Requirements
### Requirement: Session timeout
The system SHALL expire sessions after 15 minutes.

\`\`\`md
### Requirement: Not a heading
\`\`\`

## REMOVED Requirements
### Requirement: Old thing
**Reason**: gone

## RENAMED Requirements
- FROM: \`### Requirement: Legacy name\`
- TO: \`### Requirement: New name\`
`;

describe(requirementBlocks, () => {
  it("splits a spec into requirement blocks, scenarios included", () => {
    const blocks = requirementBlocks(CURRENT);
    expect(blocks.map((b) => b.name)).toStrictEqual([
      "Session timeout",
      "Old thing",
      "Legacy name",
    ]);
    expect(blocks[0].text).toBe(
      "### Requirement: Session timeout\nThe system SHALL expire sessions after 30 minutes.\n\n#### Scenario: Idle\n- **WHEN** idle 30 minutes\n- **THEN** session expires"
    );
  });

  it("finds none in a spec without requirements", () => {
    expect(requirementBlocks("# Nothing\n\n## Purpose\nx")).toStrictEqual([]);
  });
});

describe(parseDeltaSpec, () => {
  it("reads each operation's requirements, ignoring headings in code", () => {
    const delta = parseDeltaSpec(DELTA);
    expect(delta.map((d) => [d.operation, d.name, d.from])).toStrictEqual([
      ["ADDED", "Login", undefined],
      ["MODIFIED", "Session timeout", undefined],
      ["REMOVED", "Old thing", undefined],
      ["RENAMED", "New name", "Legacy name"],
    ]);
    expect(delta[1].text).toContain("### Requirement: Not a heading");
    expect(delta[2].text).toBe("### Requirement: Old thing\n**Reason**: gone");
  });

  it("ignores requirements outside a delta section", () => {
    expect(parseDeltaSpec(CURRENT)).toStrictEqual([]);
  });
});

describe(requirementChanges, () => {
  it("pairs each delta with the current text by name", () => {
    const changes = requirementChanges("auth", DELTA, CURRENT);
    expect(changes.map((c) => [c.operation, c.name, !!c.before])).toStrictEqual(
      [
        ["ADDED", "Login", false],
        ["MODIFIED", "Session timeout", true],
        ["REMOVED", "Old thing", true],
        ["RENAMED", "New name", true],
      ]
    );
    expect(changes[1].before).toContain("30 minutes");
    expect(changes[1].delta).toContain("15 minutes");
    expect(changes[3]).toMatchObject({
      before: "### Requirement: Legacy name\nThe system SHALL keep its name.",
      capability: "auth",
      delta: "",
      from: "Legacy name",
    });
  });

  it("finds a renamed requirement's current text for its modification", () => {
    const delta = `## RENAMED Requirements
- FROM: \`### Requirement: Legacy name\`
- TO: \`### Requirement: New name\`

## MODIFIED Requirements
### Requirement: New name
The system SHALL keep its new name.
`;
    const [, modified] = requirementChanges("auth", delta, CURRENT);
    expect(modified.before).toContain("SHALL keep its name.");
  });

  it("has no current text for a new capability", () => {
    const changes = requirementChanges("billing", DELTA, undefined);
    expect(changes.every((c) => c.before === undefined)).toBe(true);
  });
});
