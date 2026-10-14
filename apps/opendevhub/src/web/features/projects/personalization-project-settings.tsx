import { Button } from "@opendevhub/ui/button";
import { Label } from "@opendevhub/ui/label";
import { Switch } from "@opendevhub/ui/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HammerIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { confirm } from "@/components/confirm-dialog";

import type {
  Personalization,
  ProjectPersonalizationView,
  ResolvedPersonalization,
} from "../../../shared/personalization";
import {
  fetchProjectPersonalization,
  postAction,
  saveProjectPersonalization,
} from "../../api";
import { muted, Note } from "../../components/page";
import {
  personalizationDraft,
  personalizationOf,
  summary,
} from "../settings/personalization-draft";
import { PersonalizationFields } from "../settings/personalization-editor";
import {
  PERSONALIZATION_SECTION,
  projectPersonalizationKey,
} from "../settings/personalization-settings";
import { SettingsLink } from "../settings/settings-link";

export const useProjectPersonalization = (projectId: string) =>
  useQuery({
    queryFn: ({ signal }) => fetchProjectPersonalization(projectId, signal),
    queryKey: projectPersonalizationKey(projectId),
  });

const Effective = ({ effective }: { effective: ResolvedPersonalization }) => {
  const features = Object.keys(effective.features);
  const mounts = effective.mounts ?? [];
  const rest = summary({ ...effective, features: {}, mounts: [] });
  return (
    <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">This project&apos;s containers get</p>
      {summary(effective) === "nothing" && (
        <p className={muted}>Nothing extra.</p>
      )}
      {(features.length > 0 || mounts.length > 0) && (
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {features.map((id) => (
            <li key={id} className="truncate" title={id}>
              {id}
            </li>
          ))}
          {mounts.map((m) => (
            <li
              key={m.target}
              className="truncate"
              title={`${m.source} → ${m.target}`}
            >
              {m.source} → {m.target}
            </li>
          ))}
        </ul>
      )}
      {rest !== "nothing" && <p className={muted}>{rest}</p>}
    </div>
  );
};

const RebuildNote = ({ projectId }: { projectId: string }) => {
  const client = useQueryClient();
  const rebuild = useMutation({
    mutationFn: () => postAction(projectId, "rebuild"),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: projectPersonalizationKey(projectId),
      }),
  });
  return (
    <Note warn>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          The project&apos;s container was created with other features, dotfiles
          or mounts. Rebuild it to apply the current ones.
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rebuild.isPending}
          onClick={async () => {
            const ok = await confirm({
              confirmLabel: "Rebuild",
              description:
                "The container is recreated; running agents in it stop. Task containers pick up the change when they are created or rebuilt.",
              title: "Rebuild the project's container?",
            });
            if (ok) {
              rebuild.mutate();
            }
          }}
        >
          <HammerIcon /> {rebuild.isPending ? "Rebuilding…" : "Rebuild"}
        </Button>
      </div>
      {rebuild.error && (
        <p className="text-destructive mt-1">{rebuild.error.message}</p>
      )}
    </Note>
  );
};

const ProjectPersonalizationForm = (props: {
  projectId: string;
  view: ProjectPersonalizationView;
}) => {
  const { view } = props;
  const client = useQueryClient();
  const [inherit, setInherit] = useState(view.personalization.inheritGlobal);
  const [draft, setDraft] = useState(() =>
    personalizationDraft(view.personalization)
  );
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: (p: Personalization) =>
      saveProjectPersonalization(props.projectId, {
        ...p,
        inheritGlobal: inherit,
      }),
    onSuccess: (next) => {
      client.setQueryData(projectPersonalizationKey(props.projectId), next);
      setDraft(personalizationDraft(next.personalization));
      setSaved(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = personalizationOf(draft);
    if ("error" in result) {
      setProblem(result.error);
      return;
    }
    setProblem(undefined);
    save.mutate(result.value);
  };
  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      {view.rebuildNeeded && <RebuildNote projectId={props.projectId} />}
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label htmlFor="personalization-inherit">
            Use your global personalization
          </Label>
          <p className={muted}>
            {summary(view.global) === "nothing" ? (
              <>Nothing is set up globally yet. </>
            ) : (
              <>Globally you add {summary(view.global)}. </>
            )}
            <SettingsLink
              section={PERSONALIZATION_SECTION}
              className="underline underline-offset-2"
            >
              Edit global settings
            </SettingsLink>
          </p>
        </div>
        <Switch
          id="personalization-inherit"
          checked={inherit}
          onCheckedChange={(checked) => {
            setInherit(checked);
            setSaved(false);
          }}
        />
      </div>
      <fieldset disabled={save.isPending} className="disabled:opacity-60">
        <PersonalizationFields
          id="personalization-project"
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setSaved(false);
          }}
        />
      </fieldset>
      <p className={muted}>
        This project&apos;s features win over global ones with the same id, its
        setup command runs after the global one, its dotfiles replace the global
        ones, and its mounts win over global ones with the same target.
      </p>
      <Effective effective={view.effective} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {saved && (
          <span role="status" className="text-muted-foreground text-sm">
            Saved.
          </span>
        )}
      </div>
      {(problem ?? save.error) && (
        <div role="alert">
          <Note error>{problem ?? save.error?.message}</Note>
        </div>
      )}
    </form>
  );
};

/** The project's own features, setup command and dotfiles, on top of (or instead of) the global ones. */
export const PersonalizationProjectSettings = ({
  projectId,
}: {
  projectId: string;
}) => {
  const query = useProjectPersonalization(projectId);
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="personalization-project-title"
    >
      <div className="flex flex-col">
        <h2 id="personalization-project-title" className="font-semibold">
          Personalization
        </h2>
        <p className={muted}>
          Your own tools in this project&apos;s containers, kept out of its
          repository.
        </p>
      </div>
      {query.error && <Note error>{query.error.message}</Note>}
      {!query.data && !query.error && <p className={muted}>Loading…</p>}
      {query.data && (
        <ProjectPersonalizationForm projectId={projectId} view={query.data} />
      )}
    </section>
  );
};
