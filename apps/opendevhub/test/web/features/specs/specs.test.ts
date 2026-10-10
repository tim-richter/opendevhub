import { describe, expect, it } from "vitest";

import type { SessionSummary, SpecChange } from "../../../../src/shared/types";
import {
  blockAnchor,
  byCapability,
  composeSpecFeedback,
  documentTabs,
  isAt,
  requirementAnchor,
  requirementBody,
  specSessions,
} from "../../../../src/web/features/specs/specs";

const change = (paths: string[]): SpecChange => ({
  artifacts: [],
  documents: paths.map((path) => ({ content: path, path })),
  name: "c",
  planningComplete: false,
  requirements: [],
  validation: { issues: [], valid: true },
});

describe(documentTabs, () => {
  it("names the known documents and leaves delta specs to the requirements", () => {
    expect(
      documentTabs(
        change([
          "proposal.md",
          "tasks.md",
          "specs/auth/spec.md",
          "notes/extra.md",
        ])
      ).map((t) => t.label)
    ).toStrictEqual(["Proposal", "Tasks", "notes/extra"]);
  });
});

describe(specSessions, () => {
  it("keeps one spec-first session per checkout", () => {
    const s = (id: string, directory: string, spec: boolean) =>
      ({
        directory,
        id,
        task: {
          of: 1,
          task: "tsk_1",
          title: "",
          variant: 1,
          ...(spec ? { spec: { phase: "propose" } } : {}),
        },
      }) as SessionSummary;
    expect(
      specSessions([
        s("a", "/w1", true),
        s("b", "/w1", true),
        s("c", "/w2", false),
        s("d", "/w3", true),
      ]).map((x) => x.id)
    ).toStrictEqual(["a", "d"]);
  });
});

describe(byCapability, () => {
  it("groups requirement changes in order", () => {
    const r = (capability: string, name: string) => ({
      capability,
      delta: "",
      name,
      operation: "ADDED" as const,
    });
    expect(
      byCapability([r("auth", "a"), r("billing", "b"), r("auth", "c")]).map(
        ([cap, rs]) => [cap, rs.map((x) => x.name)]
      )
    ).toStrictEqual([
      ["auth", ["a", "c"]],
      ["billing", ["b"]],
    ]);
  });
});

describe(requirementBody, () => {
  it("drops the requirement heading", () => {
    expect(requirementBody("### Requirement: Login\nThe system SHALL.\n")).toBe(
      "The system SHALL."
    );
    expect(requirementBody("Plain text")).toBe("Plain text");
  });
});

describe(blockAnchor, () => {
  it("points at the block's lines and quotes its first non-blank ones", () => {
    expect(
      blockAnchor("proposal.md", {
        end: 7,
        source: ["- one", "", "  two", "  three", "  four"],
        start: 3,
      })
    ).toStrictEqual({
      file: "proposal.md",
      line: 7,
      quote: ["- one", "  two", "  three", "…"],
      start: 3,
    });
    expect(
      blockAnchor("design.md", { end: 2, source: ["## Goals"], start: 2 })
    ).toStrictEqual({ file: "design.md", line: 2, quote: ["## Goals"] });
  });
});

describe(requirementAnchor, () => {
  const delta =
    "### Requirement: Timeout\nAfter 15 minutes.\n\n#### Scenario: Idle\n- it logs out";
  const withSpec = (content: string): SpecChange => ({
    ...change([]),
    documents: [{ content, path: "specs/auth/spec.md" }],
  });
  const requirement = {
    capability: "auth",
    delta,
    name: "Timeout",
    operation: "MODIFIED" as const,
  };

  it("finds the requirement's lines in the capability's delta spec", () => {
    const anchor = requirementAnchor(
      withSpec(`## MODIFIED Requirements\n\n${delta}\n`),
      requirement
    );
    expect(anchor).toStrictEqual({
      file: "specs/auth/spec.md",
      line: 7,
      quote: ["### Requirement: Timeout"],
      start: 3,
    });
    expect(
      isAt({ ...anchor, id: "1", text: "x" }, anchor) &&
        !isAt({ ...anchor, id: "2", line: 8, text: "x" }, anchor)
    ).toBe(true);
  });

  it("points at the file alone when the block isn't in it", () => {
    expect(requirementAnchor(withSpec("other"), requirement)).toStrictEqual({
      file: "specs/auth/spec.md",
      quote: ["### Requirement: Timeout"],
    });
  });
});

describe(composeSpecFeedback, () => {
  it("lists comments by file and line with their quotes, then general ones", () => {
    expect(
      composeSpecFeedback("add-login", [
        { id: "g", text: "Split it in two." },
        {
          file: "proposal.md",
          id: "b",
          line: 9,
          quote: ["Login with SSO."],
          text: "Which providers?",
        },
        {
          file: "design.md",
          id: "a",
          line: 4,
          quote: ["## Goals"],
          start: 2,
          text: "Add a non-goal\nfor MFA.",
        },
        { file: "proposal.md", id: "e", line: 1, text: "   " },
      ])
    ).toBe(
      [
        "Review feedback on the proposed change. Revise its planning artifacts to address each point and keep them coherent, without touching any code, then reply with what you changed.",
        "",
        "1. openspec/changes/add-login/design.md:2-4",
        "   > ## Goals",
        "   Add a non-goal",
        "   for MFA.",
        "",
        "2. openspec/changes/add-login/proposal.md:9",
        "   > Login with SSO.",
        "   Which providers?",
        "",
        "3. General: Split it in two.",
      ].join("\n")
    );
  });
});
