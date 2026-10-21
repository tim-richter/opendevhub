import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@opendevhub/ui/dropdown-menu";
import { useQueries } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { confirm } from "@/components/confirm-dialog";

import type { EnvLogs, EnvLogSource, ProjectView } from "../../../shared/types";
import { envAction, fetchEnvLogs, postAction, removeEnv } from "../../api";
import type { Action } from "../../api";
import { Chip, Note, Segmented } from "../../components/page";
import { StatusDot } from "../../components/status";
import { envOfDirectory } from "../../derive";
import type { Tone } from "../../derive";
import { ApiError } from "../../rpc";
import { useCheckoutContext } from "./checkout-context";
import { checkouts, checkoutRuntime } from "./checkouts";
import { LogPanel } from "./log-panel";

const BUSY = "Another action is running";

const CONTAINER_TONE: Record<string, Tone> = {
  error: "error",
  running: "ok",
  starting: "running",
  stopped: "off",
  stopping: "running",
};

const OPENCODE_TONE: Record<string, Tone> = {
  absent: "off",
  healthy: "ok",
  starting: "running",
  unhealthy: "error",
};

/** The checkouts a shared container serves: those without a container of their own. */
const sharedCheckouts = (view: ProjectView): string[] =>
  checkouts(view)
    .filter((c) => !envOfDirectory(view, c.directory))
    .map((c) => c.label);

/** The environment a checkout runs in: its own container, or the project's shared one (addressed by the project's id). */
export const useEnvironment = () => {
  const { view, checkout } = useCheckoutContext();
  const own = envOfDirectory(view, checkout.directory);
  return {
    checkout,
    envId: own?.id ?? view.project.id,
    node: own?.node ?? checkout.worktree?.node,
    own,
    runtime: checkoutRuntime(view, checkout.directory),
    view,
  };
};

/** The container a checkout runs in, and its lifecycle actions. */
export const RuntimeControls = () => {
  const { view, own, runtime, node, envId } = useEnvironment();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const state = runtime.containerState;
  const settling =
    state === "starting" ||
    state === "stopping" ||
    runtime.opencode === "starting";
  const busy = pending || settling;
  const running = state === "running";
  const stopped = state === "stopped" || !runtime.containerId;
  const others = own ? [] : sharedCheckouts(view);
  const affects = own
    ? ""
    : ` It is the project's shared container, so it affects every checkout and conversation using it${
        others.length > 0 ? `: ${others.join(", ")}` : ""
      }.`;

  const run = async (action: Action | "remove") => {
    setPending(true);
    setError(undefined);
    try {
      if (action === "remove") {
        await removeEnv(view.project.id, envId);
      } else if (own) {
        await envAction(view.project.id, envId, action);
      } else {
        await postAction(view.project.id, action);
      }
    } catch (error_) {
      setError(
        error_ instanceof ApiError && error_.status === 409
          ? `${BUSY}; try again once it finishes.`
          : String((error_ as Error).message ?? error_)
      );
    } finally {
      setPending(false);
    }
  };

  const confirmed = async (
    action: Action | "remove",
    prompt: {
      title: string;
      description: string;
      confirmLabel: string;
      destructive?: boolean;
    }
  ) => {
    if (await confirm(prompt)) {
      await run(action);
    }
  };

  const why = busy ? BUSY : undefined;
  return (
    <Card className="gap-3 px-4 py-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Container</h2>
        <Chip>{own ? "Own container" : "Shared container"}</Chip>
        <Chip>{node ? `On ${node}` : "Local"}</Chip>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Name</dt>
        <dd className="truncate font-mono text-xs leading-5">
          {runtime.containerName ?? "—"}
        </dd>
        <dt className="text-muted-foreground">State</dt>
        <dd className="flex items-center gap-1.5">
          <StatusDot tone={CONTAINER_TONE[state] ?? "off"} />
          {state}
        </dd>
        <dt className="text-muted-foreground">opencode</dt>
        <dd className="flex items-center gap-1.5">
          <StatusDot tone={OPENCODE_TONE[runtime.opencode] ?? "off"} />
          {runtime.opencode}
          {runtime.opencodeVersion && (
            <span className="text-muted-foreground">
              · {runtime.opencodeVersion}
            </span>
          )}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !running}
          title={why ?? (running ? undefined : "The container isn't running")}
          onClick={() => void run("restart-opencode")}
        >
          Restart opencode
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={busy} title={why}>
              Rebuild <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() =>
                void confirmed("rebuild", {
                  confirmLabel: "Rebuild",
                  description: `Running conversations will be interrupted.${affects}`,
                  title: "Rebuild the container?",
                })
              }
            >
              Rebuild
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void confirmed("rebuild-no-cache", {
                  confirmLabel: "Rebuild",
                  description: `Every image layer is built again, which can take a while. Running conversations will be interrupted.${affects}`,
                  title: "Rebuild the container without cache?",
                })
              }
            >
              Rebuild without cache
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {stopped ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            title={why}
            onClick={() => void run("start")}
          >
            Start
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            title={why}
            onClick={() =>
              void confirmed("stop", {
                confirmLabel: "Stop",
                description: own
                  ? "Its conversations stop until it is started again."
                  : `Every checkout in the project's container stops, with its conversations${
                      others.length > 0 ? `: ${others.join(", ")}` : ""
                    }.`,
                destructive: true,
                title: "Stop the container?",
              })
            }
          >
            Stop
          </Button>
        )}
        {own && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            disabled={busy}
            title={why}
            onClick={() =>
              void confirmed("remove", {
                confirmLabel: "Remove",
                description:
                  "The container and its conversations are deleted; the worktree and its branch stay.",
                destructive: true,
                title: "Remove the container?",
              })
            }
          >
            Remove container
          </Button>
        )}
      </div>
      {busy && <p className="text-muted-foreground text-xs">{BUSY}…</p>}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </Card>
  );
};

