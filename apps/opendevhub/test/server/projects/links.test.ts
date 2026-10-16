import { describe, expect, it } from "vitest";

import { NotFoundError } from "../../../src/server/errors";
import {
  projectLinkSettings,
  readProjectLinks,
} from "../../../src/server/projects/links";
import type { Project } from "../../../src/shared/types";

const project = { id: "p1", name: "demo", path: "/src/demo" } as Project;

const drop = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function setup(
  entry: Record<string, unknown> = {},
  teamEntry: Record<string, unknown> = {}
) {
  let saved = { ...entry };
  let team = { ...teamEntry };
  const { projectLinks } = projectLinkSettings({
    project: (id) => (id === project.id ? project : undefined),
    team: {
      get: () => ({ settings: team, forwardPorts: undefined, errors: [] }),
      update: (_p, patch) => {
        team = drop({ ...team, ...patch });
      },
    },
    settings: {
      get: () => saved,
      update: (_path, patch) => {
        saved = Object.fromEntries(
          Object.entries({ ...saved, ...patch }).filter(
            ([, v]) => v !== undefined
          )
        );
      },
    },
  });
  return { entry: () => saved, team: () => team, projectLinks };
}

describe(projectLinkSettings, () => {
  it("saves both links next to the project's other settings", () => {
    const { projectLinks, entry } = setup({ name: "Demo" });
    projectLinks.save(project.id, {
      forgejoRepository: "me/app",
      jiraBoard: { id: 7, name: "App board" },
    });
    expect(entry()).toStrictEqual({
      forgejoRepository: "me/app",
      jiraBoard: { id: 7, name: "App board" },
      name: "Demo",
    });
    expect(projectLinks.get(project.id)).toStrictEqual({
      forgejoRepository: "me/app",
      jiraBoard: { id: 7, name: "App board" },
    });
  });

  it("removes a link left out of the save", () => {
    const { projectLinks, entry } = setup({
      forgejoRepository: "me/app",
      jiraBoard: { id: 7, name: "App board" },
    });
    projectLinks.save(project.id, { forgejoRepository: "me/app" });
    expect(entry()).toStrictEqual({ forgejoRepository: "me/app" });
  });

  it("keeps a JQL link on one line", () => {
    const { projectLinks, entry } = setup();
    projectLinks.save(project.id, {
      jiraJql: " labels = app\n AND type = Bug ",
    });
    expect(entry()).toStrictEqual({ jiraJql: "labels = app AND type = Bug" });
    expect(projectLinks.get(project.id)).toStrictEqual({
      jiraJql: "labels = app AND type = Bug",
    });
  });

  it("shows the team's links under the user's own, link by link", () => {
    const { projectLinks } = setup(
      { forgejoRepository: "me/fork" },
      { forgejoRepository: "team/app", jiraJql: "project = APP", sshAgent: 1 }
    );
    expect(projectLinks.get(project.id)).toStrictEqual({
      forgejoRepository: "me/fork",
      jiraJql: "project = APP",
    });
  });

  it("saves to the team and drops the user's own links that would hide it", () => {
    const { projectLinks, entry, team } = setup({
      forgejoRepository: "me/fork",
      name: "Demo",
    });
    projectLinks.save(project.id, { forgejoRepository: "team/app" }, "team");
    expect(team()).toStrictEqual({ forgejoRepository: "team/app" });
    expect(entry()).toStrictEqual({ name: "Demo" });
    expect(projectLinks.get(project.id)).toStrictEqual({
      forgejoRepository: "team/app",
    });
  });

  it("throws for an unknown project", () => {
    const { projectLinks } = setup();
    expect(() => projectLinks.get("nope")).toThrow(NotFoundError);
  });
});

describe(readProjectLinks, () => {
  it("drops hand-edited links of the wrong shape", () => {
    expect(
      readProjectLinks({
        forgejoRepository: "no-slash",
        jiraBoard: { id: "7", name: "App board" },
      })
    ).toStrictEqual({});
  });
});
