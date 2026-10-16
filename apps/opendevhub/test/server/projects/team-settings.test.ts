import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InvalidRequestError } from "../../../src/server/git/worktrees";
import {
  FileTeamSettings,
  editDevcontainer,
  parseDevcontainer,
  readTeam,
  resolveProjectSettings,
} from "../../../src/server/projects/team-settings";
import type { Project } from "../../../src/shared/types";

const SOURCE = `{
\t// how the image is built
\t"image": "node:22", // pinned
\t"forwardPorts": [3000,],
}
`;

describe(parseDevcontainer, () => {
  it("allows comments and trailing commas", () => {
    expect(parseDevcontainer(SOURCE)).toStrictEqual({
      value: { image: "node:22", forwardPorts: [3000] },
      errors: [],
    });
  });

  it("reports broken files and non-objects", () => {
    expect(parseDevcontainer("{ nope").errors.length).toBeGreaterThan(0);
    expect(parseDevcontainer("[]").errors).toStrictEqual([
      "expected a JSON object",
    ]);
  });
});

describe(readTeam, () => {
  it("keeps only the keys a team may share", () => {
    expect(
      readTeam({
        forwardPorts: [3000],
        customizations: {
          opendevhub: {
            name: "Demo",
            checks: [],
            sshAgent: false,
            approvedHostChecks: ["x"],
            personalization: {},
          },
        },
      })
    ).toStrictEqual({
      settings: { name: "Demo", checks: [] },
      forwardPorts: [3000],
    });
    expect(readTeam(undefined)).toStrictEqual({
      settings: {},
      forwardPorts: undefined,
    });
  });
});

describe(editDevcontainer, () => {
  it("adds settings keeping comments and indentation, and removing them restores the file", () => {
    const added = editDevcontainer(SOURCE, [
      [["customizations", "opendevhub", "name"], "Demo"],
    ]);
    expect(added).toContain("// how the image is built");
    expect(added).toContain('"image": "node:22", // pinned');
    expect(added).toContain(
      '\t"customizations": {\n\t\t"opendevhub": {\n\t\t\t"name": "Demo"'
    );
    expect(parseDevcontainer(added).value?.customizations).toStrictEqual({
      opendevhub: { name: "Demo" },
    });
    expect(
      editDevcontainer(added, [
        [["customizations", "opendevhub", "name"], undefined],
      ])
    ).toBe(SOURCE);
  });

  it("leaves other tools' customizations alone", () => {
    const text = `{
  "customizations": {
    "vscode": { "extensions": [] },
    "opendevhub": { "color": "teal" }
  }
}
`;
    const out = editDevcontainer(text, [
      [["customizations", "opendevhub", "color"], undefined],
    ]);
    expect(parseDevcontainer(out).value).toStrictEqual({
      customizations: { vscode: { extensions: [] } },
    });
    expect(out).toContain('  "customizations": {\n    "vscode"');
  });

  it("refuses to edit a file it can't parse", () => {
    expect(() => editDevcontainer("{ nope", [[["forwardPorts"], [1]]])).toThrow(
      InvalidRequestError
    );
  });
});

describe(FileTeamSettings, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  const projectWith = (text: string): Project => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-team-"));
    dirs.push(dir);
    const file = path.join(dir, "devcontainer.json");
    fs.writeFileSync(file, text);
    return { id: "demo", name: "demo", path: dir, devcontainerPath: file };
  };

  it("reads, writes and re-reads the team layer", () => {
    const project = projectWith(SOURCE);
    const team = new FileTeamSettings();
    expect(team.get(project)).toStrictEqual({
      settings: {},
      forwardPorts: [3000],
      errors: [],
    });
    team.update(project, {
      checks: [{ name: "lint", command: "pnpm lint" }],
    });
    team.setForwardPorts(project, [3000, 5173]);
    expect(team.get(project)).toStrictEqual({
      settings: { checks: [{ name: "lint", command: "pnpm lint" }] },
      forwardPorts: [3000, 5173],
      errors: [],
    });
    const text = fs.readFileSync(project.devcontainerPath, "utf-8");
    expect(text).toContain("// pinned");
    team.setForwardPorts(project, []);
    expect(team.get(project).forwardPorts).toBeUndefined();
  });

  it("reports a file it can't read instead of throwing", () => {
    const project = projectWith("{ nope");
    const read = new FileTeamSettings().get(project);
    expect(read.settings).toStrictEqual({});
    expect(read.errors[0]).toMatch(/^could not read /u);
    expect(
      new FileTeamSettings().get({
        ...project,
        devcontainerPath: path.join(project.path, "missing.json"),
      }).errors
    ).toHaveLength(1);
  });
});

describe(resolveProjectSettings, () => {
  it("lets the personal entry win key by key and leaves checks out", () => {
    expect(
      resolveProjectSettings(
        { name: "Team", color: "teal", checks: [] },
        { name: "Mine", hostPorts: [9222] }
      )
    ).toStrictEqual({ name: "Mine", color: "teal", hostPorts: [9222] });
  });
});
