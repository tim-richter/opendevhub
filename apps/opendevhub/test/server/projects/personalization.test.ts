import { describe, expect, it } from "vitest";

import type { ProjectSettingsStore } from "../../../src/server/config";
import { NotFoundError } from "../../../src/server/errors";
import { personalizationSettings } from "../../../src/server/projects/personalization";
import { creationSettings } from "../../../src/shared/personalization";
import type { Project } from "../../../src/shared/types";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};

const memory = () => {
  const entries: Record<string, Record<string, unknown>> = {};
  const settings: ProjectSettingsStore = {
    get: (p) => entries[p] ?? {},
    update: (p, patch) => {
      const entry = { ...entries[p], ...patch };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          delete entry[k];
        }
      }
      entries[p] = entry;
    },
  };
  const state: {
    global?: Record<string, unknown>;
    runtime: { containerId?: string; personalization?: string };
  } = { runtime: {} };
  const api = personalizationSettings({
    global: {
      get: () => state.global,
      set: (value) => {
        state.global = value;
      },
    },
    project: (id) => (id === project.id ? project : undefined),
    runtime: () => state.runtime,
    settings,
  });
  return { api, entries, state };
};

describe(personalizationSettings, () => {
  it("saves only what is set, and removes the key when nothing is", () => {
    const { api, state } = memory();
    expect(
      api.personalization.save({
        features: { "ghcr.io/x/features/git-town:1": {} },
        setupCommand: "  ",
      })
    ).toStrictEqual({
      personalization: { features: { "ghcr.io/x/features/git-town:1": {} } },
    });
    expect(state.global).toStrictEqual({
      features: { "ghcr.io/x/features/git-town:1": {} },
    });
    api.personalization.save({ features: {} });
    expect(state.global).toBeUndefined();
  });

  it("keeps a project's settings in its entry, with inheritGlobal only when off", () => {
    const { api, entries } = memory();
    api.projectPersonalization.save(project.id, {
      features: {},
      inheritGlobal: false,
      setupCommand: "echo hi",
    });
    expect(entries[project.path].personalization).toStrictEqual({
      inheritGlobal: false,
      setupCommand: "echo hi",
    });
    api.projectPersonalization.save(project.id, {
      features: {},
      inheritGlobal: true,
    });
    expect(entries[project.path]).not.toHaveProperty("personalization");
    expect(() => api.projectPersonalization.get("nope")).toThrow(NotFoundError);
  });

  it("says a rebuild is needed once features or dotfiles differ from what the container was created with", () => {
    const { api, state } = memory();
    expect(api.projectPersonalization.get(project.id).rebuildNeeded).toBe(
      false
    );
    state.runtime = { containerId: "c1" };
    expect(api.projectPersonalization.get(project.id).rebuildNeeded).toBe(
      false
    );
    const view = api.projectPersonalization.save(project.id, {
      features: { "ghcr.io/x/features/git-town:1": {} },
      inheritGlobal: true,
    });
    expect(view.rebuildNeeded).toBe(true);
    state.runtime = {
      containerId: "c2",
      personalization: creationSettings(view.effective),
    };
    // A changed setup command runs on the next start; it needs no rebuild.
    expect(
      api.projectPersonalization.save(project.id, {
        features: { "ghcr.io/x/features/git-town:1": {} },
        inheritGlobal: true,
        setupCommand: "echo new",
      }).rebuildNeeded
    ).toBe(false);
  });
});
