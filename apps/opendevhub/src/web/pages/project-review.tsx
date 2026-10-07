import { useStableCallback } from "@pierre/diffs/react";
import type {
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs/react";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  DownloadIcon,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import type { JiraTaskSource } from "../../shared/jira";
import type {
  ProjectView,
  PublishResult,
  ReviewData,
  ReviewFile,
  ReviewMode,
  UpdateResult,
} from "../../shared/types";
import {
  bringHome,
  fetchReview,
  mergeIntoBase,
  removeWorktree,
  sendPrompt,
  startSession,
  updateFromBase,
} from "../api";
import { fixPrompt, publishWarning, STATE_LABEL } from "../checks";
import { ChecksIcon, ChecksPanel, useChecks } from "../components/ChecksPanel";
import { JiraSourceCard } from "../components/JiraSourceCard";
import { ChangedFilesTree } from "../components/LazyChangedFilesTree";
import { PatchView } from "../components/LazyPatchView";
import { diffFont, Empty, muted } from "../components/Page";
import { PublishDialog, usePublishInfo } from "../components/PublishDialog";
import {
  BaseDialog,
  CommentsDialog,
  CommitDialog,
  MergeDialog,
} from "../components/ReviewDialogs";
import { DiffLinesSkeleton, ReviewSkeleton } from "../components/Skeletons";
import { Tip } from "../components/Tip";
import { workspaceFolderOf } from "../derive";
import {
  aheadHint,
  anchorFromRange,
  annotationsFor,
  composeReviewPrompt,
  conflictPrompt,
  diffKey,
  draftKey,
  linesLabel,
  newId,
  readComments,
  readDiffView,
  readReviewMode,
  selectionFor,
  sentKey,
  writeComments,
  writeDiffView,
  writeReviewMode,
} from "../review";
import type {
  DiffView,
  LineAnchor,
  ReviewAnnotation,
  ReviewComment,
} from "../review";
import { useCheckout } from "./CheckoutPage";

// oxlint-disable-next-line complexity
const ReviewTarget = ({
  view,
  directory,
  target,
}: {
  view: ProjectView;
  directory: string;
  target: string;
}) => {
  const navigate = useNavigate();
  const projectId = view.project.id;
  const isWorktree = directory !== workspaceFolderOf(view);
  const remoteNode = view.runtime.worktrees?.find(
    (w) => w.path === directory
  )?.node;

  const [baseOverride, setBaseOverride] = useState<string>();
  // The diff shown: uncommitted changes, or everything since the base; remembered per checkout.
  const [mode, setMode] = useState(() => readReviewMode(projectId, target));
  const changeMode = (next: ReviewMode) => {
    setMode(next);
    writeReviewMode(projectId, target, next);
  };
  const [, setBaseInput] = useState("");
  const [data, setData] = useState<ReviewData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(() => {
    setLoading(true);
    fetchReview(projectId, directory, { base: baseOverride, mode })
      .then(
        (d) => {
          setData(d);
          setError(undefined);
        },
        (err) => setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setLoading(false));
  }, [projectId, directory, baseOverride, mode]);
  useEffect(load, [load]);

  // Refresh when an agent working here finishes its turn.
  const runningHere = view.sessions
    .filter((s) => s.directory === directory && s.status === "running")
    .map((s) => s.id)
    .toSorted()
    .join(",");
  const previous = useRef(runningHere);
  useEffect(() => {
    const before = previous.current.split(",").filter(Boolean);
    previous.current = runningHere;
    const now = new Set(runningHere.split(",").filter(Boolean));
    if (before.some((id) => !now.has(id))) {
      load();
    }
  }, [runningHere, load]);

  const baseName = data?.base?.name;
  useEffect(() => setBaseInput(baseName ?? ""), [baseName]);

  // Comments: drafts per project, target and diff; sent ones per target.
  const shownMode = data?.mode ?? mode;
  const key = draftKey(projectId, target, shownMode, baseName);
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
  const [sent, setSent] = useState<ReviewComment[]>(() =>
    readComments(sentKey(projectId, target))
  );
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();
  const [diffView, setDiffView] = useState(readDiffView);
  const changeDiffView = (change: Partial<DiffView>) => {
    const next = { ...diffView, ...change };
    setDiffView(next);
    writeDiffView(next);
  };

  const sessions = useMemo(
    () =>
      view.sessions
        .filter((s) => s.directory === directory)
        .toSorted((a, b) => b.updatedAt - a.updatedAt),
    [view.sessions, directory]
  );
  const ticketSources = new Map<string, JiraTaskSource>();
  for (const session of sessions) {
    const source = session.task?.jira;
    if (source && !session.task?.discarded) {
      ticketSources.set(`${source.instanceUrl}/${source.key}`, source);
    }
  }
  const [sessionChoice, setSessionChoice] = useState("");
  const chosen = sessionChoice || sessions[0]?.id || "new";

  const run = (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setNotice(undefined);
    fn()
      .then(
        () => setError(undefined),
        (err) => setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setBusy(undefined));
  };

  const deliver = (text: string) =>
    chosen === "new"
      ? startSession(
          projectId,
          directory,
          data?.branch ? `Review of ${data.branch}` : "Review",
          text
        ).then(() => undefined)
      : sendPrompt(projectId, chosen, text);

  const sendComments = () =>
    run("Sending", async () => {
      await deliver(
        composeReviewPrompt({
          base: baseName,
          branch: data?.branch,
          comments,
          uncommitted: shownMode === "working",
        })
      );
      const nextSent = [...sent, ...comments];
      setSent(nextSent);
      writeComments(sentKey(projectId, target), nextSent);
      saveComments([]);
      setNotice(
        `Sent ${comments.length} comment${comments.length === 1 ? "" : "s"} to the agent.`
      );
    });

  const addLineComment = useCallback(
    (file: string, anchor: LineAnchor, text: string) => {
      saveComments([
        ...commentsRef.current,
        {
          file,
          id: newId(),
          line: anchor.line,
          quote: anchor.quote,
          side: anchor.side,
          start: anchor.start,
          startSide: anchor.startSide,
          text,
        },
      ]);
      setOpen(undefined);
    },
    [saveComments]
  );
  const cancelLineComment = useCallback(() => setOpen(undefined), []);
  const deleteComment = useCallback(
    (id: string) =>
      saveComments(commentsRef.current.filter((c) => c.id !== id)),
    [saveComments]
  );

  // Git actions: each opens a dialog, or runs at once when there is nothing to choose.
  const [dialog, setDialog] = useState<
    "commit" | "merge" | "publish" | "base" | "comments"
  >();
  const [conflicts, setConflicts] = useState<UpdateResult>();
  const [merged, setMerged] = useState<string>();
  const [published, setPublished] = useState<PublishResult>();
  const publish = usePublishInfo(projectId, directory, data);

  // Checks: reloaded with the review (a commit makes the last run out of date), shown when they run or fail.
  const checks = useChecks(projectId, directory);
  const reloadChecks = checks.load;
  useEffect(() => {
    if (data) {
      void reloadChecks();
    }
  }, [data, reloadChecks]);
  const [checksOpen, setChecksOpen] = useState(false);
  useEffect(() => {
    if (checks.state === "running" || checks.state === "failed") {
      setChecksOpen(true);
    }
  }, [checks.state]);
  const hasChecks =
    checks.state !== "none" || (checks.view?.errors.length ?? 0) > 0;

  const fetchHome = () =>
    run("Bringing home", async () => {
      const { branch } = await bringHome(projectId, directory);
      setNotice(
        `Fetched ${branch} from ${remoteNode} into this machine's repository.`
      );
      load();
    });
  const update = () =>
    run("Updating", async () => {
      if (!baseName) {
        return;
      }
      const result = await updateFromBase(projectId, directory, baseName);
      setConflicts(result.conflicts ? result : undefined);
      if (!result.conflicts) {
        setNotice(`Updated from ${baseName} (${result.strategy}).`);
      }
      load();
    });
  const merge = (ffOnly: boolean) =>
    run("Merging", async () => {
      if (!baseName) {
        return;
      }
      const { branch } = await mergeIntoBase(
        projectId,
        directory,
        baseName,
        ffOnly
      );
      setMerged(branch);
      setNotice(`Merged ${branch} into ${baseName}.`);
      load();
    });
  const removeMerged = () =>
    run("Removing", async () => {
      await removeWorktree(projectId, directory, false, true);
      void navigate(`/p/${encodeURIComponent(projectId)}`);
    });

  const baseOptions = [
    ...new Set(
      [
        baseName,
        data?.workspace.branch,
        ...(view.runtime.worktrees ?? []).map((w) => w.branch),
      ].filter(Boolean)
    ),
  ] as string[];

  let commitBlocker;
  if (data) {
    if (data.dirty) {
      commitBlocker = undefined;
    } else {
      commitBlocker = "No uncommitted changes";
    }
  } else {
    commitBlocker = "Loading…";
  }
  let updateBlocker;
  if (data) {
    if (!baseName || !data.branch) {
      updateBlocker = "No base branch";
    } else if (data.dirty) {
      updateBlocker = "Commit the changes first";
    } else if (data.behind === 0) {
      updateBlocker = `Already up to date with ${baseName}`;
    } else {
      updateBlocker = undefined;
    }
  } else {
    updateBlocker = "Loading…";
  }
  let mergeBlocker;
  if (data) {
    if (isWorktree) {
      if (data.ahead === 0) {
        mergeBlocker = "Nothing to merge";
      } else if (data.dirty) {
        mergeBlocker = "Commit the changes first";
      } else if (data.workspace.clean) {
        if (data.workspace.branch === baseName) {
          mergeBlocker = undefined;
        } else {
          mergeBlocker = `The main checkout is on ${data.workspace.branch ?? "a detached HEAD"}, not ${baseName}`;
        }
      } else {
        mergeBlocker = "The main checkout has uncommitted changes";
      }
    } else {
      mergeBlocker = "The main checkout is the base";
    }
  } else {
    mergeBlocker = "Loading…";
  }
  const base = baseName ?? "base";
  const conflictInfo =
    conflicts?.conflicts && data?.branch && baseName
      ? {
          base: baseName,
          branch: data.branch,
          files: conflicts.conflicts,
          strategy: conflicts.strategy,
        }
      : undefined;

  return (
    <div className="flex flex-col gap-4">
      {[...ticketSources].map(([id, source]) => (
        <JiraSourceCard key={id} source={source} />
      ))}
      <div className="bg-background/95 sticky top-0 z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 backdrop-blur max-md:top-[45px] md:-mx-8 md:px-8">
        <Tip
          label={
            diffView.hideFiles ? "Show changed files" : "Hide changed files"
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              diffView.hideFiles ? "Show changed files" : "Hide changed files"
            }
            aria-pressed={!diffView.hideFiles}
            onClick={() => changeDiffView({ hideFiles: !diffView.hideFiles })}
          >
            {diffView.hideFiles ? (
              <PanelLeftOpenIcon />
            ) : (
              <PanelLeftCloseIcon />
            )}
          </Button>
        </Tip>
        {!data && !error && <Skeleton className="h-5 w-48" />}
        {data && (
          <div className="contents text-sm">
            <Tip label="Current branch">
              <span className="inline-flex min-w-0 items-center gap-1 font-medium">
                <GitBranchIcon className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">
                  {data.branch ?? "detached HEAD"}
                </span>
              </span>
            </Tip>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label="Changes shown"
              value={data.mode}
              onValueChange={(v) => v && changeMode(v as ReviewMode)}
            >
              <Tip label="Uncommitted changes, like git diff">
                <ToggleGroupItem
                  className={cn(checkedItem, "font-normal")}
                  value="working"
                >
                  Uncommitted
                </ToggleGroupItem>
              </Tip>
              <Tip
                label={
                  data.base
                    ? `Everything since ${base} (from ${data.base.source}), committed or not.${data.mode === "branch" ? " Click to change the base." : ""}`
                    : "No base branch to compare with"
                }
              >
                <ToggleGroupItem
                  className={cn(checkedItem, "font-normal")}
                  value="branch"
                  aria-label={`Compare with ${base}`}
                  disabled={!data.base}
                  onClick={() => data.mode === "branch" && setDialog("base")}
                >
                  <GitCompareArrowsIcon /> {base}
                </ToggleGroupItem>
              </Tip>
            </ToggleGroup>
            <Tip
              label={`${data.ahead} commit${data.ahead === 1 ? "" : "s"} ahead of ${base}, ${data.behind} behind`}
            >
              <span className="text-muted-foreground inline-flex items-center gap-1.5 tabular-nums">
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
                <span className="text-warn inline-flex items-center gap-1">
                  <CircleDotIcon className="size-3.5" />{" "}
                  <span className="max-sm:sr-only">uncommitted</span>
                </span>
              </Tip>
            )}
            {busy && (
              <span className="text-muted-foreground inline-flex items-center gap-1">
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
            onValueChange={(v) =>
              v && changeDiffView({ fullFile: v === "full" })
            }
          >
            <Tip label="Only changes, with a few lines around them">
              <ToggleGroupItem
                className={checkedItem}
                value="changes"
                aria-label="Changes only"
              >
                <FoldVerticalIcon />
              </ToggleGroupItem>
            </Tip>
            <Tip label="Full file">
              <ToggleGroupItem
                className={checkedItem}
                value="full"
                aria-label="Full file"
              >
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
              <ToggleGroupItem
                className={checkedItem}
                value="unified"
                aria-label="Unified"
              >
                <Rows2Icon />
              </ToggleGroupItem>
            </Tip>
            <Tip label="Split: old and new side by side">
              <ToggleGroupItem
                className={checkedItem}
                value="split"
                aria-label="Split"
              >
                <Columns2Icon />
              </ToggleGroupItem>
            </Tip>
          </ToggleGroup>
          {hasChecks && (
            <Tip
              label={`${STATE_LABEL[checks.state]}. Click to ${checksOpen ? "hide" : "show"} them.`}
            >
              <Button
                variant="outline"
                size="sm"
                aria-pressed={checksOpen}
                onClick={() => setChecksOpen((o) => !o)}
              >
                <ChecksIcon state={checks.state} />{" "}
                <span className="max-sm:sr-only">Checks</span>
              </Button>
            </Tip>
          )}
          <Tip label="Comments for the agent">
            <Button
              variant="outline"
              size="sm"
              aria-label="Comments for the agent"
              onClick={() => setDialog("comments")}
            >
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
              <GitItem
                icon={<GitCommitHorizontalIcon />}
                label="Commit…"
                blocker={commitBlocker}
                onSelect={() => setDialog("commit")}
              />
              <GitItem
                icon={<ArrowDownToLineIcon />}
                label={`Update from ${base}`}
                blocker={updateBlocker}
                onSelect={update}
              />
              <GitItem
                icon={<GitMergeIcon />}
                label={`Merge into ${base}…`}
                blocker={mergeBlocker}
                onSelect={() => setDialog("merge")}
              />
              {remoteNode && (
                <GitItem
                  icon={<DownloadIcon />}
                  label={`Bring home from ${remoteNode}`}
                  blocker={data ? undefined : "Loading…"}
                  onSelect={fetchHome}
                />
              )}
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
              <GitItem
                icon={<GitCompareArrowsIcon />}
                label="Compare with…"
                onSelect={() => setDialog("base")}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <Tip label="Refresh">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              disabled={loading}
              onClick={load}
            >
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
            </Button>
          </Tip>
        </div>
      </div>

      {checksOpen && hasChecks && (
        <ChecksPanel
          checks={checks}
          busy={!!busy}
          onClose={() => setChecksOpen(false)}
          onFix={(results) =>
            run("Asking", async () => {
              await deliver(fixPrompt({ branch: data?.branch, results }));
              setNotice("Asked the agent to fix the failed checks.");
            })
          }
        />
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && <OkBanner>{notice}</OkBanner>}
      {published && (
        <OkBanner>
          <span>
            {published.notice ? `${published.notice} ` : ""}Pushed from{" "}
            {published.pushedFrom === "host" ? "this machine" : "the container"}
            .
          </span>
          {published.openUrl && (
            <a
              className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
              href={published.openUrl}
              target="_blank"
              rel="noreferrer"
            >
              {published.prUrl
                ? "Open pull request"
                : "Create the pull request on the forge"}{" "}
              <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </OkBanner>
      )}

      {conflictInfo && (
        <Alert className="border-warn/40 bg-warn/10">
          <AlertDescription className="text-warn flex flex-wrap items-center justify-between gap-3">
            <span>
              {conflictInfo.strategy === "rebase" ? "Rebasing" : "Merging"}{" "}
              conflicts in {conflictInfo.files.join(", ")}. Nothing was changed.
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                run("Asking", async () => {
                  await deliver(
                    conflictPrompt({
                      base: conflictInfo.base,
                      branch: conflictInfo.branch,
                      files: conflictInfo.files,
                      strategy: conflictInfo.strategy,
                    })
                  );
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
          <span>
            {merged} is merged. Remove its worktree and delete the branch?
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!!busy}
            onClick={removeMerged}
          >
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
        <MergeDialog
          branch={data.branch}
          base={baseName}
          ahead={data.ahead}
          onClose={() => setDialog(undefined)}
          onMerge={merge}
        />
      )}
      {dialog === "publish" && publish.info && (
        <PublishDialog
          projectId={projectId}
          directory={directory}
          info={publish.info}
          loadInfo={publish.loadInfo}
          baseName={baseName}
          checksWarning={publishWarning(checks.view)}
          onClose={() => setDialog(undefined)}
          onPublished={(r) => {
            setPublished(r);
            load();
          }}
        />
      )}
      {dialog === "base" && (
        <BaseDialog
          current={baseOverride ?? baseName}
          options={baseOptions}
          onClose={() => setDialog(undefined)}
          onChange={(b) => {
            setBaseOverride(b);
            changeMode("branch");
          }}
        />
      )}
      {dialog === "comments" && (
        <CommentsDialog
          comments={comments}
          sent={sent}
          sessions={[
            ...sessions.map((s) => ({
              label: `${s.title}${s.status === "running" ? " (working, queued)" : ""}`,
              value: s.id,
            })),
            { label: "New session", value: "new" },
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
      {data && data.files.length === 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className={muted}>
            {data.mode === "branch"
              ? `No changes compared with ${base}.`
              : "No uncommitted changes."}{" "}
            {aheadHint(data)}
          </p>
          {aheadHint(data) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => changeMode("branch")}
            >
              <GitCompareArrowsIcon /> Compare with {base}
            </Button>
          )}
        </div>
      )}
      {data && data.files.length > 0 && (
        <div
          className={cn(
            "grid items-start gap-4",
            !diffView.hideFiles &&
              "md:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)]"
          )}
        >
          {!diffView.hideFiles && (
            <Card className="sticky top-16 overflow-hidden py-0 max-md:static">
              <ChangedFilesTree
                files={data.files}
                onSelect={(file) => {
                  const index = data.files.findIndex((f) => f.file === file);
                  document
                    .getElementById(`review-file-${index}`)
                    ?.scrollIntoView({ block: "start" });
                }}
              />
            </Card>
          )}
          <div className="flex min-w-0 flex-col gap-3">
            {data.files.map((f, i) => (
              <FileDiff
                key={`${diffKey(f)}:${data.mode}:${baseName}`}
                id={`review-file-${i}`}
                file={f}
                load={() =>
                  fetchReview(projectId, directory, {
                    base: baseOverride,
                    file: f.file,
                    mode,
                  }).then((d) => d.files[0]?.patch)
                }
                view={diffView}
                comments={comments}
                open={open?.file === f.file ? open.anchor : undefined}
                onAnchor={(anchor) => setOpen({ anchor, file: f.file })}
                onAdd={addLineComment}
                onCancel={cancelLineComment}
                onDelete={deleteComment}
              />
            ))}
          </div>
        </div>
      )}
      {data?.truncated && (
        <p className={muted}>
          Some diffs are too large to load at once; open them one by one.
        </p>
      )}
    </div>
  );
};

export const ProjectReview = () => {
  const { view, checkout } = useCheckout();
  const ready =
    view.runtime.containerState === "running" &&
    view.runtime.opencode === "healthy";
  if (!ready) {
    return (
      <Empty title="Not running">
        <p className={muted}>
          Start the project to review what its agents changed.
        </p>
      </Empty>
    );
  }
  return (
    <ReviewTarget
      key={checkout.directory}
      view={view}
      directory={checkout.directory}
      target={checkout.target}
    />
  );
};

/** The tooltip trigger takes over `data-state`, so a toggle inside one shows its selection from `aria-checked`. */
const checkedItem =
  "aria-checked:bg-accent aria-checked:text-accent-foreground";

/** A git menu entry; when it can't run, it is disabled and says why. */
const GitItem = (props: {
  icon: ReactNode;
  label: string;
  blocker?: string;
  onSelect: () => void;
}) => (
  <DropdownMenuItem
    disabled={!!props.blocker}
    onSelect={props.onSelect}
    className="items-start [&_svg]:mt-0.5"
  >
    {props.icon}
    <span className="flex min-w-0 flex-col">
      {props.label}
      {props.blocker && (
        <span className="text-muted-foreground text-xs">{props.blocker}</span>
      )}
    </span>
  </DropdownMenuItem>
);

const OkBanner = ({ children }: { children: ReactNode }) => (
  <Alert className="border-ok/40 bg-ok/10">
    <AlertDescription className="text-ok flex flex-wrap items-center justify-between gap-3">
      {children}
    </AlertDescription>
  </Alert>
);

const FileDiff = (props: {
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
}) => {
  const { file } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [patch, setPatch] = useState(file.patch);
  const [loading, setLoading] = useState(false);
  // @pierre/diffs wants stable callbacks and annotations; these read the latest props.
  const onComment = useStableCallback((range: SelectedLineRange) => {
    if (patch !== undefined) {
      props.onAnchor(anchorFromRange(patch, range));
    }
  });
  const annotations = useMemo(
    () => annotationsFor(props.comments, file.file, props.open),
    [props.comments, file.file, props.open]
  );
  const selectedLines = useMemo(() => selectionFor(props.open), [props.open]);
  const renderAnnotation = useStableCallback(
    (a: DiffLineAnnotation<ReviewAnnotation>) => {
      if (a.metadata.kind === "draft") {
        const { anchor } = a.metadata;
        return (
          <CommentForm
            anchor={anchor}
            onAdd={(text) => props.onAdd(file.file, anchor, text)}
            onCancel={props.onCancel}
          />
        );
      }
      return (
        <div className="border-primary bg-card text-card-foreground mx-2 my-1 flex items-start gap-2 rounded-sm border-l-3 px-2.5 py-2 font-sans text-sm whitespace-pre-wrap">
          <span>
            {a.metadata.comment.start !== undefined && (
              <span className="text-muted-foreground">
                Lines {linesLabel(a.metadata.comment)}:{" "}
              </span>
            )}
            {a.metadata.comment.text}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground ml-auto"
            aria-label="Delete comment"
            onClick={() =>
              props.onDelete(
                a.metadata.kind === "comment" ? a.metadata.comment.id : ""
              )
            }
          >
            <XIcon />
          </Button>
        </div>
      );
    }
  );
  const toggle = useStableCallback(() => (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground inline-flex items-center pr-1"
      onClick={() => setCollapsed((c) => !c)}
      aria-expanded={!collapsed}
      title={collapsed ? "Show diff" : "Hide diff"}
    >
      {collapsed ? (
        <ChevronRightIcon className="size-3.5" />
      ) : (
        <ChevronDownIcon className="size-3.5" />
      )}
    </button>
  ));

  // A collapsed diff shows only its header: @pierre/diffs parses and highlights the whole patch even when
  // collapsed, which for a lockfile or a generated spec blocks the page for seconds.
  if (patch !== undefined && !file.binary && collapsed) {
    return (
      <Card
        className={cn("gap-0 overflow-hidden py-0", diffFont)}
        id={props.id}
      >
        <header className="bg-muted/50 flex items-center gap-2 px-3 py-1.5">
          {toggle()}
          <span className="min-w-0 truncate font-mono text-sm">
            {file.file}
          </span>
          <span className="ml-auto font-mono text-xs whitespace-nowrap">
            <span className="text-ok">+{file.additions}</span>{" "}
            <span className="text-destructive">−{file.deletions}</span>
          </span>
        </header>
      </Card>
    );
  }
  if (patch !== undefined && !file.binary) {
    return (
      <Card className={cn("overflow-hidden py-0", diffFont)} id={props.id}>
        <PatchView<ReviewAnnotation>
          patch={patch}
          name={file.file}
          split={props.view.split}
          fullFile={props.view.fullFile}
          onComment={onComment}
          annotations={annotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={toggle}
        />
      </Card>
    );
  }
  const pendingBody = loading ? (
    <DiffLinesSkeleton />
  ) : (
    <p className="flex items-center gap-3 px-3 py-2.5">
      {file.large && (
        <span className="text-muted-foreground text-sm">
          Large diff, not loaded with the others.
        </span>
      )}
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
  );
  return (
    <Card className="gap-0 overflow-hidden py-0" id={props.id}>
      <header className="bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="font-mono text-sm">{file.file}</span>
        <span className="font-mono text-xs whitespace-nowrap">
          <span className="text-ok">+{file.additions}</span>{" "}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </header>
      {file.binary ? (
        <p className="text-muted-foreground px-3 py-2.5 text-sm">binary</p>
      ) : (
        pendingBody
      )}
    </Card>
  );
};

/** The comment box inside the diff. Keeps its own text so typing doesn't re-render the whole diff. */
const CommentForm = (props: {
  anchor: LineAnchor;
  onAdd: (text: string) => void;
  onCancel: () => void;
}) => {
  const [text, setText] = useState("");
  // The gutter button keeps focus through the click that opened this box, so focus it once that settles.
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <form
      className="bg-card text-card-foreground mx-2 my-1 flex flex-col gap-2 rounded-md border p-2 font-sans text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) {
          props.onAdd(text.trim());
        }
      }}
    >
      {props.anchor.start !== undefined && (
        <span className="text-muted-foreground">
          Lines {linesLabel(props.anchor)}
        </span>
      )}
      <Textarea
        ref={input}
        className="min-h-0"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            props.onCancel();
          }
        }}
        placeholder="Comment for the agent…"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!text.trim()}>
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};
