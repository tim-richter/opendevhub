import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import { Input } from "@opendevhub/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, TriangleAlertIcon, UsersIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import type { SettingsScope } from "../../../shared/types";
import {
  fetchProjectHostPorts,
  fetchProjectPorts,
  saveProjectHostPorts,
  saveProjectPorts,
} from "../../api";
import { Chip, muted } from "../../components/page";
import { Tip } from "../../components/tip";
import { cn } from "../../lib/utils";
import {
  ScopeToggle,
  TeamSavedNote,
  defaultScope,
  projectTeamQuery,
  useRefreshProjectTeam,
} from "./team-scope";

const MAX_PORT = 65_535;

const parsePort = (text: string): number | undefined => {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_PORT ? n : undefined;
};

interface PortListProps {
  projectId: string;
  /** Tells the two lists apart in the query cache and in element ids. */
  kind: "ports" | "host-ports";
  title: ReactNode;
  description: ReactNode;
  placeholder: string;
  inputLabel: string;
  removeLabel: (port: number) => string;
  fetch: (
    projectId: string,
    signal?: AbortSignal
  ) => Promise<{ ports: number[] }>;
  save: (
    projectId: string,
    ports: number[],
    scope?: SettingsScope
  ) => Promise<{ ports: number[] }>;
  /** devcontainer.json has a list of its own, shown alongside and editable for the team. */
  shared?: boolean;
}

/** One port; it can be removed only while its layer is being edited. */
const PortChip = (props: {
  port: number;
  team?: boolean;
  removeLabel?: string;
  disabled: boolean;
  onRemove: () => void;
}) => {
  const { port, team, removeLabel, disabled, onRemove } = props;
  return (
    <Chip
      className={cn("gap-1 font-mono", !removeLabel && "opacity-60")}
      title={
        team
          ? "Forwarded for the team by devcontainer.json"
          : "Forwarded for you"
      }
    >
      {team && <UsersIcon className="size-3" />}
      {port}
      {removeLabel && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={removeLabel}
          className="text-muted-foreground hover:text-foreground size-4 hover:bg-transparent"
          disabled={disabled}
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </Button>
      )}
    </Chip>
  );
};

/** A project's list of ports, edited as chips; every change is saved right away. */
const PortList = ({
  projectId,
  kind,
  title,
  description,
  placeholder,
  inputLabel,
  removeLabel,
  fetch,
  save,
  shared,
}: PortListProps) => {
  const queryClient = useQueryClient();
  const queryKey = ["project-ports", kind, projectId] as const;
  const query = useQuery({
    queryFn: ({ signal }) => fetch(projectId, signal),
    queryKey,
  });
  const teamQuery = useQuery({
    ...projectTeamQuery(projectId),
    enabled: !!shared,
  });
  const team = shared ? teamQuery.data : undefined;
  const refreshTeam = useRefreshProjectTeam(projectId);
  const teamPorts = team?.team.forwardPorts ?? [];
  const [chosenScope, setScope] = useState<SettingsScope>();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const saveMutation = useMutation({
    mutationFn: ({ list, scope }: { list: number[]; scope: SettingsScope }) =>
      save(projectId, list, scope),
    onSuccess: async (saved) => {
      queryClient.setQueryData(queryKey, saved);
      if (shared) {
        await refreshTeam();
      }
    },
  });
  const ports = query.data?.ports;
  const scope: SettingsScope = shared
    ? (chosenScope ??
      defaultScope(teamPorts.length > 0, (ports ?? []).length > 0))
    : "personal";
  const saving = saveMutation.isPending;
  const error = (saveMutation.error ?? query.error)?.message;
  const inputId = `${kind}-${projectId}`;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const port = parsePort(draft);
    if (port === undefined || !ports) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft("");
    if (scope === "team") {
      if (!teamPorts.includes(port)) {
        saveMutation.mutate({ list: [...teamPorts, port], scope });
      }
    } else if (!ports.includes(port) && !teamPorts.includes(port)) {
      saveMutation.mutate({ list: [...ports, port], scope });
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="flex items-center gap-2 font-semibold">{title}</h2>
          <p className={muted}>{description}</p>
        </div>
        {shared && (
          <ScopeToggle
            value={scope}
            onChange={setScope}
            team={team}
            disabled={saving}
          />
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!ports && !error && <p className={muted}>Loading…</p>}
      {ports && (
        <div className="flex flex-wrap items-center gap-2">
          {teamPorts.map((port) => (
            <PortChip
              key={`team-${port}`}
              port={port}
              team
              // Each layer is edited on its own; the other's ports show for context.
              removeLabel={
                scope === "team" && team?.writable
                  ? `Stop forwarding ${port} for the team`
                  : undefined
              }
              disabled={saving}
              onRemove={() =>
                saveMutation.mutate({
                  list: teamPorts.filter((p) => p !== port),
                  scope: "team",
                })
              }
            />
          ))}
          {ports.map((port) => (
            <PortChip
              key={port}
              port={port}
              removeLabel={scope === "personal" ? removeLabel(port) : undefined}
              disabled={saving}
              onRemove={() =>
                saveMutation.mutate({
                  list: ports.filter((p) => p !== port),
                  scope: "personal",
                })
              }
            />
          ))}
          <form className="flex items-center gap-2" onSubmit={add}>
            <label htmlFor={inputId} className="sr-only">
              {inputLabel}
            </label>
            <Input
              id={inputId}
              className="h-8 w-28 font-mono"
              inputMode="numeric"
              placeholder={placeholder}
              value={draft}
              disabled={saving}
              aria-invalid={invalid}
              onChange={(e) => {
                setDraft(e.target.value);
                setInvalid(false);
              }}
              autoComplete="off"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={saving || draft.trim() === ""}
            >
              <PlusIcon />{" "}
              {shared && scope === "team" ? "Add for the team" : "Add"}
            </Button>
          </form>
        </div>
      )}
      {shared && (
        <p className={muted}>
          {scope === "team"
            ? `Editing the team's ports in ${team?.file ?? "devcontainer.json"}; your own are shown faded.`
            : "Editing your own ports, forwarded on top of the team's."}
        </p>
      )}
      {shared &&
        scope === "personal" &&
        ports &&
        ports.length > 0 &&
        team?.writable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={saving}
            title="Add your ports to devcontainer.json's forwardPorts and drop your own copy"
            onClick={() =>
              saveMutation.mutate({
                list: [...teamPorts, ...ports],
                scope: "team",
              })
            }
          >
            Share mine with the team
          </Button>
        )}
      {invalid && (
        <p className="text-destructive text-sm">
          A port is a whole number from 1 to {MAX_PORT}.
        </p>
      )}
      {saveMutation.isSuccess && saveMutation.variables.scope === "team" && (
        <TeamSavedNote team={team} />
      )}
    </section>
  );
};

