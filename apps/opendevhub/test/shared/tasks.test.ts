import { describe, expect, it } from "vitest";

import {
  branchSlug,
  deriveTitle,
  modelShortName,
  slugify,
  taskBranches,
  uniqueBranch,
  variantLabels,
  variantTitle,
} from "../../src/shared/tasks";

const m = (id: string, variant?: string) => ({
  model: { id, providerID: "p", ...(variant ? { variant } : {}) },
});

describe(deriveTitle, () => {
  it("takes the first non-empty line without markdown markers", () => {
    expect(deriveTitle("\n\n## Fix the   login bug\nmore")).toBe(
      "Fix the login bug"
    );
    expect(deriveTitle("- add tests")).toBe("add tests");
    expect(deriveTitle("   \n ")).toBe("");
  });

  it("cuts long lines at a word boundary, at most 60 characters", () => {
    const t = deriveTitle(
      "Refactor the payment service so that every provider goes through one retry policy"
    );
    expect(t).toBe("Refactor the payment service so that every provider goes…");
    expect(deriveTitle("a".repeat(80))).toBe(`${"a".repeat(59)}…`);
    expect(deriveTitle("x".repeat(500))).toHaveLength(60);
  });
});

describe("slugify and branchSlug", () => {
  it("makes lowercase ASCII slugs of at most 40 characters", () => {
    expect(slugify("Fix the Login bug!")).toBe("fix-the-login-bug");
    expect(slugify("Crème brûlée")).toBe("creme-brulee");
    expect(slugify("abc ".repeat(20))).toBe("abc-".repeat(10).slice(0, -1));
    expect(slugify("a".repeat(50))).toHaveLength(40);
  });

  it("falls back to 'task' when nothing is left", () => {
    expect(branchSlug("🚀🔥")).toBe("task");
    expect(branchSlug("项目")).toBe("task");
    expect(branchSlug("Ship it")).toBe("ship-it");
  });
});

describe("modelShortName and variantLabels", () => {
  it("names a model by its last id segment and non-default variant", () => {
    expect(
      modelShortName({ id: "claude-sonnet-5-5", providerID: "anthropic" })
    ).toBe("claude-sonnet-5-5");
    expect(
      modelShortName({
        id: "anthropic/claude-opus-5-5",
        providerID: "openrouter",
        variant: "high",
      })
    ).toBe("claude-opus-5-5-high");
    expect(
      modelShortName({
        id: "GPT 6.1 Codex",
        providerID: "p",
        variant: "default",
      })
    ).toBe("gpt-6-1-codex");
    expect(
      modelShortName({ id: "x".repeat(60), providerID: "p" })
    ).toHaveLength(30);
  });

  it("uses model names when all are set and distinct, numbers otherwise", () => {
    expect(variantLabels([m("a"), m("b")])).toStrictEqual(["a", "b"]);
    expect(variantLabels([m("a", "low"), m("a", "high")])).toStrictEqual([
      "a-low",
      "a-high",
    ]);
    expect(variantLabels([m("a"), m("a")])).toStrictEqual(["1", "2"]);
    expect(variantLabels([m("a"), {}])).toStrictEqual(["1", "2"]);
  });

  it("titles variant sessions", () => {
    expect(variantTitle("Fix", "a", 1)).toBe("Fix");
    expect(variantTitle("Fix", "claude", 2)).toBe("Fix · claude");
    expect(variantTitle("Fix", "2", 3)).toBe("Fix · #2");
  });
});

describe("branch names", () => {
  it("numbers a taken name and remembers what it handed out", () => {
    const taken = new Set(["x", "x-2"]);
    expect(uniqueBranch("x", taken)).toBe("x-3");
    expect(taken.has("x-3")).toBeTruthy();
    expect(uniqueBranch("y", taken)).toBe("y");
  });

  it("derives a free branch for one variant, and keeps a typed one as is", () => {
    expect(
      taskBranches({
        title: "Fix login",
        variants: [{}],
        taken: new Set(["fix-login"]),
      })
    ).toStrictEqual(["fix-login-2"]);
    expect(
      taskBranches({
        branch: "feature/x",
        title: "t",
        variants: [{}],
        taken: new Set(["feature/x"]),
      })
    ).toStrictEqual(["feature/x"]);
  });

  it("suffixes each of several variants and keeps them free", () => {
    const taken = new Set(["feat-a"]);
    expect(
      taskBranches({
        branch: "feat",
        title: "t",
        variants: [m("a"), m("b")],
        taken,
      })
    ).toStrictEqual(["feat-a-2", "feat-b"]);
    expect(taken).toStrictEqual(new Set(["feat-a"]));
    expect(
      taskBranches({ title: "Fix login", variants: [{}, {}] })
    ).toStrictEqual(["fix-login-1", "fix-login-2"]);
  });
});
