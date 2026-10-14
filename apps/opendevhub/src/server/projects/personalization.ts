import {
  creationSettings,
  readPersonalization,
  readProjectPersonalization,
  resolvePersonalization,
} from "../../shared/personalization";
import type {
  Personalization,
  PersonalizationView,
  ProjectPersonalization,
  ProjectPersonalizationView,
} from "../../shared/personalization";
import type { Project, ProjectId } from "../../shared/types";
import type { ProjectSettingsStore } from "../config";
import { NotFoundError } from "../errors";

export interface PersonalizationDeps {
  project: (id: string) => Project | undefined;
  settings: ProjectSettingsStore;
  /** config.json's `personalization`, read and replaced (undefined removes it). */
  global: {
    get: () => unknown;
    set: (value: Record<string, unknown> | undefined) => void;
  };
  /** The project's main container and what it was created with. */
  runtime: (id: ProjectId) => {
    containerId?: string;
    personalization?: string;
  };
}

/** What config.json keeps: only the fields that are set. Undefined when nothing is. */
const stored = (
  p: Personalization,
  extra: Record<string, unknown> = {}
): Record<string, unknown> | undefined => {
  const value: Record<string, unknown> = {
    ...(Object.keys(p.features).length > 0 ? { features: p.features } : {}),
    ...(p.setupCommand?.trim() ? { setupCommand: p.setupCommand } : {}),
    ...(p.dotfiles ? { dotfiles: p.dotfiles } : {}),
    ...extra,
  };
  return Object.keys(value).length > 0 ? value : undefined;
};

/**
 * The user's personalization: global in config.json's `personalization`, and per project in its `config.json`
 * entry. Saving applies to containers as they start; features and dotfiles need a new container.
 */
export const personalizationSettings = (deps: PersonalizationDeps) => {
  const projectOf = (id: string): Project => {
    const project = deps.project(id);
    if (!project) {
      throw new NotFoundError(id);
    }
    return project;
  };
  const global = (): Personalization => readPersonalization(deps.global.get());
  const projectView = (id: string): ProjectPersonalizationView => {
    const project = projectOf(id);
    const personalization = readProjectPersonalization(
      deps.settings.get(project.path).personalization
    );
    const g = global();
    const effective = resolvePersonalization(g, personalization);
    const rt = deps.runtime(project.id);
    // Containers created before personalization existed have none.
    const applied =
      rt.personalization ??
      creationSettings({ features: {}, setupCommands: [] });
    return {
      effective,
      global: g,
      personalization,
      rebuildNeeded:
        rt.containerId !== undefined && applied !== creationSettings(effective),
    };
  };
  return {
    personalization: {
      get: (): PersonalizationView => ({ personalization: global() }),
      save: (input: Personalization): PersonalizationView => {
        deps.global.set(stored(readPersonalization(input)));
        return { personalization: global() };
      },
    },
    projectPersonalization: {
      get: projectView,
      save: (
        id: string,
        input: ProjectPersonalization
      ): ProjectPersonalizationView => {
        const project = projectOf(id);
        const p = readProjectPersonalization(input);
        deps.settings.update(project.path, {
          personalization: stored(
            p,
            p.inheritGlobal ? {} : { inheritGlobal: false }
          ),
        });
        return projectView(id);
      },
    },
  };
};
