import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { type DiffLineAnnotation, type SelectedLineRange, useStableCallback } from "@pierre/diffs/react";
import { ChangedFilesTree } from "../components/LazyChangedFilesTree";
import { PatchView } from "../components/LazyPatchView";
import { Icon } from "../components/Icon";
import { PublishPanel } from "../components/PublishPanel";
import { workspaceFolderOf } from "../derive";
import {
  acceptSuggestion,
  anchorFromRange,
  annotationsFor,
  composeReviewPrompt,
  conflictPrompt,
  diffKey,
  directoryOf,
  draftKey,
  isLarge,
  type LineAnchor,
  newId,
  readComments,
  selectionFor,
  type ReviewAnnotation,
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
  // Comment boxes live inside @pierre/diffs annotations, which can hold on to an older render's callbacks; the
  // handlers below therefore read the current comments and draft key from refs instead of from their closure.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const keyRef = useRef(key);
  keyRef.current = key;
  const saveComments = useCallback((next: ReviewComment[]) => {
    commentsRef.current = next;
    setComments(next);
    writeComments(keyRef.current, next);
  }, []);
  const [sent, setSent] = useState<ReviewComment[]>(() => readComments(sentKey(projectId, target)));
  const [general, setGeneral] = useState("");
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();

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

  const addLineComment = useCallback(
    (file: string, anchor: LineAnchor, text: string) => {
      saveComments([...commentsRef.current, { id: newId(), file, line: anchor.line, side: anchor.side, quote: anchor.quote, text }]);
      setOpen(undefined);
    },
    [saveComments],
  );
  const cancelLineComment = useCallback(() => setOpen(undefined), []);
  const deleteComment = useCallback((id: string) => saveComments(commentsRef.current.filter((c) => c.id !== id)), [saveComments]);

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

  // The suggestion is fetched in the background: it never blocks the actions, and it never replaces what you typed.
  const [generating, setGenerating] = useState(false);
  const suggestion = useRef(0);
  const openCommit = () => {
    setCommitOpen(true);
    setMessage("");
    const request = ++suggestion.current;
    setGenerating(true);
    suggestCommitMessage(projectId, directory)
      .then((text) => setMessage((current) => acceptSuggestion({ current, suggestion: text, request, latest: suggestion.current })))
      .catch(() => {})
      .finally(() => {
        if (request === suggestion.current) setGenerating(false);
      });
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

      {data && <PublishPanel projectId={projectId} directory={directory} data={data} baseName={baseName} onPublished={load} />}

      {commitOpen && (
        <form className="review-commit" onSubmit={commit}>
          <textarea
            aria-label="Commit message"
            rows={3}
            value={message}
            placeholder={generating ? "Asking the agent for a message…" : "Commit message"}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="pending-actions">
            <button type="submit" className="button primary" disabled={!message.trim() || !!busy}>
              Commit
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                suggestion.current++;
                setGenerating(false);
                setCommitOpen(false);
              }}
            >
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
          <div className="review-files">
            <ChangedFilesTree
              files={data.files}
              onSelect={(file) => {
                const index = data.files.findIndex((f) => f.file === file);
                document.getElementById(`review-file-${index}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
            />
          </div>
          <div className="review-diffs">
            {data.files.map((f, i) => (
              <FileDiff
                key={`${diffKey(f)}:${baseName}`}
                id={`review-file-${i}`}
                file={f}
                load={() => fetchReview(projectId, directory, { base: baseOverride, file: f.file }).then((d) => d.files[0]?.patch)}
                comments={comments}
                open={open?.file === f.file ? open.anchor : undefined}
                onAnchor={(anchor) => setOpen({ file: f.file, anchor })}
                onAdd={addLineComment}
                onCancel={cancelLineComment}
                onDelete={deleteComment}
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
  comments: ReviewComment[];
  /** The line whose comment box is open in this file. */
  open: LineAnchor | undefined;
  onAnchor: (anchor: LineAnchor) => void;
  /** These three must be stable: annotations may keep the first ones they were rendered with. */
  onAdd: (file: string, anchor: LineAnchor, text: string) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}) {
  const { file } = props;
  const [collapsed, setCollapsed] = useState(isLarge(file));
  const [patch, setPatch] = useState(file.patch);
  const [loading, setLoading] = useState(false);
  // @pierre/diffs wants stable callbacks and annotations; these read the latest props.
  const onComment = useStableCallback((range: SelectedLineRange) => {
    if (patch !== undefined) props.onAnchor(anchorFromRange(patch, range));
  });
  const annotations = useMemo(() => annotationsFor(props.comments, file.file, props.open), [props.comments, file.file, props.open]);
  const selectedLines = useMemo(() => selectionFor(props.open), [props.open]);
  const renderAnnotation = useStableCallback((a: DiffLineAnnotation<ReviewAnnotation>) =>
    a.metadata.kind === "draft" ? (
      <CommentForm onAdd={(text) => props.onAdd(file.file, a.metadata.kind === "draft" ? a.metadata.anchor : props.open!, text)} onCancel={props.onCancel} />
    ) : (
      <div className="review-inline">
        <span>{a.metadata.comment.text}</span>
        <button className="icon-button" aria-label="Delete comment" onClick={() => props.onDelete(a.metadata.kind === "comment" ? a.metadata.comment.id : "")}>
          <Icon name="close" size={12} />
        </button>
      </div>
    ),
  );
  const toggle = useStableCallback(() => (
    <button className="review-collapse" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} title={collapsed ? "Show diff" : "Hide diff"}>
      <Icon name={collapsed ? "chevron" : "chevron-down"} size={12} />
    </button>
  ));

  if (patch !== undefined && !file.binary) {
    return (
      <section className="review-diff" id={props.id}>
        <PatchView<ReviewAnnotation>
          patch={patch}
          collapsed={collapsed}
          onComment={onComment}
          annotations={annotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={toggle}
        />
      </section>
    );
  }
  return (
    <section className="review-diff" id={props.id}>
      <header>
        <span className="review-diff-name">{file.file}</span>
        <span className="review-stat">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
      </header>
      {file.binary ? (
        <p className="muted review-note">binary</p>
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
      )}
    </section>
  );
}

/** The comment box inside the diff. Keeps its own text so typing doesn't re-render the whole diff. */
function CommentForm(props: { onAdd: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  // The gutter button keeps focus through the click that opened this box, so focus it once that settles.
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <form
      className="review-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) props.onAdd(text.trim());
      }}
    >
      <textarea
        ref={input}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
        }}
        placeholder="Comment for the agent…"
      />
      <div className="pending-actions">
        <button type="submit" className="button primary" disabled={!text.trim()}>
          Add
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
