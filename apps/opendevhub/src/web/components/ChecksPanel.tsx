import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { CheckResult, ChecksView } from "../../shared/types";
import { fetchCheckRun, fetchChecks, runChecks } from "../api";
import { checksState, type ChecksState, formatDuration, isRunning, needingApproval, STATE_LABEL, withRun } from "../checks";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MonitorIcon,
  PlayIcon,
  ShieldAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Chip } from "./Page";

const POLL_MS = 1000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A checkout's checks and latest run; polls while a run goes and reloads when it ends. */
export function useChecks(projectId: string, directory: string) {
  const [view, setView] = useState<ChecksView>();
  const [error, setError] = useState<string>();
  const load = useCallback(
    () =>
      fetchChecks(projectId, directory).then(
        (v) => {
          setView(v);
          setError(undefined);
        },
        (err: unknown) => setError(message(err)),
      ),
    [projectId, directory],
  );
  useEffect(() => void load(), [load]);

  const running = isRunning(view?.run);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      fetchCheckRun(projectId, directory)
        .then((run) => {
          setView((v) => (v ? withRun(v, run) : v));
          if (!isRunning(run)) void load();
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, projectId, directory, load]);

  const start = useCallback(
    (opts: { names?: string[]; approve?: string[] } = {}) =>
      runChecks(projectId, directory, opts).then(
        (run) => {
          setError(undefined);
          setView((v) => (v ? { ...withRun(v, run), current: true, checks: v.checks.map((c) => (opts.approve?.includes(c.command) ? { ...c, approved: true } : c)) } : v));
        },
        (err: unknown) => setError(message(err)),
      ),
    [projectId, directory],
  );

  return { view, error, load, start, state: checksState(view) };
}

const STATE_ICON: Record<ChecksState, ReactNode> = {
  none: null,
  idle: <CircleIcon className="text-muted-foreground" />,
  stale: <CircleDashedIcon className="text-warn" />,
  running: <LoaderCircleIcon className="animate-spin text-muted-foreground" />,
  passed: <CircleCheckIcon className="text-ok" />,
  failed: <CircleXIcon className="text-destructive" />,
};

export function ChecksIcon({ state }: { state: ChecksState }) {
  return <>{STATE_ICON[state]}</>;
}

function ResultIcon({ result }: { result?: CheckResult }) {
  const cls = "size-4 shrink-0";
  if (!result) return <CircleIcon className={cn(cls, "text-muted-foreground")} />;
  switch (result.status) {
    case "queued":
      return <CircleDashedIcon className={cn(cls, "text-muted-foreground")} />;
    case "running":
      return <LoaderCircleIcon className={cn(cls, "animate-spin text-muted-foreground")} />;
    case "passed":
      return <CircleCheckIcon className={cn(cls, "text-ok")} />;
    default:
      return <CircleXIcon className={cn(cls, "text-destructive")} />;
  }
}

function outcome(r: CheckResult | undefined): string {
  if (!r) return "not run";
  if (r.status === "queued") return "waiting";
  if (r.status === "running") return "running…";
  if (r.status === "error") return "couldn't run";
  const time = r.durationMs !== undefined ? formatDuration(r.durationMs) : "";
  if (r.status === "passed") return time;
  return r.timedOut ? `timed out · ${time}` : `exit ${r.exitCode} · ${time}`;
}

