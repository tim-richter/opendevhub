import { Button } from "@opendevhub/ui/button";
import { Input } from "@opendevhub/ui/input";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import {
  PROJECT_COLORS,
  PROJECT_SHORT_NAME,
} from "../../../shared/project-appearance";
import type {
  ProjectColor,
  ProjectAppearance,
} from "../../../shared/project-appearance";
import type { ProjectView, SettingsScope } from "../../../shared/types";
import { saveProjectAppearance } from "../../api";
import { muted } from "../../components/page";
import { cn } from "../../lib/utils";
import {
  ScopeToggle,
  TeamChip,
  TeamSavedNote,
  defaultScope,
  useProjectTeam,
  useRefreshProjectTeam,
} from "./team-scope";

const isSet = (a: ProjectAppearance | undefined): boolean =>
  !!(a?.shortName || a?.color);

const swatches: Record<ProjectColor, string> = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};

export const AppearanceSettings = ({ view }: { view: ProjectView }) => {
  const [shortName, setShortName] = useState(view.appearance?.shortName ?? "");
  const [color, setColor] = useState<ProjectColor | "">(
    view.appearance?.color ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<SettingsScope>();
  const { data: team } = useProjectTeam(view.project.id);
  const refreshTeam = useRefreshProjectTeam(view.project.id);
  const inTeam = isSet(team?.team.appearance);
  const inPersonal = isSet(team?.personal.appearance);
  const [chosenScope, setScope] = useState<SettingsScope>();
  const scope = chosenScope ?? defaultScope(inTeam, inPersonal);
  const valid = shortName === "" || PROJECT_SHORT_NAME.test(shortName);
  const changed =
    shortName.toUpperCase() !== (view.appearance?.shortName ?? "") ||
    color !== (view.appearance?.color ?? "");

  useEffect(() => {
    setShortName(view.appearance?.shortName ?? "");
    setColor(view.appearance?.color ?? "");
  }, [view.appearance?.shortName, view.appearance?.color]);

  const save = async (
    appearance: { shortName: string; color: ProjectColor | "" },
    to: SettingsScope
  ) => {
    setSaving(true);
    setError(undefined);
    try {
      await saveProjectAppearance(view.project.id, appearance, to);
      setSaved(to);
      await refreshTeam();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Saving the same look to the team still moves it there.
    if (!valid || (!changed && !(scope === "team" && inPersonal))) {
      return;
    }
    await save({ shortName: shortName.toUpperCase(), color }, scope);
  };

  return (
    <form
      className="flex flex-col gap-7"
      onSubmit={(event) => void submit(event)}
    >
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Sidebar letters</h2>
        <p className={muted}>
          Choose two or three letters for this project. Leave blank to use its
          name.
        </p>
        <div className="flex items-center gap-3">
          <label className="sr-only" htmlFor="project-short-name">
            Sidebar letters
          </label>
          <Input
            id="project-short-name"
            className="w-24 uppercase"
            autoComplete="off"
            maxLength={3}
            pattern="[A-Za-z]{2,3}"
            placeholder="Auto"
            spellCheck={false}
            value={shortName}
            onChange={(event) => {
              setShortName(event.target.value);
              setSaved(undefined);
            }}
          />
          <span className={muted}>Two or three letters</span>
        </div>
        {!valid && (
          <p className="text-destructive text-sm" role="alert">
            Enter two or three letters, or leave this blank.
          </p>
        )}
      </section>
      <fieldset className="flex flex-col gap-3">
        <legend className="font-semibold">Sidebar color</legend>
        <p className={muted}>Choose a background for the project button.</p>
        <div className="flex flex-wrap gap-2">
          <label className="cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name="project-color"
              checked={color === ""}
              onChange={() => {
                setColor("");
                setSaved(undefined);
              }}
            />
            <span className="border-input peer-focus-visible:ring-ring peer-checked:ring-ring bg-sidebar flex size-9 items-center justify-center rounded-lg border text-xs font-semibold peer-checked:ring-2 peer-focus-visible:ring-2">
              Aa
            </span>
            <span className="sr-only">Default</span>
          </label>
          {PROJECT_COLORS.map((choice) => (
            <label className="cursor-pointer" key={choice}>
              <input
                className="peer sr-only"
                type="radio"
                name="project-color"
                aria-label={choice}
                checked={color === choice}
                onChange={() => {
                  setColor(choice);
                  setSaved(undefined);
                }}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "peer-focus-visible:ring-ring peer-checked:ring-ring block size-9 rounded-lg peer-checked:ring-2 peer-focus-visible:ring-2",
                  swatches[choice]
                )}
              />
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <ScopeToggle
          value={scope}
          onChange={setScope}
          team={team}
          disabled={saving}
        />
        <Button
          type="submit"
          disabled={
            saving || !valid || (!changed && !(scope === "team" && inPersonal))
          }
        >
          {saving ? "Saving…" : "Save appearance"}
        </Button>
        {inTeam && !inPersonal && <TeamChip />}
        {inTeam && inPersonal && (
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground"
            disabled={saving}
            title="Drop your own letters and color and use the team's"
            onClick={() => void save({ shortName: "", color: "" }, "personal")}
          >
            Use the team&apos;s
          </Button>
        )}
        {saved === "personal" && !changed && (
          <span className="text-muted-foreground text-sm">Saved</span>
        )}
      </div>
      {saved === "team" && !changed && <TeamSavedNote team={team} />}
    </form>
  );
};
