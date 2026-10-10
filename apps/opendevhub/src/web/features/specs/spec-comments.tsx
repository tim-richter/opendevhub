import { useMutation } from "@tanstack/react-query";
import { MessageSquarePlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { reviseSpec } from "../../api";
import { muted } from "../../components/page";
import { newId, readComments, writeComments } from "../review/review";
import type { ReviewComment } from "../review/review";
import {
  anchorKey,
  composeSpecFeedback,
  isAt,
  specDraftKey,
  whereLabel,
} from "./specs";
import type { SpecAnchor } from "./specs";

/** Comment drafts on one change, kept in the browser until they're sent, and the anchor being commented on. */
export const useSpecComments = (
  projectId: string,
  directory: string,
  change: string
) => {
  const key = specDraftKey(projectId, directory, change);
  const [comments, setComments] = useState<ReviewComment[]>(() =>
    readComments(key)
  );
  useEffect(() => setComments(readComments(key)), [key]);
  const [editing, setEditing] = useState<SpecAnchor>();
  const save = useCallback(
    (next: ReviewComment[]) => {
      setComments(next);
      writeComments(key, next);
    },
    [key]
  );
  return {
    add: (anchor: SpecAnchor | undefined, text: string) => {
      save([...comments, { ...anchor, id: newId(), text }]);
      setEditing(undefined);
    },
    cancel: () => setEditing(undefined),
    clear: () => save([]),
    comments,
    edit: setEditing,
    isEditing: (anchor: SpecAnchor) =>
      editing !== undefined && anchorKey(editing) === anchorKey(anchor),
    remove: (id: string) => save(comments.filter((c) => c.id !== id)),
  };
};

export type SpecComments = ReturnType<typeof useSpecComments>;

export const CommentButton = (props: {
  label: string;
  className?: string;
  onClick: () => void;
}) => (
  <Button
    type="button"
    variant="outline"
    size="icon-xs"
    className={cn("bg-background text-muted-foreground", props.className)}
    aria-label={props.label}
    title={props.label}
    onClick={props.onClick}
  >
    <MessageSquarePlusIcon />
  </Button>
);

const CommentForm = (props: {
  onAdd: (text: string) => void;
  onCancel: () => void;
}) => {
  const [text, setText] = useState("");
  // The button that opened this box keeps focus through the click, so focus it once that settles.
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <form
      className="bg-card flex flex-col gap-2 rounded-md border p-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) {
          props.onAdd(text.trim());
        }
      }}
    >
      <Textarea
        ref={input}
        className="min-h-0"
        rows={2}
        aria-label="Comment"
        placeholder="What should change here?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            props.onCancel();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!text.trim()}>
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};

const DeleteButton = (props: { onClick: () => void }) => (
  <Button
    variant="ghost"
    size="icon-xs"
    className="text-muted-foreground ml-auto shrink-0"
    aria-label="Delete comment"
    onClick={props.onClick}
  >
    <XIcon />
  </Button>
);

/** The comments drafted on one anchor, and the box to add one while it's open. */
export const AnchorComments = (props: {
  anchor: SpecAnchor;
  comments: SpecComments;
}) => {
  const { anchor, comments } = props;
  const here = comments.comments.filter((c) => isAt(c, anchor));
  const open = comments.isEditing(anchor);
  if (here.length === 0 && !open) {
    return null;
  }
  return (
    <div className="not-prose my-2 flex flex-col gap-2 font-sans text-sm">
      {here.map((c) => (
        <div
          key={c.id}
          className="bg-card flex items-start gap-2 rounded-md border px-3 py-2"
        >
          <span className="whitespace-pre-wrap">{c.text}</span>
          <DeleteButton onClick={() => comments.remove(c.id)} />
        </div>
      ))}
      {open && (
        <CommentForm
          onAdd={(text) => comments.add(anchor, text)}
          onCancel={() => comments.cancel()}
        />
      )}
    </div>
  );
};

/** Every drafted comment, a general one, and sending them all to the agent as `/opsx-update`. */
export const SendComments = (props: {
  projectId: string;
  directory: string;
  change: string;
  comments: SpecComments;
  /** Why sending has to wait, e.g. while the agent is working. */
  blocked?: string;
}) => {
  const { comments } = props;
  const [general, setGeneral] = useState("");
  const [notice, setNotice] = useState<string>();
  const send = useMutation({
    mutationFn: (drafts: ReviewComment[]) =>
      reviseSpec(props.projectId, {
        change: props.change,
        directory: props.directory,
        feedback: composeSpecFeedback(props.change, drafts),
      }),
    onMutate: () => setNotice(undefined),
    onSuccess: (_, drafts) => {
      comments.clear();
      setNotice(
        `Sent ${drafts.length} comment${drafts.length === 1 ? "" : "s"}; the agent is revising the spec with /opsx-update.`
      );
    },
  });
  const addGeneral = (e: FormEvent) => {
    e.preventDefault();
    if (general.trim()) {
      comments.add(undefined, general.trim());
      setGeneral("");
    }
  };
  const count = comments.comments.length;
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Feedback for the agent</h3>
        <span className={muted}>
          Comment on a block or requirement with its comment button.
        </span>
      </div>
      <form className="flex items-start gap-2" onSubmit={addGeneral}>
        <Textarea
          className="min-h-0 flex-1"
          rows={2}
          aria-label="General comment"
          placeholder="General comment…"
          value={general}
          onChange={(e) => setGeneral(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!general.trim()}>
          Add
        </Button>
      </form>
      {count > 0 && (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {comments.comments.map((c) => (
            <li key={c.id} className="flex items-start gap-1.5">
              <span className="whitespace-pre-wrap">
                <span className="text-muted-foreground">{whereLabel(c)}</span>{" "}
                {c.text}
              </span>
              <DeleteButton onClick={() => comments.remove(c.id)} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            count === 0 || send.isPending || props.blocked !== undefined
          }
          onClick={() => send.mutate(comments.comments)}
        >
          {send.isPending
            ? "Sending…"
            : `Send ${count} comment${count === 1 ? "" : "s"}`}
        </Button>
        {props.blocked && count > 0 && (
          <span className={muted}>{props.blocked}</span>
        )}
        {send.error && (
          <span className="text-destructive">{send.error.message}</span>
        )}
        {notice && <span className="text-ok">{notice}</span>}
      </div>
    </div>
  );
};
