import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opendevhub/ui/dialog";
import { Input } from "@opendevhub/ui/input";
import { Label } from "@opendevhub/ui/label";
import { Textarea } from "@opendevhub/ui/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type {
  PublishInfo,
  PublishResult,
  PublishStrategy,
  ReviewData,
} from "../../../shared/types";
import { publishChanges, suggestPublish } from "../../api";
import { Choice } from "../../components/choice";
import { publishBlocker } from "./review";
import { publishInfoQuery } from "./review-queries";

const STRATEGY_LABEL: Record<PublishStrategy, string> = {
  agit: "Push and open the PR (AGit)",
  branch: "Push, then open the PR",
  push: "Just push the branch",
};

/** The checkout's remotes, forge and open PR; read once the review loads, and again when its branch changes. */
export const usePublishInfo = (
  projectId: string,
  directory: string,
  data: ReviewData | undefined
) => {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...publishInfoQuery(projectId, directory),
    enabled: !!data,
  });
  const branch = data?.branch;
  const shownBranch = useRef(branch);
  useEffect(() => {
    if (branch !== shownBranch.current) {
      shownBranch.current = branch;
      void queryClient.invalidateQueries({
        queryKey: publishInfoQuery(projectId, directory).queryKey,
      });
    }
  }, [branch, projectId, directory, queryClient]);
  const loadInfo = useCallback(
    (remote?: string) =>
      queryClient
        .fetchQuery({
          ...publishInfoQuery(projectId, directory, remote),
          staleTime: 0,
        })
        .catch(() => undefined),
    [projectId, directory, queryClient]
  );
  const info = query.data;
  /** Why publishing isn't possible right now; undefined when it is. */
  const blocker =
    !data || !info
      ? (query.error?.message ?? "Loading…")
      : (publishBlocker(data) ??
        (info.remotes.length === 0
          ? "This repository has no remote"
          : undefined));
  return { blocker, info, loadInfo };
};

/** Pushes the branch and, when asked, opens or updates its pull request. Mount it while open, so every opening starts fresh. */
export const PublishDialog = (props: {
  projectId: string;
  directory: string;
  info: PublishInfo;
  loadInfo: (remote?: string) => Promise<PublishInfo | undefined>;
  baseName?: string;
  /** Set when the project's checks haven't all passed on this commit; publishing stays possible. */
  checksWarning?: string;
  onClose: () => void;
  onPublished: (result: PublishResult) => void;
}) => {
  const { projectId, directory } = props;
  const [info, setInfo] = useState(props.info);
  const [remote, setRemote] = useState(props.info.remote);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState(props.baseName ?? "");
  const [strategy, setStrategy] = useState<PublishStrategy>(
    props.info.strategy
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [suggesting, setSuggesting] = useState(false);
  const opensPr = strategy !== "push";
  const suggest = () => {
    setSuggesting(true);
    setError(undefined);
    suggestPublish(projectId, directory)
      .then((s) => {
        if (s.title) {
          setTitle(s.title);
          setDescription(s.description);
        }
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setSuggesting(false));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!remote) {
      return;
    }
    setBusy(true);
    setError(undefined);
    publishChanges(projectId, directory, {
      base,
      description: opensPr ? description : "",
      remote,
      strategy,
      title: opensPr ? title : "",
    })
      .then((r) => {
        props.onPublished(r);
        void props.loadInfo(remote);
        props.onClose();
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {info.pr ? "Update pull request" : "Publish"}
            </DialogTitle>
            <DialogDescription>
              Pushes{" "}
              {info.pushFrom === "host"
                ? "from this machine, with your own git credentials"
                : "from the container"}
              {info.forge.kind === "unknown" ? "" : ` to ${info.forge.kind}`}.
            </DialogDescription>
          </DialogHeader>
          {props.checksWarning && (
            <Alert className="border-warn/40 bg-warn/10">
              <AlertDescription className="text-warn">
                {props.checksWarning} You can still publish.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
            <Label className="font-normal" htmlFor="publish-remote">
              Remote
            </Label>
            <Choice
              id="publish-remote"
              label="Remote"
              value={remote ?? ""}
              onChange={(r) => {
                setRemote(r);
                void props.loadInfo(r).then((i) => {
                  if (!i) {
                    return;
                  }
                  setInfo(i);
                  setStrategy(i.strategy);
                });
              }}
              options={info.remotes.map((r) => ({ label: r, value: r }))}
            />
            <Label className="font-normal" htmlFor="publish-strategy">
              How
            </Label>
            <Choice
              id="publish-strategy"
              label="How to publish"
              value={strategy}
              onChange={(v) => setStrategy(v as PublishStrategy)}
              options={info.strategies.map((s) => ({
                label: STRATEGY_LABEL[s],
                value: s,
              }))}
            />
            {opensPr && (
              <>
                <Label className="font-normal" htmlFor="publish-base">
                  Into
                </Label>
                <Input
                  id="publish-base"
                  className="h-8"
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  aria-label="Target branch"
                />
              </>
            )}
          </div>
          {opensPr && (
            <>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Pull request title"
                  placeholder="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Suggest a title and description"
                  title="Ask the agent for a title and description"
                  disabled={suggesting}
                  onClick={suggest}
                >
                  {suggesting ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <SparklesIcon />
                  )}
                </Button>
              </div>
              <Textarea
                aria-label="Pull request description"
                rows={6}
                placeholder="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy || !remote || (opensPr && (!title.trim() || !base.trim()))
              }
            >
              {publishLabel(busy, opensPr, !!info.pr)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const publishLabel = (
  busy: boolean,
  opensPr: boolean,
  hasPr: boolean
): string => {
  if (busy) {
    return "Publishing…";
  }
  if (!opensPr) {
    return "Push";
  }
  return hasPr ? "Update PR" : "Open PR";
};
