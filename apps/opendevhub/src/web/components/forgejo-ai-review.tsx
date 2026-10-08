import {
  CircleCheckIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type {
  AiSeverity,
  ForgejoComment,
  ForgejoPullDetails,
} from "../../shared/forgejo";
import type { ProjectView, SessionSummary } from "../../shared/types";
import {
  collectAiReview,
  createForgejoWorktree,
  startAiReviewSession,
} from "../api";
import {
  checkoutOf,
  checkoutPath,
  checkoutRuntime,
  checkouts,
  sessionPath,
} from "../checkouts";
import { useDash } from "../dashboard-context";
import { readAiRun, saveAiRun } from "../forgejo";
import type { AiReviewRun, AiSuggestion } from "../forgejo";
import { useForgejoCheckouts } from "../hooks/use-forgejo-checkouts";
import { linesLabel, newId } from "../review";
import { Choice } from "./choice";
import { RequestState } from "./forgejo-context";
import { MarkdownBody } from "./markdown-body";
import { Chip, Note } from "./page";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** A session that never shows as busy is taken as done after this long. */
const IDLE_GRACE_MS = 20_000;
/** A review session missing from the snapshot for this long was deleted. */
const GONE_MS = 30_000;
/** How often a running review re-checks the grace periods above. */
const TICK_MS = 5000;

export interface AiReview {
  run?: AiReviewRun;
  view?: ProjectView;
  session?: SessionSummary;
  /** Where to follow the review session, once there is one. */
  sessionLink?: string;
  start: (
    kind: AiReviewRun["kind"],
    projectId: string,
    directory: string
  ) => void;
  /** Asks for findings without waiting for the session to go idle. */
  collectNow: () => void;
  retry: () => void;
  clear: () => void;
  /** Marks a suggestion accepted or dismissed, so it leaves the diff. */
  handle: (id: string) => void;
}

/**
 * An AI review of the pull request's head commit. An agent review waits for its checkout's opencode, runs a
 * review session there and collects the findings once the session goes idle; a quick review collects findings
 * from the diff straight away. The run is remembered per pull request, so a reload carries on.
 */
export const useAiReview = (details: ForgejoPullDetails): AiReview => {
  const { snapshot } = useDash();
  const { pull, headSha } = details;
  const [run, setRunState] = useState(() => readAiRun(pull, headSha));
  const runRef = useRef(run);
  const setRun = useCallback(
    (next: AiReviewRun | undefined) => {
      runRef.current = next;
      setRunState(next);
      saveAiRun(pull, next);
    },
    [pull]
  );
  /** Applies a change to the run that `id` names, unless another run replaced it meanwhile. */
  const patch = useCallback(
    (id: string, change: Partial<AiReviewRun>) => {
      const { current } = runRef;
      if (current?.id === id) {
        setRun({ ...current, ...change });
      }
    },
    [setRun]
  );
  const busy = useRef(false);
  const sawBusy = useRef(false);
  const [tick, setTick] = useState(0);

  const view = snapshot?.projects.find((p) => p.project.id === run?.projectId);
  const checkout = view && run ? checkoutOf(view, run.directory) : undefined;
  const runtime =
    view && checkout && run ? checkoutRuntime(view, run.directory) : undefined;
  const ready =
    runtime?.containerState === "running" && runtime.opencode === "healthy";
  const session = run?.sessionId
    ? view?.sessions.find((s) => s.id === run.sessionId)
    : undefined;

  const collect = useCallback(
    async (current: AiReviewRun) => {
      if (busy.current) {
        return;
      }
      busy.current = true;
      patch(current.id, { error: undefined, stage: "collecting" });
      try {
        const result = await collectAiReview(
          pull.owner,
          pull.repo,
          String(pull.number),
          {
            commitId: headSha,
            directory: current.directory,
            projectId: current.projectId,
            ...(current.sessionId ? { sessionId: current.sessionId } : {}),
          }
        );
        patch(current.id, {
          findings: result.findings,
          handled: [],
          sessionId: result.sessionId,
          stage: "done",
          summary: result.summary,
        });
      } catch (error) {
        patch(current.id, { error: message(error), stage: "failed" });
      } finally {
        busy.current = false;
      }
    },
    [patch, headSha, pull]
  );

  // Waiting: start the review session once the checkout can run it.
  useEffect(() => {
    const { current } = runRef;
    if (current?.stage !== "waiting" || !ready || busy.current) {
      return;
    }
    busy.current = true;
    void (async () => {
      try {
        const sessionId = await startAiReviewSession(
          pull.owner,
          pull.repo,
          String(pull.number),
          {
            commitId: headSha,
            directory: current.directory,
            projectId: current.projectId,
          }
        );
        sawBusy.current = false;
        patch(current.id, {
          sessionId,
          stage: "reviewing",
          startedAt: Date.now(),
        });
      } catch (error) {
        patch(current.id, { error: message(error), stage: "failed" });
      } finally {
        busy.current = false;
      }
    })();
  }, [run?.stage, ready, patch, headSha, pull]);

  // Reviewing: collect once the session has worked and gone idle again.
  useEffect(() => {
    const { current } = runRef;
    if (current?.stage !== "reviewing") {
      return;
    }
    const waited = Date.now() - current.startedAt;
    if (!session) {
      if (view && waited > GONE_MS) {
        patch(current.id, {
          error: "The review session is gone.",
          stage: "failed",
        });
      }
      return;
    }
    if (session.status !== "idle") {
      sawBusy.current = true;
      return;
    }
    if (sawBusy.current || waited > IDLE_GRACE_MS) {
      void collect(current);
    }
  }, [run?.stage, session, view, tick, collect, patch]);

  useEffect(() => {
    if (run?.stage !== "reviewing") {
      return;
    }
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [run?.stage]);

  // Collecting after a reload: the request that was in flight is lost, so ask again.
  useEffect(() => {
    const { current } = runRef;
    if (current?.stage === "collecting" && !busy.current) {
      void collect(current);
    }
  }, [run?.stage, collect]);

  let sessionLink: string | undefined;
  if (view && session) {
    sessionLink = sessionPath(view, session);
  } else if (view && checkout && run?.sessionId) {
    sessionLink = `${checkoutPath(view.project.id, checkout.target)}?session=${encodeURIComponent(run.sessionId)}`;
  }

  return {
    clear: () => setRun(undefined),
    collectNow: () => {
      const { current } = runRef;
      if (current?.sessionId) {
        void collect(current);
      }
    },
    handle: (id) => {
      const { current } = runRef;
      if (current) {
        setRun({ ...current, handled: [...(current.handled ?? []), id] });
      }
    },
    retry: () => {
      const { current } = runRef;
      if (!current) {
        return;
      }
      if (current.kind === "quick") {
        setRun({ ...current, error: undefined, stage: "collecting" });
      } else if (current.sessionId) {
        sawBusy.current = false;
        setRun({
          ...current,
          error: undefined,
          stage: "reviewing",
          startedAt: 0,
        });
      } else {
        setRun({ ...current, error: undefined, stage: "waiting" });
      }
    },
    run,
    session,
    sessionLink,
    start: (kind, projectId, directory) => {
      sawBusy.current = false;
      setRun({
        directory,
        headSha,
        id: newId(),
        kind,
        projectId,
        stage: kind === "quick" ? "collecting" : "waiting",
        startedAt: Date.now(),
      });
    },
    view,
  };
};

const NEW_WORKTREE = "new";
const matchKey = (m: { projectId: string; directory: string }) =>
  `${m.projectId}\n${m.directory}`;

/** Where to run an AI review: an agent in a checkout of the pull request, or a quick one from the diff. */
export const ForgejoAiReviewDialog = (props: {
  details: ForgejoPullDetails;
  onStart: AiReview["start"];
  onClose: () => void;
}) => {
  const { details } = props;
  const { snapshot } = useDash();
  const projects = snapshot?.projects ?? [];
  const links = useForgejoCheckouts(details);
  const matches = links.data?.matches ?? [];
  const exact = matches.filter((m) => m.exact);
  const [picked, setPicked] = useState("");
  const choice = picked || (exact[0] ? matchKey(exact[0]) : NEW_WORKTREE);
  const [project, setProject] = useState("");
  const newProject = project || matches[0]?.projectId || "";
  const [branch, setBranch] = useState(`review/pr-${details.pull.number}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const quick = exact[0] ?? matches[0];
  const label = (m: { projectId: string; directory: string }) => {
    const view = projects.find((p) => p.project.id === m.projectId);
    const c = view && checkouts(view).find((k) => k.directory === m.directory);
    return `${view?.project.name ?? m.projectId} · ${c?.label ?? m.directory}`;
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (choice !== NEW_WORKTREE) {
      const [projectId = "", directory = ""] = choice.split("\n");
      props.onStart("agent", projectId, directory);
      props.onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { worktree } = await createForgejoWorktree(
        details.pull.owner,
        details.pull.repo,
        String(details.pull.number),
        newProject,
        branch.trim(),
        details.headSha
      );
      props.onStart("agent", newProject, worktree.path);
      props.onClose();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  const radio = (value: string, text: string, hint?: string) => (
    <label key={value} className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name="ai-review-checkout"
        className="accent-primary mt-1"
        value={value}
        checked={choice === value}
        onChange={() => setPicked(value)}
      />
      <span>
        {text}
        {hint && (
          <span className="text-muted-foreground block text-xs">{hint}</span>
        )}
      </span>
    </label>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>AI review of #{details.pull.number}</DialogTitle>
            <DialogDescription>
              An agent reviews the head commit in a checkout of the pull
              request, where it can read the surrounding code and run tests. It
              doesn&apos;t change anything. Its findings appear in the diff as
              suggestions for you to accept, edit or dismiss.
            </DialogDescription>
          </DialogHeader>
          <RequestState query={links} />
          <fieldset disabled={busy} className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Review in</legend>
            {exact.map((m) =>
              radio(matchKey(m), label(m), "Checkout of this pull request")
            )}
            {radio(
              NEW_WORKTREE,
              "A new worktree at the head commit",
              "Starts its own container when the project's doesn't mount worktrees."
            )}
            {choice === NEW_WORKTREE && (
              <div className="grid gap-3 pl-6 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="ai-review-project">Project</Label>
                  <Choice
                    id="ai-review-project"
                    size="default"
                    value={newProject}
                    onChange={setProject}
                    options={[
                      { label: "Select project", value: "" },
                      ...projects.map((p) => ({
                        label: p.project.name,
                        value: p.project.id,
                      })),
                    ]}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ai-review-branch">Branch</Label>
                  <Input
                    id="ai-review-branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </div>
              </div>
            )}
          </fieldset>
          {quick && (
            <Note>
              In a hurry? A quick review reads only the diff, in {label(quick)}.
            </Note>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="flex-wrap">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            {quick && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  props.onStart("quick", quick.projectId, quick.directory);
                  props.onClose();
                }}
              >
                Quick review
              </Button>
            )}
            <Button
              type="submit"
              disabled={
                busy ||
                (choice === NEW_WORKTREE && (!newProject || !branch.trim()))
              }
            >
              {busy ? "Creating worktree…" : "Start agent review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const SEVERITY_STYLE: Record<AiSeverity, string> = {
  blocker: "bg-destructive/15 text-destructive",
  major: "bg-warn/15 text-warn",
  minor: "bg-muted text-muted-foreground",
  nit: "bg-muted text-muted-foreground",
};

export const SeverityChip = ({ severity }: { severity: AiSeverity }) => (
  <Chip className={SEVERITY_STYLE[severity]}>{severity}</Chip>
);

const stageText = (run: AiReviewRun, session?: SessionSummary): string => {
  if (run.stage === "waiting") {
    return "Waiting for the checkout's container and opencode…";
  }
  if (run.stage === "reviewing") {
    if (
      session?.status === "needs-permission" ||
      session?.status === "needs-answer"
    ) {
      return "The review session is waiting on you.";
    }
    return "The agent is reviewing the pull request…";
  }
  if (run.stage === "collecting") {
    return run.kind === "quick"
      ? "Reviewing the diff…"
      : "Writing up the findings…";
  }
  return "";
};

/**
 * The AI review's progress, its summary and the findings that don't belong on a line. In Review mode a general
 * finding can go into the review summary; in Address mode it can go to the agent.
 */
export const AiReviewPanel = (props: {
  ai: AiReview;
  general: AiSuggestion[];
  /** Count of suggestions still open in the diff. */
  inline: number;
  renderGeneral: (s: AiSuggestion) => ReactNode;
  onRerun: () => void;
}) => {
  const { ai } = props;
  const { run } = ai;
  if (!run) {
    return null;
  }
  const working =
    run.stage === "waiting" ||
    run.stage === "reviewing" ||
    run.stage === "collecting";
  return (
    <section
      aria-label="AI review"
      className="bg-card flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SparklesIcon className="text-primary size-4 shrink-0" />
        <h2 className="font-semibold">AI review</h2>
        {run.stage === "done" && (
          <span className="text-muted-foreground text-sm">
            {props.inline} in the diff · {props.general.length} general
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {ai.sessionLink && (
            <Button asChild variant="ghost" size="sm">
              <Link to={ai.sessionLink}>
                <ExternalLinkIcon /> Session
              </Link>
            </Button>
          )}
          {run.stage === "reviewing" && (
            <Button variant="outline" size="sm" onClick={() => ai.collectNow()}>
              Collect findings now
            </Button>
          )}
          {run.stage === "failed" && (
            <Button variant="outline" size="sm" onClick={() => ai.retry()}>
              Retry
            </Button>
          )}
          {run.stage === "done" && (
            <Button variant="outline" size="sm" onClick={props.onRerun}>
              Run again
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (
                run.stage !== "done" ||
                confirm("Clear the AI review and its open suggestions?")
              ) {
                ai.clear();
              }
            }}
          >
            {working ? "Stop waiting" : "Clear"}
          </Button>
        </div>
      </div>
      {working && (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        <p role="status" className="text-muted-foreground text-sm">
          {stageText(run, ai.session)}
        </p>
      )}
      {run.stage === "failed" && (
        <Note error>{run.error ?? "The AI review failed."}</Note>
      )}
      {run.stage === "done" && run.summary && (
        <MarkdownBody>{run.summary}</MarkdownBody>
      )}
      {run.stage === "done" && !run.findings?.length && !run.summary && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <CircleCheckIcon className="text-ok size-4" /> Nothing worth raising.
        </p>
      )}
      {!!props.general.length && (
        <ul className="flex flex-col divide-y rounded-lg border">
          {props.general.map((s) => (
            <li key={s.id}>{props.renderGeneral(s)}</li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** One AI suggestion, inside the diff or in the panel's general list. */
export const AiSuggestionCard = (props: {
  suggestion: AiSuggestion;
  /** Review mode: take it into your review. */
  onAccept?: (text: string) => void;
  /** Address mode: whether it goes to the agent. */
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
  onDismiss: () => void;
  acceptLabel?: string;
  inDiff?: boolean;
}) => {
  const { suggestion: s } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.body);
  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-3 py-2 font-sans text-sm",
        props.inDiff &&
          "border-primary/60 bg-card text-card-foreground mx-2 my-1 rounded-sm border border-l-3 border-dashed"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SparklesIcon className="text-primary size-3.5 shrink-0" />
        <span className="text-muted-foreground text-xs">AI suggestion</span>
        <SeverityChip severity={s.severity} />
        {!props.inDiff && s.file && (
          <span className="text-muted-foreground font-mono text-xs break-all">
            {s.file}
            {s.line === undefined
              ? ""
              : `:${linesLabel({ ...s, startSide: s.side })}`}
          </span>
        )}
        {props.inDiff && s.start !== undefined && (
          <span className="text-muted-foreground text-xs">
            Lines {linesLabel({ ...s, startSide: s.side })}
          </span>
        )}
      </div>
      {editing ? (
        <Textarea
          aria-label="Edit suggestion"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by an explicit Edit click
          autoFocus
        />
      ) : (
        <MarkdownBody>{s.body}</MarkdownBody>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {props.onAccept && (
          <Button
            size="sm"
            disabled={!text.trim()}
            onClick={() => props.onAccept?.(editing ? text.trim() : s.body)}
          >
            {props.acceptLabel ?? "Accept"}
          </Button>
        )}
        {props.onAccept && !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {props.onSelect && (
          <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              checked={!!props.selected}
              onChange={(e) => props.onSelect?.(e.target.checked)}
            />
            Add to handoff
          </label>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground ml-auto"
          onClick={props.onDismiss}
        >
          <XIcon /> Dismiss
        </Button>
      </div>
    </div>
  );
};

/** Someone's inline Forgejo comment, shown at its line in the diff. */
export const ForgejoCommentNote = (props: {
  comment: ForgejoComment;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
}) => {
  const { comment: c } = props;
  return (
    <div
      className={cn(
        "bg-card text-card-foreground mx-2 my-1 flex flex-col gap-1.5 rounded-sm border border-l-3 px-3 py-2 font-sans text-sm",
        c.resolved ? "border-l-muted-foreground/40 opacity-70" : "border-l-warn"
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <MessageSquareIcon className="text-muted-foreground size-3.5 shrink-0" />
        <strong>{c.author}</strong>
        {c.resolved && <Chip>Resolved</Chip>}
        {props.onSelect && (
          <label className="text-muted-foreground ml-auto inline-flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-primary"
              checked={!!props.selected}
              onChange={(e) => props.onSelect?.(e.target.checked)}
            />
            Add to handoff
          </label>
        )}
      </div>
      <MarkdownBody>{c.body}</MarkdownBody>
    </div>
  );
};
