import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@opendevhub/ui/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  LayersIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MonitorIcon,
  PlayIcon,
  ShieldAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { CheckDef, CheckResult, ChecksView } from "../../../shared/types";
import { runChecks } from "../../api";
import { Chip } from "../../components/page";
import {
  checkSections,
  checksState,
  formatDuration,
  groupState,
  needingApproval,
  resultOf,
  STATE_LABEL,
  withRun,
} from "./checks";
import type { ChecksState } from "./checks";
import { checksKey, checksQuery } from "./checks-queries";

/** A checkout's checks and latest run; polls while a run goes and reloads when it ends. */
export const useChecks = (projectId: string, directory: string) => {
  const queryClient = useQueryClient();
  const query = useQuery(checksQuery(queryClient, projectId, directory));
  const run = useMutation({
    mutationFn: (opts: { names?: string[]; approve?: string[] }) =>
      runChecks(projectId, directory, opts),
    onSuccess: (started, opts) =>
      queryClient.setQueryData<ChecksView>(
        checksKey(projectId, directory),
        (v) =>
          v && {
            ...withRun(v, started),
            checks: v.checks.map((c) =>
              opts.approve?.includes(c.command) ? { ...c, approved: true } : c
            ),
            current: true,
          }
      ),
  });
  const { refetch } = query;
  const load = useCallback(() => refetch(), [refetch]);
  const { mutateAsync } = run;
  const start = useCallback(
    async (opts: { names?: string[]; approve?: string[] } = {}) => {
      // The mutation holds the error for the panel to show.
      await mutateAsync(opts).catch(() => undefined);
    },
    [mutateAsync]
  );
  const view = query.data;
  return {
    error: (run.error ?? query.error)?.message,
    load,
    start,
    state: checksState(view),
    view,
  };
};

const STATE_ICON: Record<ChecksState, ReactNode> = {
  failed: <CircleXIcon className="text-destructive" />,
  idle: <CircleIcon className="text-muted-foreground" />,
  none: null,
  passed: <CircleCheckIcon className="text-ok" />,
  running: <LoaderCircleIcon className="text-muted-foreground animate-spin" />,
  stale: <CircleDashedIcon className="text-warn" />,
};

export const ChecksIcon = ({ state }: { state: ChecksState }) =>
  STATE_ICON[state];

