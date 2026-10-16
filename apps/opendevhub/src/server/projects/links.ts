import { normalizeJql, validJql } from "../../shared/jira";
import type { Project, ProjectLinks, SettingsScope } from "../../shared/types";
import type { ProjectSettingsStore } from "../config";
import type { DashboardDeps } from "../dashboard-api";
import { NotFoundError } from "../errors";
import { resolveProjectSettings } from "./team-settings";
import type { TeamSettingsStore } from "./team-settings";

export interface ProjectLinksDeps {
  project: (id: string) => Project | undefined;
  settings: ProjectSettingsStore;
  team: Pick<TeamSettingsStore, "get" | "update">;
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

/** Reads the links from a project's settings entry, dropping any that were hand-edited into a bad shape. */
export const readProjectLinks = (
  entry: Record<string, unknown>
): ProjectLinks => {
  const { jiraBoard, jiraJql, forgejoRepository } = entry as {
    jiraBoard?: { id?: unknown; name?: unknown };
    jiraJql?: unknown;
    forgejoRepository?: unknown;
  };
  const board =
    jiraBoard &&
    Number.isSafeInteger(jiraBoard.id) &&
    (jiraBoard.id as number) > 0 &&
    typeof jiraBoard.name === "string"
      ? { id: jiraBoard.id as number, name: jiraBoard.name }
      : undefined;
  const jql = typeof jiraJql === "string" ? normalizeJql(jiraJql) : "";
  const repository =
    typeof forgejoRepository === "string" && REPOSITORY.test(forgejoRepository)
      ? forgejoRepository
      : undefined;
  return {
    ...(board ? { jiraBoard: board } : {}),
    ...(jql && validJql(jql) ? { jiraJql: jql } : {}),
    ...(repository ? { forgejoRepository: repository } : {}),
  };
};

/**
 * The Jira board and Forgejo repository a project is linked to: the user's `config.json` entry over the team's
 * devcontainer.json, link by link.
 */
export const projectLinkSettings = (
  deps: ProjectLinksDeps
): { projectLinks: NonNullable<DashboardDeps["projectLinks"]> } => {
  const projectOf = (id: string): Project => {
    const project = deps.project(id);
    if (!project) {
      throw new NotFoundError(id);
    }
    return project;
  };
  return {
    projectLinks: {
      get: (id) => {
        const project = projectOf(id);
        return readProjectLinks(
          resolveProjectSettings(
            deps.team.get(project).settings,
            deps.settings.get(project.path)
          )
        );
      },
      // Saving replaces every link of that layer, so a link left out is removed.
      save: (id, links, scope: SettingsScope = "personal") => {
        const project = projectOf(id);
        const patch = {
          forgejoRepository: links.forgejoRepository,
          jiraBoard: links.jiraBoard
            ? { id: links.jiraBoard.id, name: links.jiraBoard.name }
            : undefined,
          jiraJql: links.jiraJql ? normalizeJql(links.jiraJql) : undefined,
        };
        if (scope === "team") {
          deps.team.update(project, patch);
          // The user's own links would hide the team's they just saved.
          deps.settings.update(project.path, {
            forgejoRepository: undefined,
            jiraBoard: undefined,
            jiraJql: undefined,
          });
          return;
        }
        deps.settings.update(project.path, patch);
      },
    },
  };
};
