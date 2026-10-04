import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { PublishInfo, PublishResult, PublishStrategy, ReviewData } from "../../shared/types";
import { fetchPublishInfo, publishChanges, suggestPublish } from "../api";
import { acceptSuggestion, publishBlocker } from "../review";
import { ExternalLinkIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Choice } from "./Choice";

const STRATEGY_LABEL: Record<PublishStrategy, string> = {
  agit: "AGit (the push opens the PR)",
  branch: "Push a branch, then open the PR",
};

export function PublishPanel(props: { projectId: string; directory: string; data: ReviewData; baseName?: string; onPublished: () => void }) {
  const { projectId, directory, data } = props;
  const [info, setInfo] = useState<PublishInfo>();
  const [remote, setRemote] = useState<string>();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState(props.baseName ?? "");
  const [strategy, setStrategy] = useState<PublishStrategy>("branch");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<PublishResult>();
  const [generating, setGenerating] = useState(false);
  const suggestion = useRef(0);

  const loadInfo = useCallback(
    (r?: string) =>
      fetchPublishInfo(projectId, directory, r)
        .then((i) => {
          setInfo(i);
          setRemote(i.remote);
          setStrategy(i.strategy);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))),
    [projectId, directory],
  );
  useEffect(() => void loadInfo(), [loadInfo, data.branch]);
  useEffect(() => setBase(props.baseName ?? ""), [props.baseName]);

  const openDialog = () => {
    setOpen(true);
    setResult(undefined);
    setError(undefined);
    const request = ++suggestion.current;
    setGenerating(true);
    suggestPublish(projectId, directory)
      .then((s) => {
        setTitle((current) => acceptSuggestion({ current, suggestion: s.title, request, latest: suggestion.current }));
        setDescription((current) => acceptSuggestion({ current, suggestion: s.description, request, latest: suggestion.current }));
      })
      .catch(() => {})
      .finally(() => {
        if (request === suggestion.current) setGenerating(false);
      });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!remote) return;
    setBusy(true);
    setError(undefined);
    publishChanges(projectId, directory, { remote, base, strategy, title, description })
      .then((r) => {
        setResult(r);
        setOpen(false);
        props.onPublished();
        void loadInfo(remote);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const blocker = publishBlocker(data) ?? (info && info.remotes.length === 0 ? "This repository has no remote" : undefined);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!!blocker || busy || !info} title={blocker} onClick={openDialog}>
          {info?.pr ? "Update PR…" : "Publish…"}
        </Button>
        {info?.pr && (
          <Button asChild variant="outline">
            <a href={info.pr} target="_blank" rel="noreferrer">
              View PR <ExternalLinkIcon />
            </a>
          </Button>
        )}
        {info && info.forge.kind !== "unknown" && <span className="text-xs text-muted-foreground">{info.forge.kind}</span>}
      </div>

      {open && info && (
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <Input
            aria-label="Pull request title"
            placeholder={generating ? "Asking the agent for a title…" : "Title"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea aria-label="Pull request description" rows={4} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <Label className="font-normal">
              Remote
              <Choice
                label="Remote"
                value={remote ?? ""}
                onChange={(r) => {
                  setRemote(r);
                  void loadInfo(r);
                }}
                options={info.remotes.map((r) => ({ value: r, label: r }))}
              />
            </Label>
            <Label className="font-normal">
              into <Input className="h-8 w-40" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Target branch" />
            </Label>
            <Choice
              label="How to publish"
              value={strategy}
              onChange={(v) => setStrategy(v as PublishStrategy)}
              options={info.strategies.map((s) => ({ value: s, label: STRATEGY_LABEL[s] }))}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Pushes {info.pushFrom === "host" ? "from this machine, with your own git credentials" : "from the container"}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || !title.trim() || !base.trim()}>
              {busy ? "Publishing…" : info.pr ? "Update PR" : "Publish"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                suggestion.current++;
                setGenerating(false);
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result && (
        <Alert className="border-ok/40 bg-ok/10">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-ok">
            <span>
              {result.notice ? `${result.notice} ` : ""}Pushed from {result.pushedFrom === "host" ? "this machine" : "the container"}.
            </span>
            {result.openUrl && (
              <a className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline" href={result.openUrl} target="_blank" rel="noreferrer">
                {result.prUrl ? "Open pull request" : "Create the pull request on the forge"} <ExternalLinkIcon className="size-3.5" />
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
