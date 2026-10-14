import { describe, expect, it } from "vitest";

import {
  featureDraft,
  personalizationDraft,
  personalizationOf,
  summary,
} from "../../../../src/web/features/settings/personalization-draft";
import type { PersonalizationDraft } from "../../../../src/web/features/settings/personalization-draft";

const empty: PersonalizationDraft = {
  features: [],
  installCommand: "",
  repository: "",
  setupCommand: "",
  targetPath: "",
};

describe(personalizationOf, () => {
  it("round-trips saved settings through the draft", () => {
    const saved = {
      dotfiles: { repository: "tim/dotfiles", targetPath: "~/.dots" },
      features: {
        "ghcr.io/x/features/git-town:1": {},
        "ghcr.io/x/features/jq:1": { version: "1.7" },
      },
      setupCommand: "echo hi",
    };
    expect(personalizationOf(personalizationDraft(saved))).toStrictEqual({
      value: saved,
    });
  });

  it("skips blank feature rows and leaves out blank fields", () => {
    expect(
      personalizationOf({
        ...empty,
        features: [featureDraft()],
        installCommand: "./x.sh",
        setupCommand: "  ",
      })
    ).toStrictEqual({ value: { features: {} } });
  });

  it("reports local features, bad JSON, duplicates and bad repositories", () => {
    expect(
      personalizationOf({ ...empty, features: [featureDraft("./local")] })
    ).toMatchObject({ error: expect.stringMatching(/published feature/u) });
    expect(
      personalizationOf({
        ...empty,
        features: [{ ...featureDraft("ghcr.io/a/b:1"), options: "{nope" }],
      })
    ).toMatchObject({ error: expect.stringMatching(/not valid JSON/u) });
    expect(
      personalizationOf({
        ...empty,
        features: [{ ...featureDraft("ghcr.io/a/b:1"), options: "[1]" }],
      })
    ).toMatchObject({ error: expect.stringMatching(/JSON object/u) });
    expect(
      personalizationOf({
        ...empty,
        features: [
          featureDraft("ghcr.io/a/b:1"),
          featureDraft("ghcr.io/a/b:1"),
        ],
      })
    ).toStrictEqual({ error: "ghcr.io/a/b:1 is listed twice" });
    expect(
      personalizationOf({ ...empty, repository: "-oProxyCommand=x" })
    ).toMatchObject({ error: expect.stringMatching(/Dotfiles repository/u) });
  });
});

describe(summary, () => {
  it("describes what is set up", () => {
    expect(summary({ features: {} })).toBe("nothing");
    expect(
      summary({
        dotfiles: { repository: "tim/dotfiles" },
        features: { a: {}, b: {} },
        setupCommand: "x",
      })
    ).toBe("2 features, a setup command and dotfiles from tim/dotfiles");
    expect(summary({ features: {}, setupCommands: ["a", "b"] })).toBe(
      "2 setup commands"
    );
  });
});
