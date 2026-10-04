import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import type { ProjectView, ReviewData, ReviewFile, UpdateResult } from "../../shared/types";
import {
  commitChanges,
  fetchReview,
  mergeIntoBase,
  removeWorktree,
  sendPrompt,
  startSession,
  suggestCommitMessage,
  updateFromBase,
} from "../api";
import { DiffView } from "../components/DiffView";
import { Icon } from "../components/Icon";
import { workspaceFolderOf } from "../derive";
import {
  composeReviewPrompt,
  conflictPrompt,
  directoryOf,
  draftKey,
  isLarge,
  type LineAnchor,
  newId,
  readComments,
  type ReviewComment,
  sentKey,
  targetOf,
  writeComments,
} from "../review";

export function ProjectReview() {
  const view = useOutletContext<ProjectView>();
  const { target = "" } = useParams();
  const base = `/p/${encodeURIComponent(view.project.id)}/review`;
  const ready = view.runtime.containerState === "running" && view.runtime.opencode === "healthy";
  if (!ready) {
    return (
      <div className="empty">
        <h2>Not running</h2>
        <p className="muted">Start the project to review what its agents changed.</p>
      </div>
    );
  }
  const directory = directoryOf(view, target);
  if (!directory) {
    return (
      <div className="empty">
        <h2>Unknown checkout</h2>
        <p className="muted">There is no worktree named {target}.</p>
        <Link to={base}>Review the main checkout</Link>
      </div>
    );
  }
  return <ReviewTarget key={directory} view={view} directory={directory} target={target} />;
}

