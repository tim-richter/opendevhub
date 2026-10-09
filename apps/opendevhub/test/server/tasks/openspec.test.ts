import { describe, expect, it } from "vitest";

import { specWorkflow } from "../../../src/server/tasks/openspec";

describe(specWorkflow, () => {
  it("is absent without any opsx command", () => {
    expect(specWorkflow([])).toBeUndefined();
    expect(specWorkflow([{ name: "review" }])).toBeUndefined();
  });

  it("lists the workflow commands opencode lacks", () => {
    expect(
      specWorkflow([
        { name: "opsx-propose" },
        { name: "opsx-apply" },
        { name: "opsx-explore" },
      ])
    ).toStrictEqual({ missing: ["opsx-update", "opsx-archive"] });
    expect(
      specWorkflow(
        ["opsx-propose", "opsx-update", "opsx-apply", "opsx-archive"].map(
          (name) => ({ name })
        )
      )
    ).toStrictEqual({ missing: [] });
  });
});
