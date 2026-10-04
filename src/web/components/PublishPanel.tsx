import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { PublishInfo, PublishResult, PublishStrategy, ReviewData } from "../../shared/types";
import { fetchPublishInfo, publishChanges, suggestPublish } from "../api";
import { acceptSuggestion, publishBlocker } from "../review";
import { Icon } from "./Icon";

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
    <section className="publish">
      <div className="pending-actions">
        <button disabled={!!blocker || busy || !info} title={blocker} onClick={openDialog}>
          {info?.pr ? "Update PR…" : "Publish…"}
        </button>
        {info?.pr && (
          <a className="button" href={info.pr} target="_blank" rel="noreferrer">
            View PR <Icon name="external" size={13} />
          </a>
        )}
        {info && info.forge.kind !== "unknown" && <span className="muted publish-forge">{info.forge.kind}</span>}
      </div>

      {open && info && (
        <form className="review-commit publish-form" onSubmit={submit}>
          <input aria-label="Pull request title" placeholder={generating ? "Asking the agent for a title…" : "Title"} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea aria-label="Pull request description" rows={4} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="publish-options">
            <label>
              Remote{" "}
              <select
                value={remote}
                onChange={(e) => {
                  setRemote(e.target.value);
                  void loadInfo(e.target.value);
                }}
              >
                {info.remotes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              into <input value={base} onChange={(e) => setBase(e.target.value)} aria-label="Target branch" />
            </label>
            <label>
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as PublishStrategy)} aria-label="How to publish">
                {info.strategies.map((s) => (
                  <option key={s} value={s}>
                    {STRATEGY_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted publish-where">
            Pushes {info.pushFrom === "host" ? "from this machine, with your own git credentials" : "from the container"}.
          </p>
          <div className="pending-actions">
            <button type="submit" className="button primary" disabled={busy || !title.trim() || !base.trim()}>
              {busy ? "Publishing…" : info.pr ? "Update PR" : "Publish"}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                suggestion.current++;
                setGenerating(false);
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <div className="banner error">{error}</div>}
      {result && (
        <div className="banner ok">
          <span>
            {result.notice ? `${result.notice} ` : ""}Pushed from {result.pushedFrom === "host" ? "this machine" : "the container"}.
          </span>
          {result.openUrl && (
            <a href={result.openUrl} target="_blank" rel="noreferrer">
              {result.prUrl ? "Open pull request" : "Create the pull request on the forge"} <Icon name="external" size={13} />
            </a>
          )}
        </div>
      )}
    </section>
  );
}
