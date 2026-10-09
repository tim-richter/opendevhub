import { SendIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { ReviewData, SessionTurn } from "../../../shared/types";
import { fetchReview, sendPrompt } from "../../api";
import { muted } from "../../components/page";
import { DiffLinesSkeleton } from "../../components/skeletons";
import {
  composeReviewPrompt,
  draftKey,
  newId,
  readComments,
  readDiffView,
  writeComments,
  writeDiffView,
} from "./review";
import type { DiffView, LineAnchor, ReviewComment } from "./review";
import { FilesToggle, LayoutToggle, ReviewDiffs } from "./review-diffs";

/** What one of a session's turns changed, with line comments that go back to that session. */
export const TurnChanges = (props: {
  projectId: string;
  /** The checkout the session works in, which names its drafts. */
  target: string;
  directory: string;
  sessionId: string;
  turn: SessionTurn;
  /** It is the session's newest turn. */
  latest: boolean;
  /** The session is still at this turn, so its changes may grow. */
  running: boolean;
  onSent: (notice: string) => void;
}) => {
  const { projectId, directory, sessionId, turn } = props;
  const [data, setData] = useState<ReviewData>();
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    fetchReview(projectId, directory, {
      from: turn.id,
      mode: "turn",
      session: sessionId,
    }).then(
      (d) => {
        setData(d);
        setError(undefined);
      },
      (err) => setError(err instanceof Error ? err.message : String(err))
    );
  }, [projectId, directory, sessionId, turn.id]);
  // Read again as the turn goes on: each model call may change files.
  useEffect(load, [load, turn.steps, turn.completed]);

  // Drafts per session and turn, as the review keeps them.
  const key = draftKey(projectId, props.target, "turn", undefined, {
    from: turn.id,
    sessionId,
  });
  const [comments, setComments] = useState<ReviewComment[]>(() =>
    readComments(key)
  );
  // Comment boxes live inside @pierre/diffs annotations, which can hold on to an older render's callbacks.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const save = useCallback(
    (next: ReviewComment[]) => {
      commentsRef.current = next;
      setComments(next);
      writeComments(key, next);
    },
    [key]
  );
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();
  const [view, setView] = useState(readDiffView);
  const changeView = (change: Partial<DiffView>) => {
    const next = { ...view, ...change };
    setView(next);
    writeDiffView(next);
  };

  const add = useCallback(
    (file: string, anchor: LineAnchor, text: string) => {
      save([
        ...commentsRef.current,
        {
          file,
          id: newId(),
          line: anchor.line,
          quote: anchor.quote,
          side: anchor.side,
          start: anchor.start,
          startSide: anchor.startSide,
          text,
        },
      ]);
      setOpen(undefined);
    },
    [save]
  );
  const anchor = useCallback(
    (file: string, at: LineAnchor) => setOpen({ anchor: at, file }),
    []
  );
  const cancel = useCallback(() => setOpen(undefined), []);
  const remove = useCallback(
    (id: string) => save(commentsRef.current.filter((c) => c.id !== id)),
    [save]
  );

  const send = () => {
    setSending(true);
    sendPrompt(
      projectId,
      sessionId,
      composeReviewPrompt({
        comments,
        turn: { latest: props.latest, prompt: turn.prompt },
      })
    )
      .then(
        () => {
          const n = comments.length;
          save([]);
          props.onSent(
            `Sent ${n} comment${n === 1 ? "" : "s"} to the agent${props.running ? ", queued behind its turn" : ""}.`
          );
        },
        (err) => setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setSending(false));
  };

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!data) {
    return <DiffLinesSkeleton />;
  }
  if (data.files.length === 0) {
    return (
      <p className={muted}>
        {props.running
          ? "This turn hasn't changed any files yet."
          : "This turn changed no files."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilesToggle view={view} onChange={changeView} />
        <LayoutToggle view={view} onChange={changeView} />
        <span className={muted}>
          Comment on a line with the + in its gutter.
        </span>
        {comments.length > 0 && (
          <Button
            size="sm"
            className="ml-auto"
            disabled={sending}
            onClick={send}
          >
            <SendIcon /> Send {comments.length} comment
            {comments.length === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      <ReviewDiffs
        files={data.files}
        view={view}
        version={`turn:${sessionId}:${turn.id}`}
        wholeFilePatches
        load={(file) =>
          fetchReview(projectId, directory, {
            file,
            from: turn.id,
            mode: "turn",
            session: sessionId,
          }).then((d) => d.files[0]?.patch)
        }
        comments={comments}
        open={open}
        placeholder="Comment for the agent…"
        onAnchor={anchor}
        onAdd={add}
        onCancel={cancel}
        onDelete={remove}
      />
      {data.truncated && (
        <p className={muted}>
          Some diffs are too large to load at once; open them one by one.
        </p>
      )}
    </div>
  );
};
