import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ProjectView, ReviewData, ReviewFile, UpdateResult } from "../../shared/types";
import { useCheckout } from "./CheckoutPage";
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
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Choice } from "../components/Choice";
import { Chip, diffFont, Empty, muted } from "../components/Page";
import { PublishPanel } from "../components/PublishPanel";
import { DiffLinesSkeleton, ReviewSkeleton } from "../components/Skeletons";
import { workspaceFolderOf } from "../derive";
import {
  acceptSuggestion,
  anchorFromRange,
  annotationsFor,
  composeReviewPrompt,
  conflictPrompt,
  diffKey,
  draftKey,
  isLarge,
  linesLabel,
  type LineAnchor,
  newId,
  readComments,
  selectionFor,
  type ReviewAnnotation,
  type ReviewComment,
  sentKey,
  writeComments,
} from "../review";

export function ProjectReview() {
  const { view, checkout } = useCheckout();
  const ready = view.runtime.containerState === "running" && view.runtime.opencode === "healthy";
  if (!ready) {
    return (
      <Empty title="Not running">
        <p className={muted}>Start the project to review what its agents changed.</p>
      </Empty>
    );
  }
  return <ReviewTarget key={checkout.directory} view={view} directory={checkout.directory} target={checkout.target} />;
}

function ReviewTarget({ view, directory, target }: { view: ProjectView; directory: string; target: string }) {
  const navigate = useNavigate();
  const projectId = view.project.id;
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
      saveComments([...commentsRef.current, { id: newId(), file, line: anchor.line, side: anchor.side, start: anchor.start, startSide: anchor.startSide, quote: anchor.quote, text }]);
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
      void navigate(`/p/${encodeURIComponent(projectId)}`);
    });

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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        {!data && !error && <Skeleton className="h-5 w-32" />}
        {data?.branch && (
          <Chip>
            <GitBranchIcon /> {data.branch}
          </Chip>
        )}
        <form
          className="inline-flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setBaseOverride(baseInput.trim() || undefined);
          }}
        >
          <Label className="font-normal text-muted-foreground" htmlFor="review-base">
            compared with
          </Label>
          <Input id="review-base" className="h-8 w-44" list="review-bases" value={baseInput} onChange={(e) => setBaseInput(e.target.value)} placeholder="base" />
          <datalist id="review-bases">
            {baseOptions.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </form>
        {!data && !error && <Skeleton className="h-4 w-44" />}
        {data && (
          <span className={muted} title={data.base ? `base from ${data.base.source}` : undefined}>
            {data.ahead} ahead · {data.behind} behind{data.dirty ? " · uncommitted changes" : ""}
          </span>
        )}
        <Button variant="ghost" size="sm" className="ml-auto" disabled={loading} onClick={load}>
          <RefreshCwIcon /> {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && <OkBanner>{notice}</OkBanner>}

      <section className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!canCommit || !!busy} onClick={openCommit} title={canCommit ? undefined : "No uncommitted changes"}>
          Commit…
        </Button>
        <Button
          variant="outline"
          disabled={!canUpdate || !!busy}
          onClick={update}
          title={canUpdate ? undefined : "Nothing to bring in, or uncommitted changes"}
        >
          Update from {baseName ?? "base"}
        </Button>
        <Button variant="outline" disabled={!!mergeBlocker || !!busy} onClick={merge} title={mergeBlocker}>
          Merge into {baseName ?? "base"}
        </Button>
        <Label className="font-normal text-muted-foreground">
          <Checkbox checked={ffOnly} onCheckedChange={(c) => setFfOnly(c === true)} /> fast-forward only
        </Label>
      </section>

      <PublishPanel projectId={projectId} directory={directory} data={data} baseName={baseName} onPublished={load} />

      {commitOpen && (
        <form className="flex flex-col gap-2" onSubmit={commit}>
          <Textarea
            aria-label="Commit message"
            rows={3}
            value={message}
            placeholder={generating ? "Asking the agent for a message…" : "Commit message"}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!message.trim() || !!busy}>
              Commit
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                suggestion.current++;
                setGenerating(false);
                setCommitOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {conflicts?.conflicts && data?.branch && baseName && (
        <Alert className="border-warn/40 bg-warn/10">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-warn">
            <span>
              {conflicts.strategy === "rebase" ? "Rebasing" : "Merging"} conflicts in {conflicts.conflicts.join(", ")}. Nothing was changed.
            </span>
            <Button
              variant="outline"
              size="sm"
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
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {merged && isWorktree && (
        <OkBanner>
          <span>{merged} is merged. Remove its worktree and delete the branch?</span>
          <Button variant="outline" size="sm" disabled={!!busy} onClick={removeMerged}>
            Remove worktree and delete branch
          </Button>
        </OkBanner>
      )}

      <section className="flex flex-col gap-2">
        <form onSubmit={addGeneral} className="flex items-start gap-2">
          <Textarea
            rows={2}
            className="min-h-0 flex-1"
            placeholder="General comment for the agent…"
            value={general}
            onChange={(e) => setGeneral(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={!general.trim()}>
            Add comment
          </Button>
        </form>
        {comments.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {comments.map((c) => (
              <li key={c.id} className="flex items-start gap-1.5">
                <span className="whitespace-pre-wrap">
                  <span className="text-muted-foreground">{c.file ? `${c.file}:${linesLabel(c)}` : "General"}</span>{" "}
                  {c.text}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  aria-label="Delete comment"
                  onClick={() => saveComments(comments.filter((x) => x.id !== c.id))}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Choice
            label="Send to"
            size="default"
            value={chosen}
            onChange={setSessionChoice}
            options={[
              ...sessions.map((s) => ({ value: s.id, label: `${s.title}${s.status === "running" ? " (working, queued)" : ""}` })),
              { value: "new", label: "New session" },
            ]}
          />
          <Button disabled={comments.length === 0 || !!busy} onClick={sendComments}>
            Send to agent ({comments.length})
          </Button>
        </div>
        {sent.length > 0 && (
          <Collapsible className="group/sent">
            <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]/sent:rotate-90" /> Sent ({sent.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {sent.map((c) => (
                  <li key={c.id}>
                    <span className="text-muted-foreground">{c.file ? `${c.file}:${c.line}` : "General"}</span> {c.text}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>

      {!data && !error && <ReviewSkeleton />}
      {data && data.files.length === 0 && <p className={muted}>No changes compared with {baseName ?? "the last commit"}.</p>}
      {data && data.files.length > 0 && (
        <div className="grid items-start gap-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
          <Card className="sticky top-4 overflow-hidden py-0 max-md:static">
            <ChangedFilesTree
              files={data.files}
              onSelect={(file) => {
                const index = data.files.findIndex((f) => f.file === file);
                document.getElementById(`review-file-${index}`)?.scrollIntoView({ block: "start" });
              }}
            />
          </Card>
          <div className="flex min-w-0 flex-col gap-3">
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
      {data?.truncated && <p className={muted}>Some diffs are too large to load at once; open them one by one.</p>}
    </div>
  );
}

function OkBanner({ children }: { children: ReactNode }) {
  return (
    <Alert className="border-ok/40 bg-ok/10">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-ok">{children}</AlertDescription>
    </Alert>
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
      <CommentForm
        anchor={a.metadata.anchor}
        onAdd={(text) => props.onAdd(file.file, a.metadata.kind === "draft" ? a.metadata.anchor : props.open!, text)}
        onCancel={props.onCancel}
      />
    ) : (
      <div className="mx-2 my-1 flex items-start gap-2 rounded-sm border-l-3 border-primary bg-card px-2.5 py-2 font-sans text-sm whitespace-pre-wrap text-card-foreground">
        <span>
          {a.metadata.comment.start !== undefined && <span className="text-muted-foreground">Lines {linesLabel(a.metadata.comment)}: </span>}
          {a.metadata.comment.text}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-muted-foreground"
          aria-label="Delete comment"
          onClick={() => props.onDelete(a.metadata.kind === "comment" ? a.metadata.comment.id : "")}
        >
          <XIcon />
        </Button>
      </div>
    ),
  );
  const toggle = useStableCallback(() => (
    <button
      className="inline-flex items-center pr-1 text-muted-foreground hover:text-foreground"
      onClick={() => setCollapsed((c) => !c)}
      aria-expanded={!collapsed}
      title={collapsed ? "Show diff" : "Hide diff"}
    >
      {collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
    </button>
  ));

  if (patch !== undefined && !file.binary) {
    return (
      <Card className={cn("overflow-hidden py-0", diffFont)} id={props.id}>
        <PatchView<ReviewAnnotation>
          patch={patch}
          collapsed={collapsed}
          onComment={onComment}
          annotations={annotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={toggle}
        />
      </Card>
    );
  }
  return (
    <Card className="gap-0 overflow-hidden py-0" id={props.id}>
      <header className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-1.5">
        <span className="font-mono text-sm">{file.file}</span>
        <span className="font-mono text-xs whitespace-nowrap">
          <span className="text-ok">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span>
        </span>
      </header>
      {file.binary ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground">binary</p>
      ) : loading ? (
        <DiffLinesSkeleton />
      ) : (
        <p className="px-3 py-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              void props
                .load()
                .then(setPatch)
                .finally(() => setLoading(false));
            }}
          >
            Load diff
          </Button>
        </p>
      )}
    </Card>
  );
}

/** The comment box inside the diff. Keeps its own text so typing doesn't re-render the whole diff. */
function CommentForm(props: { anchor: LineAnchor; onAdd: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  // The gutter button keeps focus through the click that opened this box, so focus it once that settles.
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <form
      className="mx-2 my-1 flex flex-col gap-2 rounded-md border bg-card p-2 font-sans text-sm text-card-foreground"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) props.onAdd(text.trim());
      }}
    >
      {props.anchor.start !== undefined && <span className="text-muted-foreground">Lines {linesLabel(props.anchor)}</span>}
      <Textarea
        ref={input}
        className="min-h-0"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
        }}
        placeholder="Comment for the agent…"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!text.trim()}>
          Add
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
