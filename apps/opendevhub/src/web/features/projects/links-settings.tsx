import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import { Input } from "@opendevhub/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opendevhub/ui/select";
import { Textarea } from "@opendevhub/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { JIRA_JQL_MAX, jiraQueryParams } from "../../../shared/jira";
import type { JiraTicketQuery } from "../../../shared/jira";
import type { ProjectLinks, SettingsScope } from "../../../shared/types";
import {
  fetchJiraCatalog,
  fetchProjectLinks,
  saveProjectLinks,
} from "../../api";
import { muted } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { useJiraQuery } from "../jira/use-jira";
import {
  ScopeToggle,
  TeamSavedNote,
  defaultScope,
  useProjectTeam,
  useRefreshProjectTeam,
} from "./team-scope";

const NO_BOARD = "none";
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

/** The project's open tickets: its board's when it has one, else every ticket, narrowed by its JQL. */
export const projectTicketsQuery = (
  links: Pick<ProjectLinks, "jiraBoard" | "jiraJql">
): Partial<JiraTicketQuery> => ({
  ...(links.jiraBoard
    ? { board: links.jiraBoard.id, scope: "board" }
    : { scope: "all" }),
  ...(links.jiraJql ? { jql: links.jiraJql } : {}),
  status: "open",
});

/** The Tickets page listing the project's open tickets. */
export const projectTicketsHref = (
  links: Pick<ProjectLinks, "jiraBoard" | "jiraJql">
): string => `/jira?${jiraQueryParams(projectTicketsQuery(links))}`;

/** The pull request inbox listing the repository's open pull requests. */
export const projectPullsHref = (repository: string): string =>
  `/forgejo?${new URLSearchParams({ inbox: "review", repository, state: "open" })}`;

export const projectLinksKey = (projectId: string) =>
  ["project-links", projectId] as const;

/** The Jira board and Forgejo repository the project is linked to; only asked for while either is enabled. */
export const useProjectLinks = (projectId: string | undefined) => {
  const { jira, forgejo } = useDash();
  return useQuery({
    enabled: !!projectId && (!!jira?.enabled || !!forgejo?.enabled),
    queryFn: ({ signal }) => fetchProjectLinks(projectId ?? "", signal),
    queryKey: projectLinksKey(projectId ?? ""),
  });
};

const useSaveLinks = (projectId: string) => {
  const queryClient = useQueryClient();
  const refreshTeam = useRefreshProjectTeam(projectId);
  return useMutation({
    mutationFn: ({
      links,
      scope,
    }: {
      links: ProjectLinks;
      scope: SettingsScope;
    }) => saveProjectLinks(projectId, links, scope),
    onSuccess: async (saved) => {
      queryClient.setQueryData(projectLinksKey(projectId), saved);
      await refreshTeam();
    },
  });
};

/** One link changed; the others keep what the layer being saved has. */
type LinkPatch = Partial<ProjectLinks>;

interface FieldProps {
  /** The links of the layer being edited. */
  links: ProjectLinks;
  saving: boolean;
  onSave: (patch: LinkPatch) => void;
  /** The team's value, while editing your own links that don't set this one. */
  inherited?: string;
}

/** Says which value applies while your own links leave it to the team. */
const Inherited = ({ value }: { value?: string }) =>
  value ? (
    <p className={muted}>
      Using the team&apos;s: <span className="font-mono">{value}</span>
    </p>
  ) : null;

const JiraBoardPicker = (props: FieldProps) => {
  const catalog = useJiraQuery(["catalog"], fetchJiraCatalog);
  const boards = [...(catalog.data?.boards ?? [])];
  const current = props.links.jiraBoard;
  // Keep the linked board selectable while the catalog loads or after it disappears from Jira.
  if (current && !boards.some((b) => b.id === current.id)) {
    boards.unshift({ ...current, type: "" });
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor="project-jira-board"
        className="flex items-center gap-2 text-sm font-medium"
      >
        Jira board
      </label>
      <Select
        value={current ? String(current.id) : NO_BOARD}
        disabled={props.saving}
        onValueChange={(value) => {
          const board = boards.find((b) => String(b.id) === value);
          props.onSave({
            jiraBoard: board ? { id: board.id, name: board.name } : undefined,
          });
        }}
      >
        <SelectTrigger id="project-jira-board" className="w-full max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={NO_BOARD}>Not linked</SelectItem>
          {boards.map((b) => (
            <SelectItem key={b.id} value={String(b.id)}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Inherited value={props.inherited} />
      {catalog.error && (
        <p className="text-destructive text-sm">{catalog.error.message}</p>
      )}
    </div>
  );
};

const JiraJqlInput = (props: FieldProps) => {
  const saved = props.links.jiraJql ?? "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const value = draft.trim();
  const changed = value !== saved;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed) {
      props.onSave({ jiraJql: value || undefined });
    }
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit}>
      <label
        htmlFor="project-jira-jql"
        className="flex items-center gap-2 text-sm font-medium"
      >
        Jira JQL
      </label>
      <Textarea
        id="project-jira-jql"
        className="max-w-xl font-mono text-sm"
        rows={2}
        maxLength={JIRA_JQL_MAX}
        placeholder='project = APP AND component = "Web"'
        value={draft}
        disabled={props.saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            submit(e);
          }
        }}
        spellCheck={false}
      />
      <Inherited value={props.inherited} />
      <p className={muted}>
        {props.links.jiraBoard
          ? "Narrows the board's tickets."
          : "Picks the project's tickets from all of Jira."}{" "}
        Passed to Jira as written; an ORDER BY sets the order.
      </p>
      {changed && (
        <Button
          type="submit"
          size="sm"
          className="w-fit"
          disabled={props.saving}
        >
          {value ? "Save JQL" : "Remove JQL"}
        </Button>
      )}
    </form>
  );
};

