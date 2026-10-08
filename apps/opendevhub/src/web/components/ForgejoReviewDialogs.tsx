import { XIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";

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

import type {
  ForgejoPullRequest,
  ForgejoReviewInput,
} from "../../shared/forgejo";
import { createForgejoWorktree, sendForgejoReview } from "../api";
import { checkoutPath } from "../checkouts";
import { useDash } from "../DashboardContext";
import { forgejoReviewComments } from "../forgejo";
import { linesLabel } from "../review";
import type { ReviewComment } from "../review";
import { Choice } from "./Choice";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const OUTCOMES = [
  { label: "Comment", value: "COMMENT" },
  { label: "Approve", value: "APPROVED" },
  { label: "Request changes", value: "REQUEST_CHANGES" },
];

/** Sends the draft line comments, with a summary and an outcome, as one Forgejo review. */
export const ForgejoReviewDialog = (props: {
  pull: ForgejoPullRequest;
  commitId: string;
  comments: ReviewComment[];
  /** The summary lives with the page, so closing the dialog keeps it. */
  body: string;
  onBody: (body: string) => void;
  onDelete: (id: string) => void;
  onSent: () => void;
  onClose: () => void;
}) => {
  const { pull, comments, body } = props;
  const [event, setEvent] = useState<ForgejoReviewInput["event"]>("COMMENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const empty = event === "COMMENT" && !body.trim() && !comments.length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await sendForgejoReview(pull.owner, pull.repo, String(pull.number), {
        body,
        comments: forgejoReviewComments(comments),
        commitId: props.commitId,
        event,
      });
      props.onSent();
      props.onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Review #{pull.number}</DialogTitle>
            <DialogDescription>
              Your draft comments and accepted AI suggestions are sent with this
              review. Close this to add more with the + in the diff&apos;s
              gutter.
            </DialogDescription>
          </DialogHeader>
          {comments.length > 0 ? (
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto text-sm">
              {comments.map((c) => (
                <li key={c.id} className="flex items-start gap-1.5">
                  <span className="whitespace-pre-wrap">
                    <span className="text-muted-foreground">
                      {c.file}:{linesLabel(c)}
                    </span>{" "}
                    {c.text}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground ml-auto"
                    aria-label="Delete comment"
                    disabled={busy}
                    onClick={() => props.onDelete(c.id)}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              No line comments yet.
            </p>
          )}
          <Textarea
            aria-label="Review summary"
            placeholder="Review summary…"
            value={body}
            disabled={busy}
            onChange={(e) => props.onBody(e.target.value)}
            autoFocus
          />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="items-center">
            <Choice
              label="Review outcome"
              size="default"
              value={event}
              disabled={busy}
              onChange={(v) => setEvent(v as ForgejoReviewInput["event"])}
              options={OUTCOMES}
            />
            <Button type="submit" disabled={busy || empty}>
              {busy ? "Sending…" : "Send review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Checks the pull request's head out in a new worktree of a local project and opens it. */
export const ForgejoWorktreeDialog = (props: {
  pull: ForgejoPullRequest;
  commitId: string;
  onClose: () => void;
}) => {
  const { pull } = props;
  const { snapshot } = useDash();
  const navigate = useNavigate();
  const [project, setProject] = useState("");
  const [branch, setBranch] = useState(`review/pr-${pull.number}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await createForgejoWorktree(
        pull.owner,
        pull.repo,
        String(pull.number),
        project,
        branch.trim(),
        props.commitId
      );
      const folder = result.worktree.path.split("/").findLast(Boolean) ?? "";
      await navigate(checkoutPath(project, folder));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && props.onClose()}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Inspect in a container</DialogTitle>
            <DialogDescription>
              Creates a worktree of a local project at this pull request&apos;s
              head commit and opens it. The project&apos;s container must be
              running with worktrees mounted, or the worktree starts its own.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="forgejo-worktree-project">Local project</Label>
            <Choice
              id="forgejo-worktree-project"
              label="Local project"
              size="default"
              value={project}
              disabled={busy}
              onChange={setProject}
              options={[
                { label: "Select project", value: "" },
                ...(snapshot?.projects ?? []).map((view) => ({
                  label: view.project.name,
                  value: view.project.id,
                })),
              ]}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="forgejo-worktree-branch">Worktree branch</Label>
            <Input
              id="forgejo-worktree-branch"
              value={branch}
              disabled={busy}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !project || !branch.trim()}>
              {busy ? "Creating…" : "Create worktree"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
