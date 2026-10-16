import { Button } from "@opendevhub/ui/button";
import { Input } from "@opendevhub/ui/input";
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import type { ProjectView, SettingsScope } from "../../../shared/types";
import { renameProject } from "../../api";
import { Empty, Note } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { ProjectSettingsButton } from "../projects/project-settings-dialog";
import {
  ScopeToggle,
  TeamChip,
  TeamSavedNote,
  defaultScope,
  useProjectTeam,
  useRefreshProjectTeam,
} from "../projects/team-scope";
import { SettingsBlock, SettingsHeader, SettingsList } from "./settings-layout";
import { SettingsLink } from "./settings-link";

const folderName = (path: string): string =>
  path.split(/[\\/]/u).findLast(Boolean) ?? path;

const ProjectRow = ({ view }: { view: ProjectView }) => {
  const { project } = view;
  const [draft, setDraft] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [savedToTeam, setSavedToTeam] = useState(false);
  const { data: team } = useProjectTeam(project.id);
  const refreshTeam = useRefreshProjectTeam(project.id);
  const teamName = team?.team.name;
  const ownName = team?.personal.name;
  const [chosenScope, setScope] = useState<SettingsScope>();
  const scope = chosenScope ?? defaultScope(!!teamName, !!ownName);
  const folder = folderName(project.path);
  /** What Reset goes back to: the team's name, else the folder's. */
  const fallback = teamName ?? folder;
  const renamed = !!ownName || (!team && project.name !== folder);
  const changed = draft.trim() !== project.name && draft.trim() !== "";

  useEffect(() => setDraft(project.name), [project.name]);

  const save = async (name: string, to: SettingsScope = scope) => {
    setBusy(true);
    setError(undefined);
    setSavedToTeam(false);
    try {
      await renameProject(project.id, name, to);
      setSavedToTeam(to === "team");
      await refreshTeam();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed) {
      void save(draft.trim());
    }
  };
  const inputId = `project-name-${project.id}`;

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <form className="flex items-center gap-2" onSubmit={submit}>
        <label htmlFor={inputId} className="sr-only">
          Name of {project.path}
        </label>
        <Input
          id={inputId}
          className="h-8 max-w-72 font-medium"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(project.name);
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {changed && (
          <>
            <ScopeToggle
              value={scope}
              onChange={setScope}
              team={team}
              disabled={busy}
            />
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Rename"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(project.name)}
            >
              Cancel
            </Button>
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          {teamName && !ownName && !changed && (
            <TeamChip title="Named by the team in devcontainer.json" />
          )}
          {renamed && !changed && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy}
              title={
                teamName
                  ? `Go back to the team's name, ${fallback}`
                  : `Go back to the folder name, ${folder}`
              }
              onClick={() => void save("", "personal")}
            >
              <RotateCcwIcon /> Reset
            </Button>
          )}
          <ProjectSettingsButton view={view} />
        </span>
      </form>
      <Link
        to={`/p/${encodeURIComponent(project.id)}`}
        className="text-muted-foreground hover:text-foreground w-fit truncate font-mono text-xs"
        title={project.path}
      >
        {project.path}
      </Link>
      {error && (
        <div role="alert">
          <Note error>{error}</Note>
        </div>
      )}
      {savedToTeam && !changed && <TeamSavedNote team={team} />}
    </li>
  );
};

export const ProjectSettings = () => {
  const { snapshot, openAddProject } = useDash();
  const projects = [...(snapshot?.projects ?? [])].toSorted((a, b) =>
    a.project.path.localeCompare(b.project.path)
  );
  return (
    <>
      <SettingsHeader
        title="Projects"
        description="Rename projects or open a project's gear to set its sidebar letters, color, integrations, ports and checks."
        action={
          <Button variant="outline" size="sm" onClick={openAddProject}>
            Add project…
          </Button>
        }
      />
      <SettingsBlock
        title="Names"
        hint="A project is named after its folder until you rename it. The name only changes how opendevhub shows it; the folder stays as it is."
      >
        {projects.length > 0 ? (
          <SettingsList>
            {projects.map((view) => (
              <ProjectRow key={view.project.id} view={view} />
            ))}
          </SettingsList>
        ) : (
          <Empty title="No projects yet">
            <p className="text-muted-foreground text-sm">
              Add a project folder in{" "}
              <SettingsLink
                section="general"
                hash="roots"
                replace
                className="underline"
              >
                General
              </SettingsLink>{" "}
              to find your repos.
            </p>
          </Empty>
        )}
      </SettingsBlock>
    </>
  );
};
