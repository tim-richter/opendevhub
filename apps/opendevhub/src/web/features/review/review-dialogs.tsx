import { ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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

import { commitChanges, suggestCommitMessage } from "../../api";
import { Choice } from "../../components/choice";
import type { ChoiceOption } from "../../components/choice";
import { acceptSuggestion, linesLabel } from "./review";
import type { ReviewComment } from "./review";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Commits every change in the checkout. The agent suggests a message in the background; typing wins over it. */
export const CommitDialog = (props: {
  projectId: string;
  directory: string;
  onClose: () => void;
  onCommitted: () => void;
}) => {
  const { projectId, directory } = props;
  const [text, setText] = useState("");
  const [generating, setGenerating] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const suggestion = useRef(0);
  useEffect(() => {
    const request = ++suggestion.current;
    suggestCommitMessage(projectId, directory)
      .then((s) =>
        setText((current) =>
          acceptSuggestion({
            current,
            latest: suggestion.current,
            request,
            suggestion: s,
          })
        )
      )
      .catch(() => undefined)
      .finally(() => {
        if (request === suggestion.current) {
          setGenerating(false);
        }
      });
    return () => {
      suggestion.current += 1;
    };
  }, [projectId, directory]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    commitChanges(projectId, directory, text)
      .then(() => {
        props.onCommitted();
        props.onClose();
      })
      .catch((err) => setError(message(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Commit</DialogTitle>
            <DialogDescription>
              Commits every uncommitted change in this checkout.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Commit message"
            rows={6}
            value={text}
            placeholder={
              generating ? "Asking the agent for a message…" : "Commit message"
            }
            onChange={(e) => setText(e.target.value)}
          />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim() || busy}>
              {busy ? "Committing…" : "Commit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Confirms merging the branch into its base, optionally fast-forward only. */
export const MergeDialog = (props: {
  branch?: string;
  base: string;
  ahead: number;
  onClose: () => void;
  onMerge: (ffOnly: boolean) => void;
}) => {
  const [ffOnly, setFfOnly] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge into {props.base}</DialogTitle>
          <DialogDescription>
            Merges {props.ahead} commit{props.ahead === 1 ? "" : "s"} from{" "}
            {props.branch ?? "this branch"} into {props.base} in the main
            checkout.
          </DialogDescription>
        </DialogHeader>
        <Label className="font-normal">
          <Checkbox
            checked={ffOnly}
            onCheckedChange={(c) => setFfOnly(c === true)}
          />{" "}
          Fast-forward only
        </Label>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              props.onMerge(ffOnly);
              props.onClose();
            }}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Picks the branch the review compares with; empty goes back to the default. */
export const BaseDialog = (props: {
  current?: string;
  options: string[];
  onClose: () => void;
  onChange: (base: string | undefined) => void;
}) => {
  const [base, setBase] = useState(props.current ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            props.onChange(base.trim() || undefined);
            props.onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>Compare with</DialogTitle>
            <DialogDescription>
              The branch the review diffs against. Leave it empty for the
              recorded or default base.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Base branch"
            list="review-bases"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="base branch"
            autoFocus
          />
          <datalist id="review-bases">
            {props.options.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit">Compare</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** The comments waiting for the agent: add a general one, drop any, and send them all to a session. */
export const CommentsDialog = (props: {
  comments: ReviewComment[];
  sent: ReviewComment[];
  sessions: ChoiceOption[];
  session: string;
  busy: boolean;
  onSession: (id: string) => void;
  onAdd: (text: string) => void;
  onDelete: (id: string) => void;
  onSend: () => void;
  onClose: () => void;
}) => {
  const { comments, sent } = props;
  const [general, setGeneral] = useState("");
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!general.trim()) {
      return;
    }
    props.onAdd(general.trim());
    setGeneral("");
  };
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Comments for the agent</DialogTitle>
          <DialogDescription>
            Comment on a line with the + in the diff&apos;s gutter, or add a
            general comment here.
          </DialogDescription>
        </DialogHeader>
        <form className="flex items-start gap-2" onSubmit={add}>
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
        {comments.length > 0 ? (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto text-sm">
            {comments.map((c) => (
              <li key={c.id} className="flex items-start gap-1.5">
                <span className="whitespace-pre-wrap">
                  <span className="text-muted-foreground">
                    {c.file ? `${c.file}:${linesLabel(c)}` : "General"}
                  </span>{" "}
                  {c.text}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground ml-auto"
                  aria-label="Delete comment"
                  onClick={() => props.onDelete(c.id)}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No comments yet.</p>
        )}
        {sent.length > 0 && (
          <Collapsible className="group/sent">
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]/sent:rotate-90" />{" "}
              Sent ({sent.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
                {sent.map((c) => (
                  <li key={c.id}>
                    <span className="text-muted-foreground">
                      {c.file ? `${c.file}:${c.line}` : "General"}
                    </span>{" "}
                    {c.text}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
        <DialogFooter className="items-center">
          <Choice
            label="Send to"
            size="default"
            className="max-w-full sm:max-w-64"
            value={props.session}
            onChange={props.onSession}
            options={props.sessions}
          />
          <Button
            disabled={comments.length === 0 || props.busy}
            onClick={props.onSend}
          >
            Send to agent ({comments.length})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
