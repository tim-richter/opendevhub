import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@opendevhub/ui/dropdown-menu";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowDownToLineIcon,
  BotIcon,
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitCompareArrowsIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  ScanSearchIcon,
  SparklesIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import type { JiraTaskSource } from "../../../shared/jira";
import type {
  ProjectView,
  PublishResult,
  ReviewFile,
  ReviewMode,
  StageAction,
  UpdateResult,
} from "../../../shared/types";
import {
  bringHome,
  fetchReview,
  reviewImageUrl,
  suggestCommitMessage,
  mergeIntoBase,
  removeWorktree,
  sendPrompt,
  startSession,
  updateFromBase,
} from "../../api";
import { Empty, ErrorText, muted } from "../../components/page";
import { ReviewSkeleton } from "../../components/skeletons";
import { workspaceFolderOf } from "../../derive";
import { useNavigate } from "../../routing";
import { useCheckoutContext } from "../checkouts/checkout-context";
import { fixPrompt, publishWarning, STATE_LABEL } from "../checks/checks";
import { ChecksIcon, ChecksPanel, useChecks } from "../checks/checks-panel";
import {
  placeAiFindings,
  suggestionComment,
  withSuggestion,
} from "../forgejo/forgejo";
import { AiReviewPanel, AiSuggestionCard } from "../forgejo/forgejo-ai-review";
import { JiraSourceCard } from "../jira/jira-source-card";
import { ProjectSettingsDialog } from "../projects/project-settings-dialog";
import { OCR_SECTION, useProjectOcr } from "../settings/ocr-settings";
import { SettingsLink } from "../settings/settings-link";
import { variantOf } from "../tasks/tasks";
import { FileGroups } from "./file-groups";
import { useLocalAiReview } from "./local-ai-review";
import { gitBlockers, nextStep } from "./next-step";
import { PublishDialog, usePublishInfo } from "./publish-dialog";
import {
  aheadHint,
  composeReviewPrompt,
  conflictPrompt,
  draftKey,
  diffKey,
  isViewed,
  markViewed,
  newId,
  readComments,
  readDiffView,
  readReviewMode,
  readViewed,
  sentKey,
  viewedKey,
  writeComments,
  writeDiffView,
  writeReviewMode,
  writeViewed,
} from "./review";
import type {
  DiffView,
  LineAnchor,
  ReviewComment,
  ViewedFiles,
} from "./review";
import { BaseDialog, CommentsDialog, MergeDialog } from "./review-dialogs";
import { ReviewDiffs } from "./review-diffs";
import {
  publishInfoQuery,
  refreshCheckout,
  reviewQuery,
} from "./review-queries";
import { ReviewSidebar } from "./review-sidebar";
import { ReviewToolbar } from "./review-toolbar";
import { pickSelection, selectionAfter } from "./stage";
import type { Selection, StageChange } from "./stage";
import { ChangeSections, useStage } from "./stage-view";
import type { DiffListProps } from "./stage-view";
import { StepPanel } from "./step-panel";

