import { useCallback, useEffect, useRef, useState } from "react";

import type { ReviewData, SessionSummary } from "../../../shared/types";
import {
  collectLocalAiReview,
  installOcr,
  runLocalOcrReview,
  startLocalAiReview,
} from "../../api";
import { useDash } from "../../dashboard-context";
import { sessionPath } from "../checkouts/checkouts";
import type { AiReviewRun } from "../forgejo/forgejo";
import { diffKey, newId } from "./review";

const IDLE_GRACE_MS = 20_000;
const GONE_MS = 30_000;
const TICK_MS = 5000;
const PROVIDER_ERROR =
  /set up open code review|unauthori[sz]ed|authenticat|forbidden|api key|\b40[13]\b|model.*(?:not found|does not exist|invalid)|no valid llm endpoint/iu;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const storageKey = (projectId: string, directory: string) =>
  `opendevhub:local-ai-review:${projectId}:${directory}`;

const readRun = (key: string): AiReviewRun | undefined => {
  try {
    const value = localStorage.getItem(key);
    if (!value) {
      return undefined;
    }
    const run = JSON.parse(value) as AiReviewRun;
    return run.kind === "ocr" && run.stage === "reviewing"
      ? {
          ...run,
          error:
            "The page closed while Open Code Review was running. Run the review again to see its findings.",
          stage: "failed",
        }
      : run;
  } catch {
    return undefined;
  }
};

/** An AI review or Open Code Review was started for the checkout and hasn't finished or failed. */
export const localAiReviewRunning = (
  projectId: string,
  directory: string
): boolean => {
  const stage = readRun(storageKey(projectId, directory))?.stage;
  return stage !== undefined && stage !== "done" && stage !== "failed";
};

export const useLocalAiReview = (input: {
  projectId: string;
  directory: string;
  data?: ReviewData;
  /** The page's conversation: when it is a task's, the review starts as a new conversation in that task. */
  sessionId?: string;
}) => {
  const { projectId, directory, data, sessionId: pageSession } = input;
  const key = storageKey(projectId, directory);
  const [run, setRunState] = useState(() => readRun(key));
  const runRef = useRef(run);
  const busy = useRef(false);
  const sawBusy = useRef(false);
  const ocrInFlight = useRef(false);
  const [tick, setTick] = useState(0);
  const { snapshot } = useDash();
  const view = snapshot?.projects.find((p) => p.project.id === projectId);
  const session: SessionSummary | undefined = run?.sessionId
    ? view?.sessions.find((s) => s.id === run.sessionId)
    : undefined;
  const setRun = useCallback(
    (next: AiReviewRun | undefined) => {
      runRef.current = next;
      setRunState(next);
      if (next) {
        localStorage.setItem(key, JSON.stringify(next));
      } else {
        localStorage.removeItem(key);
      }
    },
    [key]
  );
  const patch = useCallback(
    (id: string, change: Partial<AiReviewRun>) => {
      const { current } = runRef;
      if (current?.id === id) {
        setRun({ ...current, ...change });
      }
    },
    [setRun]
  );
  const collect = useCallback(
    async (current: AiReviewRun) => {
      if (busy.current || !current.sessionId) {
        return;
      }
      busy.current = true;
      patch(current.id, { error: undefined, stage: "collecting" });
      try {
        const result = await collectLocalAiReview(
          projectId,
          directory,
          current.sessionId
        );
        patch(current.id, {
          findings: result.findings,
          handled: [],
          stage: "done",
          summary: result.summary,
        });
      } catch (error) {
        patch(current.id, { error: errorText(error), stage: "failed" });
      } finally {
        busy.current = false;
      }
    },
    [projectId, directory, patch]
  );
  const runOcr = useCallback(
    async (current: AiReviewRun) => {
      if (busy.current) {
        return;
      }
      busy.current = true;
      ocrInFlight.current = true;
      try {
        patch(current.id, { error: undefined, stage: "installing" });
        await installOcr({ projectId, directory });
        patch(current.id, { stage: "reviewing", startedAt: Date.now() });
        const result = await runLocalOcrReview(projectId, {
          directory,
          runId: current.id,
          mode: current.headSha === "working" ? "working" : "branch",
          ...(current.headSha === "working"
            ? {}
            : { base: current.headSha.slice("branch:".length) }),
        });
        patch(current.id, {
          findings: result.findings,
          handled: [],
          stage: "done",
          summary: result.summary,
          stats: result.stats,
        });
      } catch (error) {
        const message = errorText(error);
        patch(current.id, {
          error: message,
          settingsError: PROVIDER_ERROR.test(message),
          stage: "failed",
        });
      } finally {
        busy.current = false;
        ocrInFlight.current = false;
      }
    },
    [projectId, directory, patch]
  );

  useEffect(() => {
    const { current } = runRef;
    if (current?.kind === "ocr" && current.stage === "installing") {
      void runOcr(current);
    }
  }, [run?.stage, runOcr]);

  useEffect(() => {
    const { current } = runRef;
    if (current?.stage !== "waiting" || busy.current) {
      return;
    }
    busy.current = true;
    void (async () => {
      try {
        const sessionId = await startLocalAiReview(projectId, {
          directory,
          mode: current.headSha === "working" ? "working" : "branch",
          ...(current.headSha === "working"
            ? {}
            : { base: current.headSha.slice("branch:".length) }),
          ...(pageSession ? { sessionId: pageSession } : {}),
        });
        sawBusy.current = false;
        patch(current.id, {
          sessionId,
          stage: "reviewing",
          startedAt: Date.now(),
        });
      } catch (error) {
        patch(current.id, { error: errorText(error), stage: "failed" });
      } finally {
        busy.current = false;
      }
    })();
  }, [run?.stage, projectId, directory, pageSession, patch]);

  useEffect(() => {
    const { current } = runRef;
    if (current?.kind !== "agent" || current.stage !== "reviewing") {
      return;
    }
    const waited = Date.now() - current.startedAt;
    if (!session) {
      if (view && waited > GONE_MS) {
        patch(current.id, {
          error: "The review conversation is gone.",
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
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [run?.stage]);

  useEffect(() => {
    const { current } = runRef;
    if (current?.stage === "collecting") {
      void collect(current);
    }
  }, [run?.stage, collect]);

  const scope =
    data?.mode === "branch" ? `branch:${data.base?.name ?? ""}` : "working";
  const revision = data
    ? `${scope}:${data.files.map(diffKey).join("|")}`
    : undefined;
  const sessionLink = view && session ? sessionPath(view, session) : undefined;
  return {
    run,
    session,
    sessionLink,
    orphaned:
      run?.kind === "ocr" && run.stage === "reviewing" && !ocrInFlight.current,
    start: (kind: "agent" | "ocr") => {
      sawBusy.current = false;
      setRun({
        directory,
        headSha: scope,
        id: newId(),
        kind,
        projectId,
        revision,
        stage: kind === "ocr" ? "installing" : "waiting",
        startedAt: Date.now(),
      });
    },
    clear: () => setRun(undefined),
    collectNow: () => {
      const { current } = runRef;
      if (current) {
        void collect(current);
      }
    },
    retry: () => {
      const { current } = runRef;
      if (!current) {
        return;
      }
      let stage: AiReviewRun["stage"] = "waiting";
      if (current.kind === "ocr") {
        stage = "installing";
      } else if (current.sessionId) {
        stage = "collecting";
      }
      setRun({
        ...current,
        error: undefined,
        stage,
      });
    },
    handle: (id: string) => {
      const { current } = runRef;
      if (current) {
        setRun({ ...current, handled: [...(current.handled ?? []), id] });
      }
    },
  };
};
