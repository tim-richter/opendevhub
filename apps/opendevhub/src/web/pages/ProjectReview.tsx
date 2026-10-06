import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { ProjectView, PublishResult, ReviewData, ReviewFile, UpdateResult } from "../../shared/types";
import { useCheckout } from "./CheckoutPage";
import { fetchReview, mergeIntoBase, removeWorktree, sendPrompt, startSession, updateFromBase } from "../api";
import { type DiffLineAnnotation, type SelectedLineRange, useStableCallback } from "@pierre/diffs/react";
import { ChangedFilesTree } from "../components/LazyChangedFilesTree";
import { PatchView } from "../components/LazyPatchView";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  Columns2Icon,
  ExternalLinkIcon,
  FoldVerticalIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitCompareArrowsIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  Rows2Icon,
  UnfoldVerticalIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { diffFont, Empty, muted } from "../components/Page";
import { PublishDialog, usePublishInfo } from "../components/PublishDialog";
import { BaseDialog, CommentsDialog, CommitDialog, MergeDialog } from "../components/ReviewDialogs";
import { DiffLinesSkeleton, ReviewSkeleton } from "../components/Skeletons";
import { workspaceFolderOf } from "../derive";
import {
  anchorFromRange,
  annotationsFor,
  composeReviewPrompt,
  conflictPrompt,
  diffKey,
  type DiffView,
  draftKey,
  isLarge,
  linesLabel,
  type LineAnchor,
  newId,
  readComments,
  readDiffView,
  selectionFor,
  type ReviewAnnotation,
  type ReviewComment,
  sentKey,
  writeComments,
  writeDiffView,
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
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();
  const [diffView, setDiffView] = useState(readDiffView);
  const changeDiffView = (change: Partial<DiffView>) => {
    const next = { ...diffView, ...change };
    setDiffView(next);
    writeDiffView(next);
  };

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
    run("Sending", async () => {
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

  // Git actions: each opens a dialog, or runs at once when there is nothing to choose.
  const [dialog, setDialog] = useState<"commit" | "merge" | "publish" | "base" | "comments">();
  const [conflicts, setConflicts] = useState<UpdateResult>();
  const [merged, setMerged] = useState<string>();
  const [published, setPublished] = useState<PublishResult>();
  const publish = usePublishInfo(projectId, directory, data);

  const update = () =>
    run("Updating", async () => {
      const result = await updateFromBase(projectId, directory, baseName!);
      setConflicts(result.conflicts ? result : undefined);
      if (!result.conflicts) setNotice(`Updated from ${baseName} (${result.strategy}).`);
      load();
    });
  const merge = (ffOnly: boolean) =>
    run("Merging", async () => {
      const { branch } = await mergeIntoBase(projectId, directory, baseName!, ffOnly);
      setMerged(branch);
      setNotice(`Merged ${branch} into ${baseName}.`);
      load();
    });
  const removeMerged = () =>
    run("Removing", async () => {
      await removeWorktree(projectId, directory, false, true);
      void navigate(`/p/${encodeURIComponent(projectId)}`);
    });

  const baseOptions = [...new Set([baseName, data?.workspace.branch, ...(view.runtime.worktrees ?? []).map((w) => w.branch)].filter(Boolean))] as string[];

  const commitBlocker = !data ? "Loading…" : data.dirty ? undefined : "No uncommitted changes";
  const updateBlocker = !data
    ? "Loading…"
    : !baseName || !data.branch
      ? "No base branch"
      : data.dirty
        ? "Commit the changes first"
        : data.behind === 0
          ? `Already up to date with ${baseName}`
          : undefined;
  const mergeBlocker = !data
    ? "Loading…"
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
  const base = baseName ?? "base";

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background/95 px-4 py-2 backdrop-blur max-md:top-[45px] md:-mx-8 md:px-8">
        <Tip label={diffView.hideFiles ? "Show changed files" : "Hide changed files"}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={diffView.hideFiles ? "Show changed files" : "Hide changed files"}
            aria-pressed={!diffView.hideFiles}
            onClick={() => changeDiffView({ hideFiles: !diffView.hideFiles })}
          >
            {diffView.hideFiles ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </Button>
        </Tip>
        {!data && !error && <Skeleton className="h-5 w-48" />}
        {data && (
          <div className="contents text-sm">
            <Tip label="Current branch">
              <span className="inline-flex min-w-0 items-center gap-1 font-medium">
                <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{data.branch ?? "detached HEAD"}</span>
              </span>
            </Tip>
            <Tip label={`Compared with ${base}${data.base ? ` (from ${data.base.source})` : ""}. Click to change.`}>
              <Button variant="ghost" size="sm" className="h-7 px-1.5 font-normal text-muted-foreground" onClick={() => setDialog("base")}>
                <GitCompareArrowsIcon /> {base}
              </Button>
            </Tip>
            <Tip label={`${data.ahead} commit${data.ahead === 1 ? "" : "s"} ahead of ${base}, ${data.behind} behind`}>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground tabular-nums">
                <span className="inline-flex items-center">
                  <ArrowUpIcon className="size-3.5" />
                  {data.ahead}
                </span>
                <span className="inline-flex items-center">
                  <ArrowDownIcon className="size-3.5" />
                  {data.behind}
                </span>
              </span>
            </Tip>
            {data.dirty && (
              <Tip label="Uncommitted changes">
                <span className="inline-flex items-center gap-1 text-warn">
                  <CircleDotIcon className="size-3.5" /> <span className="max-sm:sr-only">uncommitted</span>
                </span>
              </Tip>
            )}
            {busy && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <LoaderCircleIcon className="size-3.5 animate-spin" /> {busy}…
              </span>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Lines shown"
            value={diffView.fullFile ? "full" : "changes"}
            onValueChange={(v) => v && changeDiffView({ fullFile: v === "full" })}
          >
            <Tip label="Only changes, with a few lines around them">
              <ToggleGroupItem className={checkedItem} value="changes" aria-label="Changes only">
                <FoldVerticalIcon />
              </ToggleGroupItem>
            </Tip>
            <Tip label="Full file">
              <ToggleGroupItem className={checkedItem} value="full" aria-label="Full file">
                <UnfoldVerticalIcon />
              </ToggleGroupItem>
            </Tip>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Layout"
            value={diffView.split ? "split" : "unified"}
            onValueChange={(v) => v && changeDiffView({ split: v === "split" })}
          >
            <Tip label="Unified: one column">
              <ToggleGroupItem className={checkedItem} value="unified" aria-label="Unified">
                <Rows2Icon />
              </ToggleGroupItem>
            </Tip>
            <Tip label="Split: old and new side by side">
              <ToggleGroupItem className={checkedItem} value="split" aria-label="Split">
                <Columns2Icon />
              </ToggleGroupItem>
            </Tip>
          </ToggleGroup>
          <Tip label="Comments for the agent">
            <Button variant="outline" size="sm" aria-label="Comments for the agent" onClick={() => setDialog("comments")}>
              <MessageSquareIcon /> {comments.length}
            </Button>
          </Tip>
          <DropdownMenu>
            <Tip label="Commit, update, merge and publish">
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={!!busy}>
                  <GitForkIcon /> Git <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end" className="w-64">
              <GitItem icon={<GitCommitHorizontalIcon />} label="Commit…" blocker={commitBlocker} onSelect={() => setDialog("commit")} />
              <GitItem icon={<ArrowDownToLineIcon />} label={`Update from ${base}`} blocker={updateBlocker} onSelect={update} />
              <GitItem icon={<GitMergeIcon />} label={`Merge into ${base}…`} blocker={mergeBlocker} onSelect={() => setDialog("merge")} />
              <DropdownMenuSeparator />
              <GitItem
                icon={<GitPullRequestArrowIcon />}
                label={publish.info?.pr ? "Update pull request…" : "Publish…"}
                blocker={publish.blocker}
                onSelect={() => setDialog("publish")}
              />
              {publish.info?.pr && (
                <DropdownMenuItem asChild>
                  <a href={publish.info.pr} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon /> View pull request
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <GitItem icon={<GitCompareArrowsIcon />} label="Compare with…" onSelect={() => setDialog("base")} />
            </DropdownMenuContent>
          </DropdownMenu>
          <Tip label="Refresh">
            <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={loading} onClick={load}>
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
            </Button>
          </Tip>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && <OkBanner>{notice}</OkBanner>}
      {published && (
        <OkBanner>
          <span>
            {published.notice ? `${published.notice} ` : ""}Pushed from {published.pushedFrom === "host" ? "this machine" : "the container"}.
          </span>
          {published.openUrl && (
            <a className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline" href={published.openUrl} target="_blank" rel="noreferrer">
              {published.prUrl ? "Open pull request" : "Create the pull request on the forge"} <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </OkBanner>
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
                run("Asking", async () => {
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

      {dialog === "commit" && (
        <CommitDialog
          projectId={projectId}
          directory={directory}
          onClose={() => setDialog(undefined)}
          onCommitted={() => {
            setNotice("Committed.");
            load();
          }}
        />
      )}
      {dialog === "merge" && baseName && data && (
        <MergeDialog branch={data.branch} base={baseName} ahead={data.ahead} onClose={() => setDialog(undefined)} onMerge={merge} />
      )}
      {dialog === "publish" && publish.info && (
        <PublishDialog
          projectId={projectId}
          directory={directory}
          info={publish.info}
          loadInfo={publish.loadInfo}
          baseName={baseName}
          onClose={() => setDialog(undefined)}
          onPublished={(r) => {
            setPublished(r);
            load();
          }}
        />
      )}
      {dialog === "base" && <BaseDialog current={baseOverride ?? baseName} options={baseOptions} onClose={() => setDialog(undefined)} onChange={setBaseOverride} />}
      {dialog === "comments" && (
        <CommentsDialog
          comments={comments}
          sent={sent}
          sessions={[
            ...sessions.map((s) => ({ value: s.id, label: `${s.title}${s.status === "running" ? " (working, queued)" : ""}` })),
            { value: "new", label: "New session" },
          ]}
          session={chosen}
          busy={!!busy}
          onSession={setSessionChoice}
          onAdd={(text) => saveComments([...comments, { id: newId(), text }])}
          onDelete={deleteComment}
          onSend={() => {
            sendComments();
            setDialog(undefined);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}

      {!data && !error && <ReviewSkeleton />}
      {data && data.files.length === 0 && <p className={muted}>No changes compared with {baseName ?? "the last commit"}.</p>}
      {data && data.files.length > 0 && (
        <div className={cn("grid items-start gap-4", !diffView.hideFiles && "md:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)]")}>
          {!diffView.hideFiles && (
            <Card className="sticky top-16 overflow-hidden py-0 max-md:static">
              <ChangedFilesTree
                files={data.files}
                onSelect={(file) => {
                  const index = data.files.findIndex((f) => f.file === file);
                  document.getElementById(`review-file-${index}`)?.scrollIntoView({ block: "start" });
                }}
              />
            </Card>
          )}
          <div className="flex min-w-0 flex-col gap-3">
            {data.files.map((f, i) => (
              <FileDiff
                key={`${diffKey(f)}:${baseName}`}
                id={`review-file-${i}`}
                file={f}
                load={() => fetchReview(projectId, directory, { base: baseOverride, file: f.file }).then((d) => d.files[0]?.patch)}
                view={diffView}
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

/** The tooltip trigger takes over `data-state`, so a toggle inside one shows its selection from `aria-checked`. */
const checkedItem = "aria-checked:bg-accent aria-checked:text-accent-foreground";

/** A tooltip on any element; the child must take a ref (a DOM element or a forwarding component). */
function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A git menu entry; when it can't run, it is disabled and says why. */
function GitItem(props: { icon: ReactNode; label: string; blocker?: string; onSelect: () => void }) {
  return (
    <DropdownMenuItem disabled={!!props.blocker} onSelect={props.onSelect} className="items-start [&_svg]:mt-0.5">
      {props.icon}
      <span className="flex min-w-0 flex-col">
        {props.label}
        {props.blocker && <span className="text-xs text-muted-foreground">{props.blocker}</span>}
      </span>
    </DropdownMenuItem>
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
  view: DiffView;
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
          name={file.file}
          split={props.view.split}
          fullFile={props.view.fullFile}
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
