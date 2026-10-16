import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, LayersIcon, MonitorIcon, PencilIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type {
  CheckDef,
  CheckOverlay,
  ChecksConfig,
  ChecksView,
  SettingsScope,
} from "../../../shared/types";
import { saveChecks } from "../../api";
import { Chip, muted } from "../../components/page";
import {
  ScopeToggle,
  TeamChip,
  TeamSavedNote,
  defaultScope,
  useProjectTeam,
} from "../projects/team-scope";
import { checkSections } from "./checks";
import {
  DEFAULT_TIMEOUT,
  fromDraft,
  mergeIntoTeam,
  stillOwn,
  toDraft,
} from "./checks-draft";
import type { DraftGroup } from "./checks-draft";
import { ChecksEditor } from "./checks-editor";
import { checksKey, projectChecksQuery } from "./checks-queries";

const isOff = (c: CheckOverlay): c is { name: string; disabled: true } =>
  "disabled" in c;

/** The user's own checks, without the entries turning team checks off. */
const ownChecks = (config: ChecksConfig): CheckDef[] =>
  config.personal.filter((c): c is CheckDef => !isOff(c));

const names = (list: string[]): string =>
  list.length === 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/** What copying the user's checks did to the team's list. */
const copyingSummary = (c: { added: string[]; replaced: string[] }): string =>
  [
    c.added.length > 0 && `Added ${names(c.added)} to the team's checks.`,
    c.replaced.length > 0 &&
      `Your version of ${names(c.replaced)} replaces the team's.`,
  ]
    .filter(Boolean)
    .join(" ");