// oxlint-disable-next-line complexity
const ReviewTarget = ({
  view,
  directory,
  target,
  sessionId,
}: {
  view: ProjectView;
  directory: string;
  target: string;
  /** The conversation comments go to unless the user picks another; else the latest in the checkout. */
  sessionId?: string;
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
  const [notice, setNotice] = useState<string>();

  // Agents finishing a turn here refresh it too (see useRefreshFinishedCheckouts).
  const queryClient = useQueryClient();
  const review = useQuery({
    ...reviewQuery(projectId, directory, { base: baseOverride, mode }),
    // Keep the last diff on screen while another mode or base loads.
    placeholderData: keepPreviousData,
  });
  const { data } = review;
  const ai = useLocalAiReview({ projectId, directory, data, sessionId });
  const ocr = useProjectOcr(projectId);
  const [projectSettings, setProjectSettings] = useState(false);
  const loading = review.isFetching;
  const refresh = useCallback(
    () => void refreshCheckout(queryClient, projectId, directory),
    [queryClient, projectId, directory]
  );

  // Git actions and messages to the agent, one at a time; the label says which is running.
  const action = useMutation({
    mutationFn: ({ fn }: { label: string; fn: () => Promise<unknown> }) => fn(),
    onMutate: () => setNotice(undefined),
  });
  const run = (label: string, fn: () => Promise<unknown>) =>
    action.mutate({ fn, label });
  const busy = action.isPending ? action.variables.label : undefined;
  const error = action.error ?? review.error ?? undefined;

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
  const keyRef = useRef(key);
  useLayoutEffect(() => {
    commentsRef.current = comments;
    keyRef.current = key;
  }, [comments, key]);
  const saveComments = useCallback((next: ReviewComment[]) => {
    commentsRef.current = next;
    setComments(next);
    writeComments(keyRef.current, next);
  }, []);
  // Viewed files per diff, like the drafts; a mark lapses when its file's diff changes.
  const viewedStorageKey = viewedKey(projectId, target, shownMode, baseName);
  const [viewed, setViewed] = useState<ViewedFiles>({});
  useEffect(() => setViewed(readViewed(viewedStorageKey)), [viewedStorageKey]);
  const changeViewed = (file: ReviewFile, on: boolean) => {
    const next = markViewed(viewed, data?.files ?? [], file, on);
    setViewed(next);
    writeViewed(viewedStorageKey, next);
  };
  const viewedCount =
    data?.files.filter((f) => isViewed(viewed, f)).length ?? 0;
  const revision = data
    ? `${data.mode === "branch" ? `branch:${data.base?.name ?? ""}` : "working"}:${data.files.map(diffKey).join("|")}`
    : undefined;
  const staleReview =
    !!data && ai.run?.stage === "done" && ai.run.revision !== revision;
  const reviewRun =
    ai.run?.stage === "done" && !staleReview ? ai.run : undefined;
  const placed = useMemo(
    () =>
      placeAiFindings(
        reviewRun?.findings ?? [],
        data?.files ?? [],
        `local-${reviewRun?.id ?? ""}`
      ),
    [reviewRun?.findings, reviewRun?.id, data?.files]
  );
  const handled = new Set(reviewRun?.handled);
  const inlineAi = placed.inline.filter((s) => !handled.has(s.id));
  const generalAi = placed.general.filter((s) => !handled.has(s.id));
  const aiById = new Map(inlineAi.map((s) => [s.id, s] as const));
  const aiNotes = inlineAi.map((s) => ({
    file: s.file ?? "",
    id: s.id,
    line: s.line ?? 0,
    side: s.side ?? "new",
  }));
  const suggestionCard = (id: string, inDiff: boolean) => {
    const suggestion = inDiff
      ? aiById.get(id)
      : generalAi.find((s) => s.id === id);
    if (!suggestion) {
      return null;
    }
    return (
      <AiSuggestionCard
        key={id}
        suggestion={suggestion}
        inDiff={inDiff}
        onAccept={(edited) => {
          const body = withSuggestion(edited, suggestion);
          const text =
            suggestion.placement === "general" && suggestion.file
              ? `${suggestion.file}${suggestion.line ? `:${suggestion.line}` : ""}: ${body}`
              : body;
          saveComments([
            ...commentsRef.current,
            suggestionComment(suggestion, text),
          ]);
          ai.handle(id);
        }}
        onDismiss={() => ai.handle(id)}
      />
    );
  };
  const [sent, setSent] = useState<ReviewComment[]>(() =>
    readComments(sentKey(projectId, target))
  );
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();
  const [diffView, setDiffView] = useState(readDiffView);
  // The file whose diff is open: a file of the branch diff, or an entry of the unstaged or staged list.
  const [selectedFile, setSelectedFile] = useState<string>();
  const [picked, setPicked] = useState<Selection | null>();
  // Uncommitted changes are decided hunk by hunk (kept or undone) and can be commented on in the same view.
  const stage = useStage(projectId, directory, shownMode === "working");
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
    const source = variantOf(view, session)?.task.jira;
    if (source) {
      ticketSources.set(`${source.instanceUrl}/${source.key}`, source);
    }
  }
  const [sessionChoice, setSessionChoice] = useState("");
  const preferred = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  const chosen = sessionChoice || preferred?.id || "new";

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
  const openLineComment = useCallback(
    (file: string, anchor: LineAnchor) => setOpen({ anchor, file }),
    []
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

  // Checks: refreshed with the review, shown when they run or fail.
  const checks = useChecks(projectId, directory);
  const [checksOpen, setChecksOpen] = useState(false);
  useEffect(() => {
    if (checks.state === "running" || checks.state === "failed") {
      setChecksOpen(true);
    }
  }, [checks.state]);
  const hasChecks =
    checks.state !== "none" || (checks.view?.errors.length ?? 0) > 0;
  // The file tree sticks just below the toolbar, whose height changes as it wraps.
  const toolbar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = toolbar.current;
    if (!bar || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() =>
      bar.parentElement?.style.setProperty(
        "--review-bar-height",
        `${bar.offsetHeight}px`
      )
    );
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const fetchHome = () =>
    run("Bringing home", async () => {
      const { branch } = await bringHome(projectId, directory);
      setNotice(
        `Fetched ${branch} from ${remoteNode} into this machine's repository.`
      );
      refresh();
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
      refresh();
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
      refresh();
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

  const blockers = gitBlockers(data, { baseName, isWorktree });
  const hasPullRequest = !!publish.info?.pr;
  const step = data ? nextStep(data, { baseName, hasPullRequest }) : undefined;
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

  const showingUncommitted = shownMode === "working";
  const selection = pickSelection(stage.data, picked);
  // Keeping or undoing the open file moves on to the next one of its list, or to no diff.
  const changeStage = (stageAction: StageAction, what: StageChange) => {
    if (stage.data) {
      setPicked(selectionAfter(stage.data, selection, stageAction, what));
    }
    stage.change(stageAction, what);
  };
  // One file at a time, as in other git clients: the first until another is picked.
  const branchFile =
    data?.files.find((f) => f.file === selectedFile) ?? data?.files[0];

  let primary;
  if (step?.kind === "update") {
    primary = {
      blocker: blockers.update,
      icon: <ArrowDownToLineIcon />,
      label: step.title,
      run: update,
    };
  } else if (step?.kind === "publish") {
    primary = {
      blocker: publish.blocker,
      icon: <GitPullRequestArrowIcon />,
      label: hasPullRequest ? "Update pull request…" : "Publish…",
      run: () => setDialog("publish"),
    };
  }

  const aiBusy = !!(ai.run && !["done", "failed"].includes(ai.run.stage));
  const tools = (
    <>
      {hasChecks && (
        <Button
          variant="outline"
          size="sm"
          aria-pressed={checksOpen}
          title={`${STATE_LABEL[checks.state]}. Click to ${checksOpen ? "hide" : "show"} them.`}
          onClick={() => setChecksOpen((o) => !o)}
        >
          <ChecksIcon state={checks.state} />{" "}
          <span className="max-sm:sr-only">Checks</span>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || !data?.files.length || aiBusy}
          >
            <SparklesIcon /> <span className="max-sm:sr-only">AI review</span>{" "}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem onSelect={() => ai.start("agent")}>
            <BotIcon /> Agent review
          </DropdownMenuItem>
          {ocr.data?.effective.configured && (
            <DropdownMenuItem onSelect={() => ai.start("ocr")}>
              <ScanSearchIcon /> Open Code Review
            </DropdownMenuItem>
          )}
          {!ocr.data?.effective.configured &&
            ocr.data?.override.mode === "custom" && (
              <DropdownMenuItem onSelect={() => setProjectSettings(true)}>
                <ScanSearchIcon /> Set up Open Code Review…
              </DropdownMenuItem>
            )}
          {!ocr.data?.effective.configured &&
            ocr.data?.override.mode !== "custom" && (
              <DropdownMenuItem asChild>
                <SettingsLink section={OCR_SECTION}>
                  <ScanSearchIcon /> Set up Open Code Review…
                </SettingsLink>
              </DropdownMenuItem>
            )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectSettingsDialog
        view={view}
        open={projectSettings}
        onOpenChange={setProjectSettings}
      />
    </>
  );

  const more = (
    <>
      <GitItem
        icon={<ArrowDownToLineIcon />}
        label={`Update from ${base}`}
        blocker={blockers.update}
        onSelect={update}
      />
      <GitItem
        icon={<GitMergeIcon />}
        label={`Merge into ${base}…`}
        blocker={blockers.merge}
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
        label={hasPullRequest ? "Update pull request…" : "Publish…"}
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
    </>
  );

  // What both ways of showing the changes pass to their diffs.
  const diffProps: DiffListProps = {
    comments,
    notes: aiNotes,
    onAdd: addLineComment,
    onAnchor: openLineComment,
    onCancel: cancelLineComment,
    onDelete: deleteComment,
    open,
    placeholder: "Comment for the agent…",
    renderNote: (id) => suggestionCard(id, true),
    version: `${shownMode}:${baseName}`,
    view: diffView,
  };

  return (
    <div className="flex flex-col gap-4">
      {[...ticketSources].map(([id, source]) => (
        <JiraSourceCard key={id} source={source} />
      ))}
      <ReviewToolbar
        barRef={toolbar}
        data={data}
        hasError={!!error}
        base={base}
        busy={busy}
        loading={loading}
        view={diffView}
        onView={changeDiffView}
        onMode={changeMode}
        onPickBase={() => setDialog("base")}
        onRefresh={refresh}
        tools={tools}
      />

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
          <AlertDescription>
            <ErrorText error={error} />
          </AlertDescription>
        </Alert>
      )}
      {notice && <OkBanner>{notice}</OkBanner>}
      {staleReview && (
        <p className={muted}>
          The diff has changed since this AI review. Run it again for current
          findings.
        </p>
      )}
      <AiReviewPanel
        ai={ai}
        general={generalAi}
        inline={inlineAi.length}
        renderGeneral={(suggestion) => suggestionCard(suggestion.id, false)}
        onRerun={() => ai.start(ai.run?.kind === "ocr" ? "ocr" : "agent")}
      />
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
            refresh();
            void queryClient.invalidateQueries({
              queryKey: publishInfoQuery(projectId, directory).queryKey,
            });
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
            { label: "New conversation", value: "new" },
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
      {data && (
        <div className="grid items-start gap-4 md:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
          <ReviewSidebar
            files={showingUncommitted ? [] : data.files}
            viewedCount={showingUncommitted ? undefined : viewedCount}
            showFiles={!diffView.hideFiles}
            onSelect={setSelectedFile}
            list={
              showingUncommitted && stage.data ? (
                <FileGroups
                  unstaged={stage.data.unstaged}
                  staged={stage.data.staged}
                  selection={selection}
                  disabled={stage.busy}
                  onSelect={setPicked}
                  change={changeStage}
                />
              ) : undefined
            }
          >
            <StepPanel
              step={step}
              showingUncommitted={showingUncommitted}
              kept={stage.kept}
              left={stage.left}
              busy={busy}
              committing={stage.busy}
              comments={comments.length}
              primary={primary}
              more={more}
              onCommit={async (message) => {
                await stage.commit(message);
                setNotice("Committed.");
              }}
              onKeepAll={() => changeStage("stage", {})}
              onSuggest={() => suggestCommitMessage(projectId, directory)}
              onShowUncommitted={() => changeMode("working")}
              onComments={() => setDialog("comments")}
            />
          </ReviewSidebar>
          <div className="flex min-w-0 flex-col gap-4">
            {showingUncommitted && (
              <ChangeSections
                stage={{ ...stage, change: changeStage }}
                diffProps={diffProps}
                selection={selection}
              />
            )}
            {showingUncommitted &&
              data.files.length === 0 &&
              aheadHint(data) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p className={muted}>{aheadHint(data)}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => changeMode("branch")}
                  >
                    <GitCompareArrowsIcon /> Compare with {base}
                  </Button>
                </div>
              )}
            {!showingUncommitted && data.files.length === 0 && (
              <p className={muted}>No changes compared with {base}.</p>
            )}
            {!showingUncommitted && branchFile && (
              <ReviewDiffs
                key={branchFile.file}
                {...diffProps}
                files={[branchFile]}
                hideTree
                collapsible={false}
                wholeFilePatches
                load={(file) =>
                  fetchReview(projectId, directory, {
                    base: baseOverride,
                    file,
                    mode,
                  }).then((d) => d.files[0]?.patch)
                }
                imageUrl={(file, side) =>
                  // A turn's earlier versions aren't in git; only the newest turn's result is still in the working copy.
                  data.mode === "turn" && (side === "old" || !data.turn?.latest)
                    ? undefined
                    : reviewImageUrl(projectId, directory, {
                        base: baseOverride,
                        file,
                        mode: data.mode,
                        side,
                      })
                }
                viewed={viewed}
                onViewed={changeViewed}
              />
            )}
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
  const { view, checkout, sessionId } = useCheckoutContext();
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
      sessionId={sessionId}
    />
  );
};

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