type LogFilter = "all" | EnvLogSource;

const SOURCES: EnvLogSource[] = ["setup", "container", "opencode"];

const SOURCE_LABEL: Record<LogFilter, string> = {
  all: "All",
  container: "Container",
  opencode: "opencode",
  setup: "Setup",
};

const LOG_POLL_MS = 3000;

/**
 * All sources interleaved by time where times are known; lines without one follow, each source in turn. Each line
 * names its source.
 */
export const mergeLogs = (
  logs: Partial<Record<EnvLogSource, EnvLogs>>
): string[] => {
  const timed: { at: number; text: string }[] = [];
  const untimed: string[] = [];
  for (const source of SOURCES) {
    for (const line of logs[source]?.lines ?? []) {
      const text = `[${SOURCE_LABEL[source]}] ${line.text}`;
      if (line.at === undefined) {
        untimed.push(text);
      } else {
        timed.push({ at: line.at, text });
      }
    }
  }
  return [
    ...timed.toSorted((a, b) => a.at - b.at).map((l) => l.text),
    ...untimed,
  ];
};

/** The environment's log, by source; refreshed every few seconds while the tab is open. */
export const RuntimeLogs = () => {
  const { view, envId, own } = useEnvironment();
  const [filter, setFilter] = useState<LogFilter>("all");
  const sources = filter === "all" ? SOURCES : [filter];
  const results = useQueries({
    queries: sources.map((source) => ({
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchEnvLogs(view.project.id, envId, source, 500, signal),
      queryKey: ["env-logs", view.project.id, envId, source],
      refetchInterval: LOG_POLL_MS,
      staleTime: 0,
    })),
  });
  const logs: Partial<Record<EnvLogSource, EnvLogs>> = {};
  const notes: string[] = [];
  for (const [i, source] of sources.entries()) {
    const { data, error } = results[i];
    if (data) {
      logs[source] = data;
    }
    const why = data?.unavailable ?? error?.message;
    if (why) {
      notes.push(`${SOURCE_LABEL[source]}: ${why}`);
    }
  }
  const lines =
    filter === "all"
      ? mergeLogs(logs)
      : (logs[filter]?.lines.map((l) => l.text) ?? []);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Segmented
        label="Log source"
        value={filter}
        options={(["all", ...SOURCES] as const).map((id) => ({
          id,
          label: SOURCE_LABEL[id],
        }))}
        onChange={setFilter}
      />
      {notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
      <LogPanel
        lines={lines}
        hint={
          own
            ? `${lines.length} lines from this worktree's own container`
            : `${lines.length} lines from the project's shared container`
        }
      />
    </div>
  );
};
