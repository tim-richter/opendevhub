import { describe, expect, it } from "vitest";

import type { SessionSummary, SpecChange } from "../../../../src/shared/types";
import {
  byCapability,
  documentTabs,
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
