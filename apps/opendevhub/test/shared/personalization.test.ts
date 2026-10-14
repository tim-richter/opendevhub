import { describe, expect, it } from "vitest";

import {
  creationSettings,
  readPersonalization,
  readProjectPersonalization,
  resolvePersonalization,
} from "../../src/shared/personalization";

describe(readPersonalization, () => {
  it("keeps published features, a setup command and dotfiles", () => {
    expect(
      readPersonalization({
        dotfiles: { repository: " tim/dotfiles ", targetPath: "" },
        features: {
          "ghcr.io/x/features/git-town:1": { version: "21" },
          "https://example.com/feature.tgz": true,
        },
        setupCommand: "brew install git-town",
      })
    ).toStrictEqual({
      dotfiles: { repository: "tim/dotfiles" },
      features: {
        "ghcr.io/x/features/git-town:1": { version: "21" },
        "https://example.com/feature.tgz": {},
      },
      setupCommand: "brew install git-town",
    });
  });

  it("drops local features, bad options, blank commands and option-like repositories", () => {
    expect(
      readPersonalization({
        dotfiles: { repository: "--upload-pack=evil" },
        features: {
          "./local-feature": {},
          "ghcr.io/x/y:1": "latest",
          "with space/x": {},
        },
        setupCommand: "   ",
      })
    ).toStrictEqual({ features: {} });
    expect(readPersonalization("nonsense")).toStrictEqual({ features: {} });
  });
});

describe(resolvePersonalization, () => {
  const global = readPersonalization({
    dotfiles: { repository: "tim/dotfiles" },
    features: { "ghcr.io/a/b:1": { x: 1 }, "ghcr.io/c/d:1": {} },
    setupCommand: "echo global",
  });

  it("adds the project's settings to the global ones", () => {
    const project = readProjectPersonalization({
      dotfiles: { repository: "https://example.com/work-dots.git" },
      features: { "ghcr.io/a/b:1": { x: 2 } },
      setupCommand: "echo project",
    });
    expect(resolvePersonalization(global, project)).toStrictEqual({
      dotfiles: { repository: "https://example.com/work-dots.git" },
      features: { "ghcr.io/a/b:1": { x: 2 }, "ghcr.io/c/d:1": {} },
      setupCommands: ["echo global", "echo project"],
    });
  });

  it("inherits the global settings by default, and only the project's when turned off", () => {
    expect(
      resolvePersonalization(global, readProjectPersonalization(undefined))
    ).toStrictEqual({
      dotfiles: global.dotfiles,
      features: global.features,
      setupCommands: ["echo global"],
    });
    expect(
      resolvePersonalization(
        global,
        readProjectPersonalization({ inheritGlobal: false })
      )
    ).toStrictEqual({ features: {}, setupCommands: [] });
  });
});

describe(creationSettings, () => {
  it("ignores setup commands and the order of keys", () => {
    expect(
      creationSettings({
        features: { a: { x: 1, y: 2 }, b: {} },
        setupCommands: ["one"],
      })
    ).toBe(
      creationSettings({
        features: { b: {}, a: { y: 2, x: 1 } },
        setupCommands: [],
      })
    );
  });
});