/** The checks of one checkout under the Review toolbar: run them, read their output, hand failures to the agent. */
export function ChecksPanel(props: {
  checks: ReturnType<typeof useChecks>;
  busy: boolean;
  onFix: (results: CheckResult[]) => void;
  onClose: () => void;
}) {
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
    if (failedKey && failedKey !== lastFailed.current) setOpen((o) => new Set([...o, ...failedKey.split("\0")]));
    lastFailed.current = failedKey;
  }, [failedKey]);

  if (!view) {
    return (
      <Card className="gap-2 px-4 py-3 text-sm text-muted-foreground">
        {error ?? (
          <span className="inline-flex items-center gap-2">
            <LoaderCircleIcon className="size-4 animate-spin" /> Loading checks…
          </span>
        )}
      </Card>
    );
  }

  const go = (names?: string[], approve?: string[]) => {
    const pending = needingApproval(view, names).filter((c) => !approve?.includes(c.command));
    if (pending.length > 0) {
      setApproval(names ? { names } : {});
      return;
    }
    setApproval(undefined);
    setStarting(true);
    void start({ ...(names ? { names } : {}), ...(approve?.length ? { approve } : {}) }).finally(() => setStarting(false));
  };
  const awaiting = approval ? needingApproval(view, approval.names) : [];
  const askApproval = awaiting.length > 0;
  const results = view.run?.results ?? [];
  const failed = results.filter((r) => r.status === "failed" || r.status === "error");

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <ListChecksIcon className="size-4 text-muted-foreground" />
        <h2 className="font-semibold">Checks</h2>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground [&_svg]:size-3.5">
          <ChecksIcon state={state} /> {STATE_LABEL[state]}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {failed.length > 0 && !running && (
            <Button variant="outline" size="sm" disabled={props.busy} onClick={() => props.onFix(failed)}>
              <WrenchIcon /> Ask agent to fix
            </Button>
          )}
          <Button size="sm" disabled={running || view.checks.length === 0} onClick={() => go()}>
            {running ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />} {running ? "Running…" : "Run all"}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close checks" onClick={props.onClose}>
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
            <p key={e} className="text-sm text-warn">
              {e}
            </p>
          ))}
        </div>
      )}

      {askApproval && (
        <div className="flex flex-col gap-2 border-b bg-warn/10 px-4 py-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-warn">
            <ShieldAlertIcon className="size-4" /> {awaiting.length === 1 ? "This command runs" : "These commands run"} on this machine, not in a container
          </p>
          <p className="text-muted-foreground">
            They come from the project's checks, which an agent can edit. Approve each exact command once; a changed command asks again.
          </p>
          {awaiting.map((c) => (
            <pre key={c.name} className="overflow-x-auto rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap">
              <span className="text-muted-foreground">{c.name}: </span>
              {c.command}
            </pre>
          ))}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => go(approval?.names, awaiting.map((c) => c.command))}>
              Approve and run
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setApproval(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {view.checks.length === 0 && view.errors.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted-foreground">No checks. Add them on the project page or in devcontainer.json.</p>
      )}
      <ul>
        {view.checks.map((c) => {
          const r = results.find((x) => x.name === c.name && x.command === c.command && x.where === c.where);
          const expanded = open.has(c.name);
          const hasOutput = !!r && (r.output.length > 0 || !!r.reason);
          return (
            <li key={c.name} className="border-t first:border-t-0">
              <div className="flex min-w-0 items-center gap-2 px-4 py-2 text-sm">
                <button
                  className="inline-flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                  disabled={!hasOutput}
                  aria-expanded={hasOutput ? expanded : undefined}
                  onClick={() =>
                    setOpen((o) => {
                      const next = new Set(o);
                      if (!next.delete(c.name)) next.add(c.name);
                      return next;
                    })
                  }
                >
                  {hasOutput ? (
                    expanded ? (
                      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  <ResultIcon result={r} />
                  <span className="font-medium">{c.name}</span>
                  {c.where === "host" && (
                    <Chip className="gap-1" title="Runs on this machine">
                      <MonitorIcon className="size-3" /> host
                    </Chip>
                  )}
                  <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={c.command}>
                    {c.command}
                  </code>
                </button>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{outcome(r)}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Run ${c.name}`}
                  title={`Run ${c.name}`}
                  disabled={running}
                  onClick={() => go([c.name])}
                >
                  <PlayIcon />
                </Button>
              </div>
              {expanded && hasOutput && (
                <pre className="max-h-80 overflow-auto border-t bg-muted/40 px-4 py-2 font-mono text-xs whitespace-pre-wrap">
                  {r?.reason ? `${r.reason}\n` : ""}
                  {r?.output.join("\n")}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
