import { Button } from "@opendevhub/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";

import type { Personalization } from "../../../shared/personalization";
import { fetchPersonalization, savePersonalization } from "../../api";
import { Note } from "../../components/page";
import {
  personalizationDraft,
  personalizationOf,
} from "./personalization-draft";
import { PersonalizationFields } from "./personalization-editor";
import { SettingsBlock, SettingsHeader } from "./settings-layout";

export const PERSONALIZATION_SECTION = "personalization";

export const personalizationKey = ["personalization"] as const;
export const projectPersonalizationKey = (projectId: string) =>
  ["project-personalization", projectId] as const;

export const usePersonalization = () =>
  useQuery({
    queryFn: ({ signal }) => fetchPersonalization(signal),
    queryKey: personalizationKey,
  });

const PersonalizationForm = (props: { personalization: Personalization }) => {
  const client = useQueryClient();
  const [draft, setDraft] = useState(() =>
    personalizationDraft(props.personalization)
  );
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: savePersonalization,
    onSuccess: async (next) => {
      client.setQueryData(personalizationKey, next);
      setDraft(personalizationDraft(next.personalization));
      setSaved(true);
      // Every project's effective settings and rebuild hint depend on these.
      await client.invalidateQueries({
        queryKey: ["project-personalization"],
      });
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
    <form className="flex flex-col gap-8" onSubmit={submit}>
      <SettingsBlock
        title="Every project"
        hint="Added to each project's containers on top of its devcontainer.json. Kept in opendevhub's config.json on this machine, never in the repository. A project can add its own or turn these off in its settings."
      >
        <fieldset disabled={save.isPending} className="disabled:opacity-60">
          <PersonalizationFields
            id="personalization-global"
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setSaved(false);
            }}
          />
        </fieldset>
      </SettingsBlock>
      <Note>
        Features and dotfiles go into new containers: rebuild a project (or
        create a new task container) to apply them. A changed setup command runs
        on the next start.
      </Note>
      <div className="flex flex-wrap items-center gap-3 border-t pt-6">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {(problem ?? save.error) && (
        <div role="alert">
          <Note error>{problem ?? save.error?.message}</Note>
        </div>
      )}
      {saved && (
        <p role="status" className="text-muted-foreground text-sm">
          Settings saved.
        </p>
      )}
    </form>
  );
};

/** The settings section: the features, setup command and dotfiles every project's containers get. */
export const PersonalizationSettingsSection = () => {
  const query = usePersonalization();
  return (
    <>
      <SettingsHeader
        title="Personalization"
        description="Your own tools in every dev container — git-town, a shell, your dotfiles — without committing them to a team's .devcontainer."
      />
      {query.error && <Note error>{query.error.message}</Note>}
      {!query.data && !query.error && (
        <p role="status" className="text-muted-foreground text-sm">
          Loading settings…
        </p>
      )}
      {query.data && (
        <PersonalizationForm personalization={query.data.personalization} />
      )}
    </>
  );
};