/** Ports the project forwards to localhost: devcontainer.json's `forwardPorts` for the team, and the user's own. */
export const PortsSettings = ({ projectId }: { projectId: string }) => (
  <PortList
    projectId={projectId}
    kind="ports"
    shared
    title="Forwarded ports"
    description={
      <>
        Forwarded to <code className="font-mono">localhost</code> for every
        environment of this project. Team ports are the{" "}
        <code className="font-mono">forwardPorts</code> in devcontainer.json.
        Running containers pick them up right away.
      </>
    }
    placeholder="3000"
    inputLabel="Port to forward"
    removeLabel={(port) => `Stop forwarding ${port}`}
    fetch={fetchProjectPorts}
    save={saveProjectPorts}
  />
);

/** Ports on this machine the project's containers reach at the same `localhost` port. */
export const HostPortsSettings = ({ projectId }: { projectId: string }) => (
  <PortList
    projectId={projectId}
    kind="host-ports"
    title={
      <>
        Host ports
        <Tip
          label={
            <div className="flex max-w-sm flex-col gap-2">
              <p className="font-semibold">
                Containers get full access to these ports
              </p>
              <p>
                Every process in the project&apos;s containers, including agents
                and dependencies, can use whatever listens on a host port. A
                Chrome debugging port gives full control of that browser, its
                cookies and logins.
              </p>
              <p>
                For Chrome, start a separate instance with its own profile, e.g.{" "}
                <code className="font-mono break-all">
                  --remote-debugging-port=9222
                  --user-data-dir=~/.opendevhub-chrome
                </code>
                , never your everyday profile.
              </p>
            </div>
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Host ports container access warning"
            className="text-warn hover:text-warn size-4 rounded-sm hover:bg-transparent"
          >
            <TriangleAlertIcon className="size-4" />
          </Button>
        </Tip>
      </>
    }
    description={
      <>
        Reachable inside every environment of this project at{" "}
        <code className="font-mono">localhost</code> on the same port, and
        answered by <code className="font-mono">localhost</code> on this
        machine. Running containers pick them up right away.
      </>
    }
    placeholder="9222"
    inputLabel="Host port to reach from containers"
    removeLabel={(port) => `Stop reaching host port ${port}`}
    fetch={fetchProjectHostPorts}
    save={saveProjectHostPorts}
  />
);
