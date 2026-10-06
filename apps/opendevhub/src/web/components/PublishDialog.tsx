import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { PublishInfo, PublishResult, PublishStrategy, ReviewData } from "../../shared/types";
import { fetchPublishInfo, publishChanges, suggestPublish } from "../api";
import { acceptSuggestion, publishBlocker } from "../review";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Choice } from "./Choice";

const STRATEGY_LABEL: Record<PublishStrategy, string> = {
  agit: "AGit (the push opens the PR)",
  branch: "Push a branch, then open the PR",
};

/** The checkout's remotes, forge and open PR; reloaded when the review loads or its branch changes. */
export function usePublishInfo(projectId: string, directory: string, data: ReviewData | undefined) {
  const [info, setInfo] = useState<PublishInfo>();
  const [error, setError] = useState<string>();
  const loadInfo = useCallback(
    (remote?: string) =>
      fetchPublishInfo(projectId, directory, remote)
        .then((i) => {
          setInfo(i);
          setError(undefined);
          return i;
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          return undefined;
        }),
    [projectId, directory],
  );
  const loaded = !!data;
  const branch = data?.branch;
  useEffect(() => {
    if (loaded) void loadInfo();
  }, [loadInfo, loaded, branch]);
  /** Why publishing isn't possible right now; undefined when it is. */
  const blocker = !data || !info ? (error ?? "Loading…") : (publishBlocker(data) ?? (info.remotes.length === 0 ? "This repository has no remote" : undefined));
  return { info, loadInfo, blocker };
}

/** Pushes the branch and opens or updates its pull request. Mount it while open, so every opening starts fresh. */
export function PublishDialog(props: {
  projectId: string;
  directory: string;
  info: PublishInfo;
  loadInfo: (remote?: string) => Promise<PublishInfo | undefined>;
  baseName?: string;
  onClose: () => void;
  onPublished: (result: PublishResult) => void;
}) {
  const { projectId, directory } = props;
  const [info, setInfo] = useState(props.info);
  const [remote, setRemote] = useState(props.info.remote);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState(props.baseName ?? "");
  const [strategy, setStrategy] = useState<PublishStrategy>(props.info.strategy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [generating, setGenerating] = useState(true);
  // The suggestion arrives in the background and never replaces what you typed.
  const suggestion = useRef(0);
  useEffect(() => {
    const request = ++suggestion.current;
    suggestPublish(projectId, directory)
      .then((s) => {
        setTitle((current) => acceptSuggestion({ current, suggestion: s.title, request, latest: suggestion.current }));
        setDescription((current) => acceptSuggestion({ current, suggestion: s.description, request, latest: suggestion.current }));
      })
      .catch(() => {})
      .finally(() => {
        if (request === suggestion.current) setGenerating(false);
      });
    return () => {
      suggestion.current++;
    };
  }, [projectId, directory]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!remote) return;
    setBusy(true);
    setError(undefined);
    publishChanges(projectId, directory, { remote, base, strategy, title, description })
      .then((r) => {
        props.onPublished(r);
        void props.loadInfo(remote);
        props.onClose();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{info.pr ? "Update pull request" : "Publish"}</DialogTitle>
            <DialogDescription>
              Pushes {info.pushFrom === "host" ? "from this machine, with your own git credentials" : "from the container"}
              {info.forge.kind !== "unknown" ? ` to ${info.forge.kind}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Pull request title"
            placeholder={generating ? "Asking the agent for a title…" : "Title"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea aria-label="Pull request description" rows={6} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
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
                  if (!i) return;
                  setInfo(i);
                  setStrategy(i.strategy);
                });
              }}
              options={info.remotes.map((r) => ({ value: r, label: r }))}
            />
            <Label className="font-normal" htmlFor="publish-base">
              Into
            </Label>
            <Input id="publish-base" className="h-8" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Target branch" />
            <Label className="font-normal" htmlFor="publish-strategy">
              How
            </Label>
            <Choice
              id="publish-strategy"
              label="How to publish"
              value={strategy}
              onChange={(v) => setStrategy(v as PublishStrategy)}
              options={info.strategies.map((s) => ({ value: s, label: STRATEGY_LABEL[s] }))}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !remote || !title.trim() || !base.trim()}>
              {busy ? "Publishing…" : info.pr ? "Update PR" : "Publish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