/** Opens a checkout's checks from pages that do not have a Review toolbar. */
export const CheckoutChecks = ({
  projectId,
  directory,
}: {
  projectId: string;
  directory: string;
}) => {
  const checks = useChecks(projectId, directory);
  const [open, setOpen] = useState(false);
  const available =
    (checks.view?.checks.length ?? 0) > 0 ||
    (checks.view?.errors.length ?? 0) > 0 ||
    !!checks.error;

  if (!available) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Checks">
          <ChecksIcon state={checks.state} /> Checks
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[min(85vh,48rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Checks</DialogTitle>
        <ChecksPanel
          checks={checks}
          busy={false}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
};

const ResultIcon = ({ result }: { result?: CheckResult }) => {
  const cls = "size-4 shrink-0";
  if (!result) {
    return <CircleIcon className={cn(cls, "text-muted-foreground")} />;
  }
  switch (result.status) {
    case "queued": {
      return <CircleDashedIcon className={cn(cls, "text-muted-foreground")} />;
    }
    case "running": {
      return (
        <LoaderCircleIcon
          className={cn(cls, "text-muted-foreground animate-spin")}
        />
      );
    }
    case "passed": {
      return <CircleCheckIcon className={cn(cls, "text-ok")} />;
    }
    default: {
      return <CircleXIcon className={cn(cls, "text-destructive")} />;
    }
  }
};

const outcome = (r: CheckResult | undefined): string => {
  if (!r) {
    return "not run";
  }
  if (r.status === "queued") {
    return "waiting";
  }
  if (r.status === "running") {
    return "running…";
  }
  if (r.status === "error") {
    return "couldn't run";
  }
  const time = r.durationMs === undefined ? "" : formatDuration(r.durationMs);
  if (r.status === "passed") {
    return time;
  }
  return r.timedOut ? `timed out · ${time}` : `exit ${r.exitCode} · ${time}`;
};

/** The checks of one checkout under the Review toolbar: run them, read their output, hand failures to the agent. */
export const ChecksPanel = (props: {
  checks: ReturnType<typeof useChecks>;
  busy: boolean;
  onFix?: (results: CheckResult[]) => void;
  onClose: () => void;
}) => {
  const { view, error, start, state } = props.checks;
  /** The run waiting for host commands to be approved: all checks, or the named ones. */
  const [approval, setApproval] = useState<{ names?: string[] }>();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const running = state === "running" || starting;

  // Expand checks that failed when a run ends.
  const failedKey = (view?.run?.results ?? [])
    .filter((r) => r.status === "failed" || r.status === "error")
    .map((r) => r.name)
    .join("\0");
  const lastFailed = useRef("");
  useEffect(() => {
    if (failedKey && failedKey !== lastFailed.current) {
      setOpen((o) => new Set([...o, ...failedKey.split("\0")]));
    }
    lastFailed.current = failedKey;
  }, [failedKey]);

  if (!view) {
    return (
      <Card className="text-muted-foreground gap-2 px-4 py-3 text-sm">
        {error ?? (
          <span className="inline-flex items-center gap-2">
            <LoaderCircleIcon className="size-4 animate-spin" /> Loading checks…
          </span>
        )}
      </Card>
    );
  }

  const go = (names?: string[], approve?: string[]) => {
    const pending = needingApproval(view, names).filter(
      (c) => !approve?.includes(c.command)
    );
    if (pending.length > 0) {
      setApproval(names ? { names } : {});
      return;
    }
    setApproval(undefined);
    setStarting(true);
    void start({
      ...(names ? { names } : {}),
      ...(approve?.length ? { approve } : {}),
    }).finally(() => setStarting(false));
  };
  const awaiting = approval ? needingApproval(view, approval.names) : [];
  const askApproval = awaiting.length > 0;
  const results = view.run?.results ?? [];
  const failed = results.filter(
    (r) => r.status === "failed" || r.status === "error"
  );

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <ListChecksIcon className="text-muted-foreground size-4" />
        <h2 className="font-semibold">Checks</h2>
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm [&_svg]:size-3.5">
          <ChecksIcon state={state} /> {STATE_LABEL[state]}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {failed.length > 0 && !running && props.onFix && (
            <Button
              variant="outline"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onFix?.(failed)}
            >
              <WrenchIcon /> Ask agent to fix
            </Button>
          )}
          <Button
            size="sm"
            disabled={running || view.checks.length === 0}
            onClick={() => go()}
          >
            {running ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlayIcon />
            )}{" "}
            {running ? "Running…" : "Run all"}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close checks"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        </div>
      </div>

      {(error || view.errors.length > 0) && (
        <div className="flex flex-col gap-2 border-b px-4 py-2.5">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {view.errors.map((e) => (
            <p key={e} className="text-warn text-sm">
              {e}
            </p>
          ))}
        </div>
      )}

      {askApproval && (
        <div className="bg-warn/10 flex flex-col gap-2 border-b px-4 py-3 text-sm">
          <p className="text-warn flex items-center gap-1.5 font-medium">
            <ShieldAlertIcon className="size-4" />{" "}
            {awaiting.length === 1 ? "This command runs" : "These commands run"}{" "}
            on this machine, not in a container
          </p>
          <p className="text-muted-foreground">
            They come from the project&apos;s checks, which an agent can edit.
            Approve each exact command once; a changed command asks again.
          </p>
          {awaiting.map((c) => (
            <pre
              key={c.name}
              className="bg-background overflow-x-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap"
            >
              <span className="text-muted-foreground">{c.name}: </span>
              {c.command}
            </pre>
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                go(
                  approval?.names,
                  awaiting.map((c) => c.command)
                )
              }
            >
              Approve and run
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setApproval(undefined)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {view.checks.length === 0 && view.errors.length === 0 && (
        <p className="text-muted-foreground px-4 py-3 text-sm">
          No checks. Add them on the project page or in devcontainer.json.
        </p>
      )}
      {checkSections(view.checks).map((section) => {
        const rows = section.checks.map((c) => (
          <CheckRow
            key={c.name}
            check={c}
            result={resultOf(view.run, c)}
            expanded={open.has(c.name)}
            disabled={running}
            onToggle={() =>
              setOpen((o) => {
                const next = new Set(o);
                if (!next.delete(c.name)) {
                  next.add(c.name);
                }
                return next;
              })
            }
            onRun={() => go([c.name])}
          />
        ));
        if (!section.group) {
          return <ul key="">{rows}</ul>;
        }
        const names = section.checks.map((c) => c.name);
        const group = groupState(view.run, section.checks);
        return (
          <section
            key={section.group}
            aria-label={section.group}
            className="border-t first:border-t-0"
          >
            <GroupHeader
              name={section.group}
              total={section.checks.length}
              passed={group.passed}
              state={
                group.state !== "running" && !view.current && view.run
                  ? "stale"
                  : group.state
              }
              disabled={running}
              onRun={() => go(names)}
            />
            <ul>{rows}</ul>
          </section>
        );
      })}
    </Card>
  );
};

/** A group's heading: how it stands, and a button that runs all of its checks. */
const GroupHeader = (props: {
  name: string;
  state: ChecksState;
  passed: number;
  total: number;
  disabled: boolean;
  onRun: () => void;
}) => {
  const groupRunning = props.state === "running";
  let summary = `${props.total} ${props.total === 1 ? "check" : "checks"}`;
  if (groupRunning) {
    summary = `${props.passed} of ${props.total} passed so far`;
  } else if (props.state === "passed" || props.state === "failed") {
    summary = `${props.passed} of ${props.total} passed`;
  } else if (props.state === "stale") {
    summary = "ran on a different commit";
  }
  return (
    <div className="bg-muted/70 flex min-w-0 items-center gap-2 border-b px-4 py-1.5 text-sm">
      {/* Lines the group's icon up with its checks' result icons, past their expand arrows. */}
      <span className="w-6 shrink-0" />
      <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
        {props.state === "idle" ? (
          <LayersIcon className="text-muted-foreground" />
        ) : (
          <ChecksIcon state={props.state} />
        )}
      </span>
      <h3 className="truncate font-semibold">{props.name}</h3>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {summary}
      </span>
      <Button
        variant="outline"
        size="xs"
        className="bg-background ml-auto transition-transform duration-150 ease-out active:scale-[0.97]"
        aria-label={`Run group ${props.name}`}
        disabled={props.disabled}
        onClick={props.onRun}
      >
        {groupRunning ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : (
          <PlayIcon />
        )}
        {groupRunning ? "Running…" : "Run group"}
      </Button>
    </div>
  );
};

/** One check: its result, a toggle for its output, and a button that runs it alone. */
const CheckRow = (props: {
  check: CheckDef;
  result?: CheckResult;
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  onRun: () => void;
}) => {
  const { check: c, result: r, expanded } = props;
  const hasOutput = !!r && (r.output.length > 0 || !!r.reason);
  return (
    <li className="border-t first:border-t-0">
      <div className="flex min-w-0 items-center gap-2 px-4 py-2 text-sm">
        <Button
          type="button"
          variant="ghost"
          className="text-foreground h-auto min-w-0 flex-1 justify-start p-0 text-left hover:bg-transparent disabled:cursor-default disabled:opacity-100"
          disabled={!hasOutput}
          aria-expanded={hasOutput ? expanded : undefined}
          onClick={props.onToggle}
        >
          <ExpandIcon expanded={expanded} hasOutput={hasOutput} />
          <ResultIcon result={r} />
          <span className="font-medium">{c.name}</span>
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
        </Button>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {outcome(r)}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Run ${c.name}`}
          title={`Run ${c.name}`}
          disabled={props.disabled}
          onClick={props.onRun}
        >
          <PlayIcon />
        </Button>
      </div>
      {expanded && hasOutput && (
        <pre className="bg-muted/40 max-h-80 overflow-auto border-t px-4 py-2 font-mono text-xs whitespace-pre-wrap">
          {r?.reason ? `${r.reason}\n` : ""}
          {r?.output.join("\n")}
        </pre>
      )}
    </li>
  );
};

const ExpandIcon = ({
  hasOutput,
  expanded,
}: {
  hasOutput: boolean;
  expanded: boolean;
}) => {
  if (!hasOutput) {
    return <span className="size-3.5 shrink-0" />;
  }
  return expanded ? (
    <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
  ) : (
    <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
  );
};
