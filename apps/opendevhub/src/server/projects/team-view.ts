import path from "node:path";

import { readProjectAppearance } from "../../shared/project-appearance";
import type {
  Project,
  ProjectSharedSettings,
  ProjectTeamView,
} from "../../shared/types";
import { extraForwardPorts } from "../environments/config";
import { readProjectLinks } from "./links";
import { teamForwardPorts } from "./ports";
import type { TeamRead } from "./team-settings";

const nameOf = (entry: Record<string, unknown>): string | undefined =>
  typeof entry.name === "string" && entry.name.trim()
    ? entry.name.trim()
    : undefined;

const layer = (
  entry: Record<string, unknown>,
  forwardPorts: number[]
): ProjectSharedSettings => {
  const name = nameOf(entry);
  return {
    ...(name ? { name } : {}),
    appearance: readProjectAppearance(entry),
    links: readProjectLinks(entry),
    forwardPorts,
  };
};

/** A project's shareable settings as the team's devcontainer.json and the user's config.json each have them. */
export const projectTeamView = (
  project: Project,
  team: TeamRead,
  personal: Record<string, unknown>
): ProjectTeamView => ({
  file: path.relative(project.path, project.devcontainerPath),
  writable: team.errors.length === 0,
  errors: team.errors,
  team: layer(team.settings, teamForwardPorts(team.forwardPorts)),
  personal: layer(personal, extraForwardPorts(personal)),
});

/** The name a project goes by: the user's, the team's, or the folder's. */
export const projectName = (
  project: Project,
  team: TeamRead,
  personal: Record<string, unknown>
): string => nameOf(personal) ?? nameOf(team.settings) ?? project.name;
