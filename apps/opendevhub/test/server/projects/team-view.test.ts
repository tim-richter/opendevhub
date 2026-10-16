import { describe, expect, it } from "vitest";

import {
  projectName,
  projectTeamView,
} from "../../../src/server/projects/team-view";
import type { Project } from "../../../src/shared/types";

const project: Project = {
  id: "demo",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};

const team = (settings: Record<string, unknown>, forwardPorts?: unknown) => ({
  settings,
  forwardPorts,
  errors: [],
});

describe(projectName, () => {
  it("prefers the user's name, then the team's, then the folder's", () => {
    expect(
      projectName(project, team({ name: "Team" }), { name: " Mine " })
    ).toBe("Mine");
    expect(projectName(project, team({ name: "Team" }), {})).toBe("Team");
    expect(projectName(project, team({ name: " " }), {})).toBe("demo");
  });
});

describe(projectTeamView, () => {
  it("reads each layer on its own", () => {
    expect(
      projectTeamView(
        project,
        team({ name: "Acme", color: "teal", forgejoRepository: "acme/web" }, [
          3000,
          "db:5432",
        ]),
        { shortName: "me", forwardPorts: [5173], hostPorts: [9222] }
      )
    ).toStrictEqual({
      file: ".devcontainer/devcontainer.json",
      writable: true,
      errors: [],
      team: {
        name: "Acme",
        appearance: { color: "teal" },
        links: { forgejoRepository: "acme/web" },
        forwardPorts: [3000],
      },
      personal: {
        appearance: { shortName: "ME" },
        links: {},
        forwardPorts: [5173],
      },
    });
  });

  it("can't be written when devcontainer.json can't be read", () => {
    expect(
      projectTeamView(project, { ...team({}), errors: ["broken"] }, {})
    ).toMatchObject({ writable: false, errors: ["broken"] });
  });
});
