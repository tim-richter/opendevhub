import { ToggleGroup, ToggleGroupItem } from "@opendevhub/ui/toggle-group";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { UsersIcon } from "lucide-react";

import type { ProjectTeamView, SettingsScope } from "../../../shared/types";
import { fetchProjectTeam } from "../../api";
import { Chip, muted } from "../../components/page";

export const projectTeamKey = (projectId: string) =>
  ["project-team", projectId] as const;

/** The project's shareable settings per layer: devcontainer.json's and the user's own. */
export const projectTeamQuery = (projectId: string) =>
  queryOptions({
    queryFn: ({ signal }) => fetchProjectTeam(projectId, signal),
    queryKey: projectTeamKey(projectId),
    // devcontainer.json changes outside the app; read it again on every visit.
    staleTime: 0,
  });

export const useProjectTeam = (projectId: string) =>
  useQuery(projectTeamQuery(projectId));

/** Reads the layers again after a save changed either. */
export const useRefreshProjectTeam = (projectId: string) => {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: projectTeamKey(projectId) });
};

const TEAM_FILE = ".devcontainer/devcontainer.json";

/** Picks where a setting is saved: the user's own settings, or devcontainer.json for the whole team. */
export const ScopeToggle = (props: {
  value: SettingsScope;
  onChange: (scope: SettingsScope) => void;
  team: ProjectTeamView | undefined;
  disabled?: boolean;
}) => {
  const { value, onChange, team, disabled } = props;
  const file = team?.file ?? TEAM_FILE;
  const unwritable = team && !team.writable;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      disabled={disabled}
      aria-label="Save for"
      onValueChange={(v) => {
        if (v === "team" || v === "personal") {
          onChange(v);
        }
      }}
    >
      <ToggleGroupItem
        value="personal"
        title="Saved in your opendevhub settings, for you only"
      >
        Just me
      </ToggleGroupItem>
      <ToggleGroupItem
        value="team"
        disabled={unwritable}
        title={
          unwritable
            ? `${file} can't be edited: ${team.errors.join("; ")}`
            : `Saved in ${file}, for everyone who commits and pulls it`
        }
      >
        <UsersIcon /> Team
      </ToggleGroupItem>
    </ToggleGroup>
  );
};

/** Marks a value that comes from devcontainer.json. */
export const TeamChip = ({ title }: { title?: string }) => (
  <Chip
    className="gap-1"
    title={title ?? "Shared with the team in devcontainer.json"}
  >
    <UsersIcon className="size-3" /> team
  </Chip>
);

/** Says where a team save went and what's left to do. */
export const TeamSavedNote = ({
  team,
}: {
  team: ProjectTeamView | undefined;
}) => (
  <p className={muted} role="status">
    Saved to <code className="font-mono">{team?.file ?? TEAM_FILE}</code>.
    Commit it to share it with the team.
  </p>
);

/** Where a save goes until the user picks: the team's layer when only it has the setting. */
export const defaultScope = (
  inTeam: boolean,
  inPersonal: boolean
): SettingsScope => (inTeam && !inPersonal ? "team" : "personal");