/** The project's checks, in its settings: what Review runs, and where to change it. */
export const ChecksSettings = ({ projectId }: { projectId: string }) => {
  const queryClient = useQueryClient();
  const query = useQuery(projectChecksQuery(projectId));
  const { data: team } = useProjectTeam(projectId);
  const config: ChecksConfig | undefined = query.data;
  const [draft, setDraft] = useState<DraftGroup[]>();
  const [scope, setScope] = useState<SettingsScope>("personal");
  /** The team list being edited holds the user's own checks, copied in. */
  const [copying, setCopying] = useState<{
    added: string[];
    replaced: string[];
  }>();
  const [formError, setFormError] = useState<string>();
  const saveMutation = useMutation({
    mutationFn: async ({
      checks,
      scope: to,
      tidy,
    }: {
      checks: CheckOverlay[] | null;
      scope: SettingsScope;
      /** Drop the user's own entries that the saved team list now matches. */
      tidy?: boolean;
    }) => {
      const saved = await saveChecks(projectId, checks, to);
      if (!tidy) {
        return saved;
      }
      const own = stillOwn(saved.personal, saved.team);
      return own.length === saved.personal.length
        ? saved
        : saveChecks(projectId, own, "personal");
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData<ChecksView>(
        checksKey(projectId),
        (v) => v && { ...v, ...saved }
      );
      setDraft(undefined);
      setCopying(undefined);
      // Every checkout's checks follow the project's list.
      await queryClient.invalidateQueries({ queryKey: checksKey(projectId) });
    },
  });
  const save = (
    checks: CheckOverlay[] | null,
    to: SettingsScope,
    tidy = false
  ) => saveMutation.mutate({ checks, scope: to, tidy });
  /** Replaces the user's own entry for `name`; without `entry` it's removed. */
  const savePersonal = (name: string, entry?: CheckOverlay) => {
    if (!config) {
      return;
    }
    const rest = config.personal.filter((c) => c.name !== name);
    save(entry ? [...rest, entry] : rest, "personal");
  };
  const saving = saveMutation.isPending;
  const error = (saveMutation.error ?? query.error)?.message;
  const startEditing = (to: SettingsScope) => {
    if (!config) {
      return;
    }
    setScope(to);
    setCopying(undefined);
    setFormError(undefined);
    setDraft(toDraft(to === "team" ? config.team : ownChecks(config)));
  };
  /** Opens the team's list with the user's own checks laid in, to review before saving. */
  const copyToTeam = () => {
    if (!config) {
      return;
    }
    const own = ownChecks(config);
    setScope("team");
    setFormError(undefined);
    setCopying({
      added: own
        .filter((c) => !config.team.some((t) => t.name === c.name))
        .map((c) => c.name),
      replaced: own
        .filter((c) => config.team.some((t) => t.name === c.name))
        .map((c) => c.name),
    });
    setDraft(toDraft(mergeIntoTeam(config.team, own)));
  };
  const canCopy = !!config?.teamWritable && ownChecks(config).length > 0;
  const turnedOff = config?.personal.filter(isOff) ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="font-semibold">Checks</h2>
          <p className={muted}>Run from Review before publishing</p>
        </div>
        {config && !draft && canCopy && (
          <Button
            variant="ghost"
            size="sm"
            title="Open the team's checks with yours added, to review before saving"
            onClick={copyToTeam}
          >
            <CopyIcon /> Copy mine to team
          </Button>
        )}
        {config && !draft && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              startEditing(
                config.teamWritable
                  ? defaultScope(
                      config.team.length > 0,
                      config.personal.length > 0
                    )
                  : "personal"
              )
            }
          >
            <PencilIcon /> Edit
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {config?.errors.map((e) => (
          <p key={e} className="text-warn text-sm">
            {e}
          </p>
        ))}
        {!config && !error && <p className={muted}>Loading…</p>}

        {config && !draft && config.checks.length === 0 && (
          <p className={muted}>
            No checks. Add the commands a change must pass (tests, lint, a
            Docker build), for yourself or for the whole team in
            devcontainer.json.
          </p>
        )}
        {config &&
          !draft &&
          (config.checks.length > 0 || turnedOff.length > 0) && (
            <ul className="flex flex-col gap-1.5">
              {checkSections(config.checks).map((section) => [
                section.group && (
                  <li
                    key={`group-${section.group}`}
                    className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs font-medium first:mt-0"
                  >
                    <LayersIcon className="size-3.5" /> {section.group}
                  </li>
                ),
                ...section.checks.map((c) => (
                  <li
                    key={c.name}
                    className={cn(
                      "flex min-w-0 items-center gap-2 text-sm",
                      section.group && "pl-5"
                    )}
                  >
                    <span className="font-medium">{c.name}</span>
                    {c.source === "team" && <TeamChip />}
                    {c.source === "override" && (
                      <Chip title="Your version of a team check">
                        your version
                      </Chip>
                    )}
                    {c.source === "personal" && (
                      <Chip title="Only you run this check">yours</Chip>
                    )}
                    {c.where === "host" && (
                      <Chip className="gap-1" title="Runs on this machine">
                        <MonitorIcon className="size-3" /> host
                      </Chip>
                    )}
                    <code
                      className="text-muted-foreground min-w-0 truncate font-mono text-xs"
                      title={c.command}
                    >
                      {c.command}
                    </code>
                    {c.timeout !== DEFAULT_TIMEOUT && (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {c.timeout} s
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {c.where === "host" && !c.approved && (
                        <span className="text-warn text-xs">
                          needs approval on first run
                        </span>
                      )}
                      {c.source === "team" && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground"
                          disabled={saving}
                          title="Stop running this team check yourself"
                          onClick={() =>
                            savePersonal(c.name, {
                              disabled: true,
                              name: c.name,
                            })
                          }
                        >
                          Turn off
                        </Button>
                      )}
                      {c.source === "override" && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-muted-foreground"
                          disabled={saving}
                          title="Drop your version and run the team's"
                          onClick={() => savePersonal(c.name)}
                        >
                          Use the team&apos;s
                        </Button>
                      )}
                    </span>
                  </li>
                )),
              ])}
              {turnedOff.map((c) => (
                <li
                  key={`off-${c.name}`}
                  className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm"
                >
                  <span className="font-medium line-through">{c.name}</span>
                  <Chip title="A team check you turned off">off for you</Chip>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground ml-auto"
                    disabled={saving}
                    onClick={() => savePersonal(c.name)}
                  >
                    Turn on
                  </Button>
                </li>
              ))}
            </ul>
          )}
        {config && !draft && config.personal.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground w-fit"
            disabled={saving}
            title="Drop your own checks and changes, and run the team's"
            onClick={() => save(null, "personal")}
          >
            Clear my changes
          </Button>
        )}
        {!draft &&
          saveMutation.isSuccess &&
          saveMutation.variables.scope === "team" && (
            <TeamSavedNote team={team} />
          )}

        {config && draft && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const result = fromDraft(draft);
              if ("error" in result) {
                setFormError(result.error);
                return;
              }
              setFormError(undefined);
              save(
                scope === "team"
                  ? result.checks
                  : [...turnedOff, ...result.checks],
                scope,
                !!copying
              );
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Editing</span>
              <ScopeToggle
                value={scope}
                onChange={startEditing}
                team={team}
                disabled={saving}
              />
            </div>
            {copying && (
              <Alert>
                <CopyIcon />
                <AlertDescription>
                  <p>
                    {copyingSummary(copying)} Review the list and save to write
                    it to {team?.file ?? "devcontainer.json"}. Your own copies
                    that match are dropped, so you run the team&apos;s.
                  </p>
                </AlertDescription>
              </Alert>
            )}
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <ChecksEditor
              draft={draft}
              onChange={setDraft}
              actions={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(undefined);
                      setCopying(undefined);
                      setFormError(undefined);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </>
              }
            />
            <p className={muted}>
              A group&apos;s checks run together from one button, in the order
              shown.{" "}
              {scope === "team"
                ? `Saved in ${team?.file ?? "devcontainer.json"} for everyone; commit it to share. Commands that run on this machine count as approved for you, and everyone else approves them on first run.`
                : "Saved in your opendevhub config for this project. A check named like a team check replaces it for you. Commands you save here that run on this machine count as approved."}
            </p>
          </form>
        )}
      </div>
    </section>
  );
};
