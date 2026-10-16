import type { Project, SettingsScope } from "../../shared/types";
import type { ProjectSettingsStore } from "../config";
import type { DashboardDeps } from "../dashboard-api";
import { extraForwardPorts, hostPorts } from "../environments/config";
import { NotFoundError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import type { TeamSettingsStore } from "./team-settings";

export interface ProjectPortsDeps {
  project: (id: string) => Project | undefined;
  settings: ProjectSettingsStore;
  team: Pick<TeamSettingsStore, "get" | "setForwardPorts">;
  /** Applies the saved ports to the project's running environments. */
  refreshPorts: (id: string) => Promise<void>;
}

type PortsDep = NonNullable<DashboardDeps["projectPorts"]>;

const sortedUnique = (ports: number[]): number[] =>
  [...new Set(ports)].toSorted((a, b) => a - b);

/** "port 9222 is already a host port", or "ports 80, 443 are already host ports". */
const alreadyMessage = (ports: number[], noun: string): string =>
  ports.length === 1
    ? `port ${ports[0]} is already a ${noun} of this project`
    : `ports ${ports.join(", ")} are already ${noun}s of this project`;

/** devcontainer.json's numeric `forwardPorts`; `"service:port"` entries are left to it. */
export const teamForwardPorts = (raw: unknown): number[] =>
  Array.isArray(raw) ? extraForwardPorts({ forwardPorts: raw }) : [];

/**
 * The project's own forwarded ports and host ports, both kept in its `config.json` entry. A port can't be
 * both: the host port owns its number inside the container. With `team`, forwarded ports are saved to
 * devcontainer.json's own `forwardPorts` instead.
 */
export const projectPortSettings = (
  deps: ProjectPortsDeps
): { projectPorts: PortsDep; projectHostPorts: PortsDep } => {
  const projectOf = (id: string): Project => {
    const project = deps.project(id);
    if (!project) {
      throw new NotFoundError(id);
    }
    return project;
  };
  const pathOf = (id: string): string => projectOf(id).path;
  /** Replaces the numbers in devcontainer.json's `forwardPorts`, keeping its other entries. */
  const saveTeam = async (id: string, ports: number[]): Promise<void> => {
    const project = projectOf(id);
    const unique = sortedUnique(ports);
    const overlap = unique.filter((p) =>
      hostPorts(deps.settings.get(project.path)).includes(p)
    );
    if (overlap.length > 0) {
      throw new InvalidRequestError(alreadyMessage(overlap, "host port"));
    }
    const raw = deps.team.get(project).forwardPorts;
    const others = Array.isArray(raw)
      ? raw.filter((p) => typeof p !== "number")
      : [];
    deps.team.setForwardPorts(project, [...unique, ...others]);
    // Forwarding a port twice is pointless; the team's now covers the user's own.
    const own = extraForwardPorts(deps.settings.get(project.path));
    const left = own.filter((p) => !unique.includes(p));
    if (left.length !== own.length) {
      deps.settings.update(project.path, {
        forwardPorts: left.length > 0 ? left : undefined,
      });
    }
    await deps.refreshPorts(id);
  };
  const save = async (
    id: string,
    ports: number[],
    key: "forwardPorts" | "hostPorts",
    others: number[],
    othersNoun: string
  ): Promise<void> => {
    const path = pathOf(id);
    const unique = sortedUnique(ports);
    const overlap = unique.filter((p) => others.includes(p));
    if (overlap.length > 0) {
      throw new InvalidRequestError(alreadyMessage(overlap, othersNoun));
    }
    deps.settings.update(path, {
      [key]: unique.length > 0 ? unique : undefined,
    });
    await deps.refreshPorts(id);
  };
  return {
    projectHostPorts: {
      get: (id) => hostPorts(deps.settings.get(pathOf(id))),
      save: (id, ports) =>
        save(
          id,
          ports,
          "hostPorts",
          extraForwardPorts(deps.settings.get(pathOf(id))),
          "forwarded port"
        ),
    },
    projectPorts: {
      get: (id) => extraForwardPorts(deps.settings.get(pathOf(id))),
      save: (id, ports, scope: SettingsScope = "personal") =>
        scope === "team"
          ? saveTeam(id, ports)
          : save(
              id,
              ports,
              "forwardPorts",
              hostPorts(deps.settings.get(pathOf(id))),
              "host port"
            ),
    },
  };
};
