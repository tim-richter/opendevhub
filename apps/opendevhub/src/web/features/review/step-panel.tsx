import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@opendevhub/ui/dropdown-menu";
import { Skeleton } from "@opendevhub/ui/skeleton";
import { Textarea } from "@opendevhub/ui/textarea";
import {
  CheckCircle2Icon,
  EllipsisIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import type { Step } from "./next-step";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Message box and button for what was kept; the one place a commit is made. */
const CommitForm = (props: {
  kept?: number;
  left?: number;
  disabled: boolean;
  onCommit: (message: string) => Promise<unknown>;
  onKeepAll: () => void;
  onSuggest: () => Promise<string | undefined>;
}) => {
  const { kept, left, disabled } = props;
  const [message, setMessage] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const nothingKept = kept === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text || !kept) {
      return;
    }
    props
      .onCommit(text)
      .then(() => setMessage(""))
      // The error is shown by the page; the message stays so it can be sent again.
      .catch(() => undefined);
  };
  const suggest = () => {
    setSuggesting(true);
    props
      .onSuggest()
      .then((s) => s && setMessage(s))
      .catch(() => undefined)
      .finally(() => setSuggesting(false));
  };
  return (
    <form className="flex flex-col gap-2.5" onSubmit={submit}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="tabular-nums">
          {kept === undefined ? (
            <Skeleton className="h-4 w-24" />
          ) : (
            <>
              <span className={kept > 0 ? "text-ok font-medium" : undefined}>
                {plural(kept, "hunk")} staged
              </span>
              {!!left && (
                <span className="text-muted-foreground">
                  {" "}
                  · {left} unstaged
                </span>
              )}
            </>
          )}
        </span>
        {!!left && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={props.onKeepAll}
          >
            Stage all
          </Button>
        )}
      </div>
      <Textarea
        aria-label="Commit message"
        className="min-h-0"
        rows={3}
        placeholder="Commit message"
        value={message}
        disabled={nothingKept}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          className="flex-1"
          disabled={disabled || !kept || !message.trim()}
        >
          <GitCommitHorizontalIcon aria-hidden />
          {kept ? `Commit ${plural(kept, "hunk")}` : "Commit"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Suggest a message"
          title="Ask the agent for a message"
          disabled={disabled || suggesting}
          onClick={suggest}
        >
          {suggesting ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <SparklesIcon />
          )}
        </Button>
      </div>
      {nothingKept && (
        <p className="text-muted-foreground text-xs">
          Stage a change to commit it.
        </p>
      )}
    </form>
  );
};

/**
 * Everything you can do with the checkout's git state, in one place: the step to take next as the main button,
 * and the rest under "More". It replaces a menu in the toolbar and a commit bar at the page's end.
 */
export const StepPanel = (props: {
  /** Undefined while the checkout loads. */
  step?: Step;
  /** Whether the changes on screen are the uncommitted ones, which are the ones the commit form acts on. */
  showingUncommitted: boolean;
  kept?: number;
  left?: number;
  /** A git action is running. */
  busy?: string;
  committing: boolean;
  comments: number;
  /** The button for the step, when it isn't the commit form. */
  primary?: {
    label: string;
    icon: ReactNode;
    blocker?: string;
    run: () => void;
  };
  /** Entries of the More menu. */
  more: ReactNode;
  onCommit: (message: string) => Promise<unknown>;
  onKeepAll: () => void;
  onSuggest: () => Promise<string | undefined>;
  onShowUncommitted: () => void;
  onComments: () => void;
}) => {
  const { step, busy, primary } = props;
  const disabled = props.committing || !!busy;
  let body: ReactNode;
  if (!step) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (step.kind === "commit" && props.showingUncommitted) {
    body = (
      <CommitForm
        kept={props.kept}
        left={props.left}
        disabled={disabled}
        onCommit={props.onCommit}
        onKeepAll={props.onKeepAll}
        onSuggest={props.onSuggest}
      />
    );
  } else if (step.kind === "commit") {
    body = (
      <Button onClick={props.onShowUncommitted}>
        <GitCommitHorizontalIcon aria-hidden /> Review uncommitted changes
      </Button>
    );
  } else if (step.kind === "done") {
    body = (
      <p className="text-ok flex items-center gap-1.5 text-sm">
        <CheckCircle2Icon className="size-4" aria-hidden /> {step.detail}
      </p>
    );
  } else if (primary) {
    body = (
      <div className="flex flex-col gap-1.5">
        <Button
          disabled={disabled || !!primary.blocker}
          onClick={() => primary.run()}
        >
          {busy ? <LoaderCircleIcon className="animate-spin" /> : primary.icon}{" "}
          {busy ? `${busy}…` : primary.label}
        </Button>
        {primary.blocker && (
          <p className="text-muted-foreground text-xs">{primary.blocker}</p>
        )}
      </div>
    );
  }
  return (
    <Card className="gap-3 p-3">
      <div>
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Next step
        </p>
        <h2 className="font-medium">{step?.title ?? "Loading…"}</h2>
        {step && step.kind !== "done" && (
          <p className="text-muted-foreground text-xs">{step.detail}</p>
        )}
      </div>
      {body}
      <div className="flex items-center justify-between gap-2 border-t pt-2.5">
        <Button variant="ghost" size="sm" onClick={props.onComments}>
          <MessageSquareIcon aria-hidden /> Comments
          <span className="text-muted-foreground tabular-nums">
            {props.comments}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!!busy}>
              <EllipsisIcon aria-hidden /> More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {props.more}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
};