function ReviewTarget({ view, directory, target }: { view: ProjectView; directory: string; target: string }) {
  const navigate = useNavigate();
  const projectId = view.project.id;
  const reviewBase = `/p/${encodeURIComponent(projectId)}/review`;
  const isWorktree = directory !== workspaceFolderOf(view);

  const [baseOverride, setBaseOverride] = useState<string>();
  const [baseInput, setBaseInput] = useState("");
  const [data, setData] = useState<ReviewData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(() => {
    setLoading(true);
    fetchReview(projectId, directory, { base: baseOverride })
      .then(
        (d) => {
          setData(d);
          setError(undefined);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [projectId, directory, baseOverride]);
  useEffect(load, [load]);

  // Refresh when an agent working here finishes its turn.
  const runningHere = view.sessions
    .filter((s) => s.directory === directory && s.status === "running")
    .map((s) => s.id)
    .sort()
    .join(",");
  const previous = useRef(runningHere);
  useEffect(() => {
    const before = previous.current.split(",").filter(Boolean);
    previous.current = runningHere;
    const now = new Set(runningHere.split(",").filter(Boolean));
    if (before.some((id) => !now.has(id))) load();
  }, [runningHere, load]);

  const baseName = data?.base?.name;
  useEffect(() => setBaseInput(baseName ?? ""), [baseName]);

  // Comments: drafts per project, target and base; sent ones per target.
  const key = draftKey(projectId, target, baseName);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  useEffect(() => setComments(readComments(key)), [key]);
  const saveComments = (next: ReviewComment[]) => {
    setComments(next);
    writeComments(key, next);
  };
  const [sent, setSent] = useState<ReviewComment[]>(() => readComments(sentKey(projectId, target)));
  const [general, setGeneral] = useState("");
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();
  const [draft, setDraft] = useState("");

  const sessions = useMemo(
    () => view.sessions.filter((s) => s.directory === directory).sort((a, b) => b.updatedAt - a.updatedAt),
    [view.sessions, directory],
  );
  const [sessionChoice, setSessionChoice] = useState("");
  const chosen = sessionChoice || sessions[0]?.id || "new";

  const run = (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setNotice(undefined);
    fn()
      .then(() => setError(undefined), (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(undefined));
  };

  const deliver = (text: string) =>
    chosen === "new"
      ? startSession(projectId, directory, data?.branch ? `Review of ${data.branch}` : "Review", text).then(() => undefined)
      : sendPrompt(projectId, chosen, text);

  const sendComments = () =>
    run("send", async () => {
      await deliver(composeReviewPrompt({ branch: data?.branch, base: baseName, comments }));
      const nextSent = [...sent, ...comments];
      setSent(nextSent);
      writeComments(sentKey(projectId, target), nextSent);
      saveComments([]);
      setNotice(`Sent ${comments.length} comment${comments.length === 1 ? "" : "s"} to the agent.`);
    });

  const addLineComment = (e: FormEvent) => {
    e.preventDefault();
    if (!open || !draft.trim()) return;
    saveComments([...comments, { id: newId(), file: open.file, line: open.anchor.line, side: open.anchor.side, quote: open.anchor.quote, text: draft.trim() }]);
    setOpen(undefined);
    setDraft("");
  };

  const addGeneral = (e: FormEvent) => {
    e.preventDefault();
    if (!general.trim()) return;
    saveComments([...comments, { id: newId(), text: general.trim() }]);
    setGeneral("");
  };

  // Git actions.
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [conflicts, setConflicts] = useState<UpdateResult>();
  const [ffOnly, setFfOnly] = useState(false);
  const [merged, setMerged] = useState<string>();

  const openCommit = () => {
    setCommitOpen(true);
    setMessage("");
    run("message", async () => setMessage(await suggestCommitMessage(projectId, directory)));
  };
  const commit = (e: FormEvent) => {
    e.preventDefault();
    run("commit", async () => {
      await commitChanges(projectId, directory, message);
      setCommitOpen(false);
      setNotice("Committed.");
      load();
    });
  };
  const update = () =>
    run("update", async () => {
      const result = await updateFromBase(projectId, directory, baseName!);
      setConflicts(result.conflicts ? result : undefined);
      if (!result.conflicts) setNotice(`Updated from ${baseName} (${result.strategy}).`);
      load();
    });
  const merge = () =>
    run("merge", async () => {
      const { branch } = await mergeIntoBase(projectId, directory, baseName!, ffOnly);
      setMerged(branch);
      setNotice(`Merged ${branch} into ${baseName}.`);
      load();
    });
  const removeMerged = () =>
    run("remove", async () => {
      await removeWorktree(projectId, directory, false, true);
      void navigate(reviewBase);
    });

  const checkouts = [{ target: "", label: "Main checkout" }].concat(
    (view.runtime.worktrees ?? []).flatMap((w) => {
      const t = targetOf(view, w.path);
      return t ? [{ target: t, label: w.branch ?? t }] : [];
    }),
  );
  const baseOptions = [...new Set([baseName, data?.workspace.branch, ...(view.runtime.worktrees ?? []).map((w) => w.branch)].filter(Boolean))] as string[];

  const canCommit = !!data?.dirty;
  const canUpdate = !!data && !!baseName && !!data.branch && data.behind > 0 && !data.dirty;
  const mergeBlocker = !data
    ? "loading"
    : !isWorktree
      ? "The main checkout is the base"
      : data.ahead === 0
        ? "Nothing to merge"
        : data.dirty
          ? "Commit the changes first"
          : !data.workspace.clean
            ? "The main checkout has uncommitted changes"
            : data.workspace.branch !== baseName
              ? `The main checkout is on ${data.workspace.branch ?? "a detached HEAD"}, not ${baseName}`
              : undefined;

  return (
    <div className="tab-body review">
      <div className="review-head">
        <select aria-label="Checkout" value={target} onChange={(e) => void navigate(e.target.value ? `${reviewBase}/${encodeURIComponent(e.target.value)}` : reviewBase)}>
          {checkouts.map((c) => (
            <option key={c.target} value={c.target}>
              {c.label}
            </option>
          ))}
        </select>
        {data?.branch && (
          <span className="chip">
            <Icon name="branch" size={11} /> {data.branch}
          </span>
        )}
        <form
          className="review-base"
          onSubmit={(e) => {
            e.preventDefault();
            setBaseOverride(baseInput.trim() || undefined);
          }}
        >
          <label className="muted" htmlFor="review-base">
            compared with
          </label>
          <input id="review-base" list="review-bases" value={baseInput} onChange={(e) => setBaseInput(e.target.value)} placeholder="base" />
          <datalist id="review-bases">
            {baseOptions.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </form>
        {data && (
          <span className="muted review-counts" title={data.base ? `base from ${data.base.source}` : undefined}>
            {data.ahead} ahead · {data.behind} behind{data.dirty ? " · uncommitted changes" : ""}
          </span>
        )}
        <button className="small ghost" disabled={loading} onClick={load}>
          <Icon name="refresh" size={13} /> {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <section className="review-actions">
        <button disabled={!canCommit || !!busy} onClick={openCommit} title={canCommit ? undefined : "No uncommitted changes"}>
          Commit…
        </button>
        <button disabled={!canUpdate || !!busy} onClick={update} title={canUpdate ? undefined : "Nothing to bring in, or uncommitted changes"}>
          Update from {baseName ?? "base"}
        </button>
        <button disabled={!!mergeBlocker || !!busy} onClick={merge} title={mergeBlocker}>
          Merge into {baseName ?? "base"}
        </button>
        <label className="toggle">
          <input type="checkbox" checked={ffOnly} onChange={(e) => setFfOnly(e.target.checked)} /> fast-forward only
        </label>
      </section>

      {commitOpen && (
        <form className="review-commit" onSubmit={commit}>
          <textarea
            aria-label="Commit message"
            rows={3}
            value={message}
            placeholder={busy === "message" ? "Asking the agent for a message…" : "Commit message"}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="pending-actions">
            <button type="submit" className="button primary" disabled={!message.trim() || !!busy}>
              Commit
            </button>
            <button type="button" className="link" onClick={() => setCommitOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {conflicts?.conflicts && data?.branch && baseName && (
        <div className="banner warn">
          <span>
            {conflicts.strategy === "rebase" ? "Rebasing" : "Merging"} conflicts in {conflicts.conflicts.join(", ")}. Nothing was changed.
          </span>
          <button
            className="small"
            disabled={!!busy}
            onClick={() =>
              run("resolve", async () => {
                await deliver(conflictPrompt({ branch: data.branch!, base: baseName, strategy: conflicts.strategy, files: conflicts.conflicts! }));
                setConflicts(undefined);
                setNotice("Asked the agent to resolve the conflicts.");
              })
            }
          >
            Ask agent to resolve
          </button>
        </div>
      )}

      {merged && isWorktree && (
        <div className="banner ok">
          <span>{merged} is merged. Remove its worktree and delete the branch?</span>
          <button className="small" disabled={!!busy} onClick={removeMerged}>
            Remove worktree and delete branch
          </button>
        </div>
      )}

      <section className="review-comments">
        <form onSubmit={addGeneral} className="review-general">
          <textarea rows={2} placeholder="General comment for the agent…" value={general} onChange={(e) => setGeneral(e.target.value)} />
          <button type="submit" disabled={!general.trim()}>
            Add comment
          </button>
        </form>
        {comments.length > 0 && (
          <ul className="review-drafts">
            {comments.map((c) => (
              <li key={c.id}>
                <span className="muted">{c.file ? `${c.file}:${c.line}${c.side === "old" ? " (removed)" : ""}` : "General"}</span> {c.text}
                <button className="icon-button" aria-label="Delete comment" onClick={() => saveComments(comments.filter((x) => x.id !== c.id))}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="pending-actions">
          <select aria-label="Send to" value={chosen} onChange={(e) => setSessionChoice(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
                {s.status === "running" ? " (working, queued)" : ""}
              </option>
            ))}
            <option value="new">New session</option>
          </select>
          <button className="button primary" disabled={comments.length === 0 || !!busy} onClick={sendComments}>
            Send to agent ({comments.length})
          </button>
        </div>
        {sent.length > 0 && (
          <details className="review-sent">
            <summary className="muted">Sent ({sent.length})</summary>
            <ul>
              {sent.map((c) => (
                <li key={c.id}>
                  <span className="muted">{c.file ? `${c.file}:${c.line}` : "General"}</span> {c.text}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {data && data.files.length === 0 && <p className="muted">No changes compared with {baseName ?? "the last commit"}.</p>}
      {data && data.files.length > 0 && (
        <div className="review-body">
          <nav className="review-files" aria-label="Changed files">
            {data.files.map((f, i) => (
              <a key={f.file} href={`#review-file-${i}`} className={`review-file status-${f.status}`}>
                <span className="review-status">{f.status[0].toUpperCase()}</span>
                <span className="review-name" title={f.file}>
                  {f.file}
                </span>
                <span className="review-stat">
                  <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                </span>
              </a>
            ))}
          </nav>
          <div className="review-diffs">
            {data.files.map((f, i) => (
              <FileDiff
                key={`${f.file}:${baseName}`}
                id={`review-file-${i}`}
                file={f}
                load={() => fetchReview(projectId, directory, { base: baseOverride, file: f.file }).then((d) => d.files[0]?.patch)}
                onAnchor={(anchor) => {
                  setOpen({ file: f.file, anchor });
                  setDraft("");
                }}
                renderAfter={(k) => (
                  <>
                    {comments
                      .filter((c) => c.file === f.file && `${c.side}:${c.line}` === k)
                      .map((c) => (
                        <div key={c.id} className="review-inline">
                          {c.text}
                        </div>
                      ))}
                    {open?.file === f.file && open.anchor.key === k && (
                      <form className="review-inline-form" onSubmit={addLineComment}>
                        <textarea autoFocus rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Comment for the agent…" />
                        <div className="pending-actions">
                          <button type="submit" className="button primary" disabled={!draft.trim()}>
                            Add
                          </button>
                          <button type="button" className="link" onClick={() => setOpen(undefined)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </>
                )}
              />
            ))}
          </div>
        </div>
      )}
      {data?.truncated && <p className="muted">Some diffs are too large to load at once; open them one by one.</p>}
    </div>
  );
}

function FileDiff(props: {
  id: string;
  file: ReviewFile;
  load: () => Promise<string | undefined>;
  onAnchor: (anchor: LineAnchor) => void;
  renderAfter: (key: string) => ReactNode;
}) {
  const { file } = props;
  const [collapsed, setCollapsed] = useState(isLarge(file));
  const [patch, setPatch] = useState(file.patch);
  const [loading, setLoading] = useState(false);
  return (
    <section className="review-diff" id={props.id}>
      <header>
        <button className="link" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          <Icon name={collapsed ? "chevron" : "chevron-down"} size={12} /> {file.file}
        </button>
        <span className="review-stat">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
      </header>
      {!collapsed &&
        (file.binary ? (
          <p className="muted review-note">binary</p>
        ) : patch !== undefined ? (
          <DiffView patch={patch} onAnchor={props.onAnchor} renderAfter={props.renderAfter} />
        ) : (
          <p className="review-note">
            <button
              className="small"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void props
                  .load()
                  .then(setPatch)
                  .finally(() => setLoading(false));
              }}
            >
              {loading ? "Loading…" : "Load diff"}
            </button>
          </p>
        ))}
    </section>
  );
}
