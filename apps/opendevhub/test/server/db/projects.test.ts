import { describe, expect, it } from "vitest";

import { eventsSince } from "../../../src/server/db/events";
import type { Project } from "../../../src/shared/types";
import { memoryStores } from "../../helpers/stores";

const demo: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const other: Project = {
  devcontainerPath: "/src/other/.devcontainer.json",
  id: "other-def456",
  name: "other",
  path: "/src/other",
};

const setup = () => {
  const clock = { now: 1000 };
  const s = memoryStores(() => clock.now);
  const verbs = () => eventsSince(s.db).map((e) => `${e.verb} ${e.object.id}`);
  return { ...s, clock, verbs };
};

describe("ProjectStore", () => {
  it("inserts discovered projects with their first-seen time and main environment", () => {
    const s = setup();
    s.projects.upsertAll([demo, other]);
    expect(s.projects.get(demo.id)).toStrictEqual({
      ...demo,
      firstSeenAt: 1000,
    });
    expect(s.environments.get(demo.id)).toStrictEqual({
      createdAt: 1000,
      id: demo.id,
      kind: "main",
      projectId: demo.id,
      runtime: {},
    });
    expect(s.verbs()).toStrictEqual([
      "project.discovered demo-abc123",
      "environment.created demo-abc123",
      "project.discovered other-def456",
      "environment.created other-def456",
    ]);
  });

  it("updates known projects and records nothing when nothing changed", () => {
    const s = setup();
    s.projects.upsertAll([demo]);
    s.clock.now = 2000;
    s.projects.upsertAll([demo]);
    s.projects.upsertAll([{ ...demo, name: "Demo" }]);
    expect(s.projects.get(demo.id)).toStrictEqual({
      ...demo,
      firstSeenAt: 1000,
      name: "Demo",
    });
    expect(s.verbs()).toStrictEqual([
      "project.discovered demo-abc123",
      "environment.created demo-abc123",
    ]);
  });

  it("marks a project missing instead of deleting it, keeping its tasks, and clears the mark when it returns", () => {
    const s = setup();
    s.projects.upsertAll([demo, other]);
    s.tasks.startManual({
      createdAt: 1000,
      directory: "/workspaces/demo",
      envId: demo.id,
      projectId: demo.id,
      sessionId: "ses_1",
      title: "Fix",
    });
    s.clock.now = 2000;
    s.projects.upsertAll([other]);
    expect(s.projects.get(demo.id)?.missingSince).toBe(2000);
    expect(s.tasks.listForProject(demo.id)).toHaveLength(1);
    // Still missing: no second event.
    s.projects.upsertAll([other]);

    s.clock.now = 3000;
    s.projects.upsertAll([demo, other]);
    expect(s.projects.get(demo.id)).toStrictEqual({
      ...demo,
      firstSeenAt: 1000,
    });
    expect(s.tasks.listForProject(demo.id)).toHaveLength(1);
    expect(
      s.verbs().filter((v) => v.startsWith("project.") && v.endsWith(demo.id))
    ).toStrictEqual([
      "project.discovered demo-abc123",
      "project.missing demo-abc123",
      "project.discovered demo-abc123",
    ]);
  });

  it("answers undefined for an unknown project", () => {
    expect(setup().projects.get("nope")).toBeUndefined();
  });
});