const ForgejoRepositoryInput = (props: FieldProps) => {
  const saved = props.links.forgejoRepository ?? "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const value = draft.trim();
  const invalid = value !== "" && !REPOSITORY.test(value);
  const changed = value !== saved;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed && !invalid) {
      props.onSave({ forgejoRepository: value || undefined });
    }
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={submit}>
      <label
        htmlFor="project-forgejo-repo"
        className="flex items-center gap-2 text-sm font-medium"
      >
        Forgejo repository
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="project-forgejo-repo"
          className="max-w-sm font-mono"
          placeholder="owner/name"
          value={draft}
          disabled={props.saving}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {changed && (
          <Button type="submit" size="sm" disabled={props.saving || invalid}>
            {value ? "Link" : "Unlink"}
          </Button>
        )}
      </div>
      <Inherited value={props.inherited} />
      {invalid && (
        <p className="text-destructive text-sm">
          Enter the repository as owner/name.
        </p>
      )}
    </form>
  );
};

const hasLinks = (links: ProjectLinks | undefined): boolean =>
  Object.keys(links ?? {}).length > 0;

/** Links the project to a Jira board or JQL and a Forgejo repository, so the sidebar lists their tickets and pull requests. */
export const LinksSettings = ({ projectId }: { projectId: string }) => {
  const { jira, forgejo } = useDash();
  const query = useProjectLinks(projectId);
  const save = useSaveLinks(projectId);
  const { data: team } = useProjectTeam(projectId);
  const [chosenScope, setScope] = useState<SettingsScope>();
  if (!jira?.enabled && !forgejo?.enabled) {
    return null;
  }
  const scope =
    chosenScope ??
    defaultScope(hasLinks(team?.team.links), hasLinks(team?.personal.links));
  const merged = query.data;
  // Each layer shows its own links; without the layers loaded, the merged ones are the best there is.
  const links = team ? team[scope].links : merged;
  const error = (save.error ?? query.error)?.message;
  const inherited = (key: keyof ProjectLinks): string | undefined => {
    if (scope !== "personal" || team?.personal.links[key] !== undefined) {
      return undefined;
    }
    const value = team?.team.links[key];
    return typeof value === "object" ? value.name : value;
  };
  const onSave = (patch: LinkPatch) =>
    save.mutate({ links: { ...links, ...patch }, scope });
  const field = (key: keyof ProjectLinks): FieldProps => ({
    inherited: inherited(key),
    links: links ?? {},
    onSave,
    saving: save.isPending,
  });
  const canShare =
    scope === "personal" && hasLinks(team?.personal.links) && team?.writable;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="font-semibold">Tickets and pull requests</h2>
          <p className={muted}>
            The sidebar lists the open tickets and pull requests of what this
            project is linked to.
          </p>
        </div>
        <ScopeToggle
          value={scope}
          onChange={setScope}
          team={team}
          disabled={save.isPending}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <p className={muted}>
        {scope === "team"
          ? `Editing the team's links in ${team?.file ?? "devcontainer.json"}.`
          : "Editing your own links. They replace the team's, link by link."}
      </p>
      {!links && !error && <p className={muted}>Loading…</p>}
      {links && (
        <div className="flex flex-col gap-4">
          {jira?.enabled && (
            <>
              <JiraBoardPicker {...field("jiraBoard")} />
              <JiraJqlInput {...field("jiraJql")} />
            </>
          )}
          {forgejo?.enabled && (
            <ForgejoRepositoryInput {...field("forgejoRepository")} />
          )}
        </div>
      )}
      {canShare && team && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={save.isPending}
          title="Save your links to devcontainer.json and drop your own copy"
          onClick={() =>
            save.mutate({
              links: { ...team.team.links, ...team.personal.links },
              scope: "team",
            })
          }
        >
          Share mine with the team
        </Button>
      )}
      {save.isSuccess && save.variables.scope === "team" && (
        <TeamSavedNote team={team} />
      )}
    </section>
  );
};
