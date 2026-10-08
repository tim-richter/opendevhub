import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  BotIcon,
  BoxIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LayersIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type {
  ForgejoInbox,
  ForgejoPullDetails,
  ForgejoPullFilter,
  ForgejoPulls,
} from "../../shared/forgejo";
import {
  fetchForgejoDetails,
  fetchForgejoDiff,
  fetchForgejoOrganizations,
  fetchForgejoPulls,
  fetchForgejoTeams,
} from "../api";
import { Choice } from "../components/choice";
import {
  AiReviewPanel,
  AiSuggestionCard,
  ForgejoAiReviewDialog,
  ForgejoCommentNote,
  useAiReview,
} from "../components/forgejo-ai-review";
import { ForgejoApprovals } from "../components/forgejo-approvals";
import {
  ForgejoContext,
  RequestState,
  feedbackKey,
  selectedFeedback,
} from "../components/forgejo-context";
import type {
  FeedbackKind,
  FeedbackSelection,
  FeedbackValue,
} from "../components/forgejo-context";
import { ForgejoHandoff } from "../components/forgejo-handoff";
import {
  ForgejoReviewDialog,
  ForgejoWorktreeDialog,
} from "../components/forgejo-review-dialogs";
import { ForgejoStack } from "../components/forgejo-stack";
import { MarkdownBody } from "../components/markdown-body";
import {
  Chip,
  Empty,
  Note,
  Page,
  PageHeader,
  Section,
  Segmented,
} from "../components/page";
import {
  FilesToggle,
  LayoutToggle,
  ReviewDiffs,
} from "../components/review-diffs";
import { DiffLinesSkeleton } from "../components/skeletons";
import { Tip } from "../components/tip";
import { When } from "../components/when";
import { useDash } from "../dashboard-context";
import {
  defaultPullMode,
  forgejoCommentNote,
  forgejoReviewFiles,
  placeAiFindings,
  readForgejoPreference,
  saveForgejoPreference,
  stackForgejoPulls,
  suggestionComment,
} from "../forgejo";
import type { AiSuggestion, PullMode } from "../forgejo";
import { useForgejoQuery } from "../hooks/use-forgejo";
import { FAILED_CHECK, usePullFeedback } from "../hooks/use-pull-feedback";
import { newId, readDiffView, writeDiffView } from "../review";
import type { DiffNote, DiffView, LineAnchor, ReviewComment } from "../review";

/** Extra left padding per level of a stacked pull request in the list. */
const STACK_INDENT_REM = 1.5;

const ForgejoGate = ({ children }: { children: ReactNode }) => {
  const { forgejo, forgejoError } = useDash();
  if (!forgejo && !forgejoError) {
    return (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      <p role="status" className="text-muted-foreground text-sm">
        Loading Forgejo settings…
      </p>
    );
  }
  if (!forgejo?.enabled) {
    return (
      <Empty title="Forgejo is disabled">
        {forgejoError && <Note warn>{forgejoError}</Note>}
        <p className="text-muted-foreground text-sm">
          Connect your Forgejo account to see your pull requests.
        </p>
        <Button asChild variant="outline">
          <Link to="/settings">Open settings</Link>
        </Button>
      </Empty>
    );
  }
  return children;
};
const Refresh = ({ busy, onClick }: { busy: boolean; onClick: () => void }) => (
  <Button variant="outline" size="sm" disabled={busy} onClick={onClick}>
    <RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh
  </Button>
);

const PullStateIcon = ({ state }: { state: string }) => {
  if (state === "merged") {
    return <GitMergeIcon className="mt-0.5 size-4 shrink-0 text-violet-500" />;
  }
  if (state === "closed") {
    return (
      <GitPullRequestClosedIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
    );
  }
  return <GitPullRequestIcon className="text-ok mt-0.5 size-4 shrink-0" />;
};

/** A note in the diff draws through context, so it follows the page's state without re-rendering the diff. */
const NoteContext = createContext<(id: string) => ReactNode>(() => null);
const NoteSlot = ({ id }: { id: string }) => useContext(NoteContext)(id);
const renderNoteSlot = (id: string) => <NoteSlot id={id} />;

const pluralize = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/** Forgejo's own list filters, without this page's mode. */
const listSearchOf = (search: URLSearchParams): string => {
  const next = new URLSearchParams(search);
  next.delete("mode");
  return next.toString();
};

const PullDiff = ({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: string;
}) => {
  const [search] = useSearchParams();
  const listSearch = listSearchOf(search);
  // A refetch that finds a new head commit starts the page over, so it waits while there are drafts.
  const [drafting, setDrafting] = useState(false);
  const details = useForgejoQuery(
    ["pull", owner, repo, number, "details"],
    (signal) => fetchForgejoDetails(owner, repo, number, signal),
    true,
    { refetchOnReconnect: !drafting, refetchOnWindowFocus: !drafting }
  );
  if (!details.data) {
    return (
      <Page className="max-w-none">
        <BackLink search={listSearch} />
        <PageHeader
          title={`${owner}/${repo} #${number}`}
          description="Pull request"
        />
        <ForgejoGate>
          <RequestState query={details} />
        </ForgejoGate>
      </Page>
    );
  }
  // A new head commit starts over: drafts, picks and suggestions belong to the commit they were made on.
  return (
    <PullView
      key={details.data.headSha}
      details={details.data}
      fetchingDetails={details.isFetching}
      refetchDetails={() => details.refetch()}
      onDrafting={setDrafting}
    />
  );
};

const BackLink = ({ search }: { search: string }) => (
  <Link
    to={`/forgejo?${search || readForgejoPreference("inbox")}`}
    className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm"
  >
    <ArrowLeftIcon className="size-4" /> Pull requests
  </Link>
);

// oxlint-disable-next-line complexity
const PullView = ({
  details,
  fetchingDetails,
  refetchDetails,
  onDrafting,
}: {
  details: ForgejoPullDetails;
  fetchingDetails: boolean;
  refetchDetails: () => Promise<unknown>;
  onDrafting: (drafting: boolean) => void;
}) => {
  const { forgejo } = useDash();
  const [search, setSearch] = useSearchParams();
  const listSearch = listSearchOf(search);
  const client = useQueryClient();
  const { owner, repo } = details.pull;
  const number = String(details.pull.number);
  const key = ["pull", owner, repo, number];
  const mode: PullMode =
    search.get("mode") === "review" || search.get("mode") === "address"
      ? (search.get("mode") as PullMode)
      : defaultPullMode(
          new URLSearchParams(listSearch || readForgejoPreference("inbox")).get(
            "inbox"
          )
        );
  const setMode = (next: PullMode) => {
    const params = new URLSearchParams(search);
    params.set("mode", next);
    setSearch(params, { replace: true });
  };
  const isOpen = details.pull.state === "open";
  const reviewing = mode === "review";

  // Review mode: your draft line comments and summary for a Forgejo review.
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [summary, setSummary] = useState("");
  const drafting = comments.length > 0 || !!summary.trim();
  useEffect(() => {
    onDrafting(drafting);
  }, [drafting, onDrafting]);
  // Address mode: what goes to the agent.
  const [selection, setSelection] = useState<FeedbackSelection>({});
  const [dialog, setDialog] = useState<
    "handoff" | "review" | "worktree" | "ai"
  >();

  const patch = useForgejoQuery(
    [...key, "patch", details.headSha, details.base, details.pull.updatedAt],
    (signal) => fetchForgejoDiff(owner, repo, number, signal),
    true,
    { refetchOnReconnect: !drafting, refetchOnWindowFocus: !drafting }
  );
  const [diffView, setDiffView] = useState(readDiffView);
  const changeDiffView = (change: Partial<DiffView>) => {
    const next = { ...diffView, ...change };
    setDiffView(next);
    writeDiffView(next);
  };
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();
  const files = useMemo(
    () => forgejoReviewFiles(patch.data?.patch ?? ""),
    [patch.data?.patch]
  );
  const feedback = usePullFeedback(details);
  const ai = useAiReview(details);

  const run = ai.run?.stage === "done" ? ai.run : undefined;
  const placed = useMemo(
    () => placeAiFindings(run?.findings ?? [], files, `ai-${run?.id ?? ""}`),
    [run?.findings, run?.id, files]
  );
  const handled = new Set(run?.handled);
  const inlineAi = placed.inline.filter((s) => !handled.has(s.id));
  const generalAi = placed.general.filter((s) => !handled.has(s.id));
  const aiById = new Map(
    [...inlineAi, ...generalAi].map((s) => [s.id, s] as const)
  );
  const inlineForgejo = feedback.inlineComments.flatMap((comment) => {
    const note = forgejoCommentNote(comment, files);
    return note ? [{ comment, note }] : [];
  });
  const commentById = new Map(
    inlineForgejo.map(({ comment, note }) => [note.id, comment] as const)
  );
  const noteKey = [
    ...inlineForgejo.map(({ note }) => note.id),
    ...inlineAi.map((s) => s.id),
  ].join(",");
  // The diff re-renders when its notes change, so they only change when the ids do.
  const notesRef = useRef<{ key: string; notes: DiffNote[] }>({
    key: "",
    notes: [],
  });
  if (notesRef.current.key !== noteKey) {
    notesRef.current = {
      key: noteKey,
      notes: [
        ...inlineForgejo.map(({ note }) => note),
        ...inlineAi.map((s) => ({
          file: s.file ?? "",
          id: s.id,
          line: s.line ?? 0,
          side: s.side ?? "new",
        })),
      ],
    };
  }
  const { notes } = notesRef.current;

  const pick = (
    kind: FeedbackKind,
    value: FeedbackValue | AiSuggestion,
    checked: boolean
  ) =>
    setSelection((current) => {
      const next = { ...current };
      const id = feedbackKey(kind, value.id);
      if (checked) {
        next[id] = { kind, value };
      } else {
        delete next[id];
      }
      return next;
    });
  const selectUnresolved = () =>
    setSelection((current) => {
      const next = { ...current };
      const add = (kind: FeedbackKind, value: FeedbackValue | AiSuggestion) => {
        next[feedbackKey(kind, value.id)] = { kind, value };
      };
      for (const c of [...feedback.allComments, ...feedback.inlineComments]) {
        if (!c.resolved) {
          add("comments", c);
        }
      }
      for (const r of feedback.allReviews) {
        const says =
          r.state === "REQUEST_CHANGES" ||
          (r.state === "COMMENT" && !!r.body.trim());
        if (says && !r.dismissed && !r.stale) {
          add("reviews", r);
        }
      }
      for (const c of feedback.allChecks) {
        if (FAILED_CHECK.has(c.status)) {
          add("checks", c);
        }
      }
      for (const s of aiById.values()) {
        add("ai", s);
      }
      return next;
    });
  const startAi: typeof ai.start = (...args) => {
    setSelection((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, v]) => v.kind !== "ai")
      )
    );
    ai.start(...args);
  };
  const dismiss = (s: AiSuggestion) => {
    pick("ai", s, false);
    ai.handle(s.id);
  };
  const accept = (s: AiSuggestion, text: string) => {
    if (s.file && s.line !== undefined) {
      setComments((current) => [...current, suggestionComment(s, text)]);
    } else {
      setSummary((current) =>
        current.trim() ? `${current}\n\n${text}` : text
      );
    }
    ai.handle(s.id);
  };
  const suggestionCard = (s: AiSuggestion, inDiff: boolean) => (
    <AiSuggestionCard
      key={s.id}
      suggestion={s}
      inDiff={inDiff}
      acceptLabel={inDiff ? "Accept" : "Add to summary"}
      onAccept={reviewing && isOpen ? (text) => accept(s, text) : undefined}
      selected={!!selection[feedbackKey("ai", s.id)]}
      onSelect={reviewing ? undefined : (checked) => pick("ai", s, checked)}
      onDismiss={() => dismiss(s)}
    />
  );
  const renderNote = (id: string): ReactNode => {
    const comment = commentById.get(id);
    if (comment) {
      return (
        <ForgejoCommentNote
          comment={comment}
          selected={!!selection[id]}
          onSelect={
            reviewing
              ? undefined
              : (checked) => pick("comments", comment, checked)
          }
        />
      );
    }
    const suggestion = aiById.get(id);
    return suggestion ? suggestionCard(suggestion, true) : null;
  };

  const openLineComment = useCallback(
    (file: string, anchor: LineAnchor) => setOpen({ anchor, file }),
    []
  );
  const addLineComment = useCallback(
    (file: string, anchor: LineAnchor, text: string) => {
      setComments((current) => [
        ...current,
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
    []
  );
  const cancelLineComment = useCallback(() => setOpen(undefined), []);
  const deleteComment = useCallback(
    (id: string) =>
      setComments((current) => current.filter((c) => c.id !== id)),
    []
  );
  const url = forgejo?.url
    ? `${forgejo.url}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`
    : undefined;
  const refresh = async () => {
    // Keep old content visible while fetching. Commit-specific patch/check keys prevent mixing revisions.
    if (
      drafting &&
      !confirm(
        "Refresh the pull request? If it has new commits, your draft review is discarded."
      )
    ) {
      return;
    }
    await refetchDetails();
    await client.invalidateQueries({
      predicate: (query) => query.queryKey[6] !== "details",
      queryKey: ["forgejo", forgejo?.url, ...key],
    });
    await client.invalidateQueries({
      queryKey: ["forgejo", forgejo?.url, "checks", owner, repo],
    });
  };
  const picked = Object.keys(selection).length;
  const aiBusy =
    !!ai.run && ai.run.stage !== "done" && ai.run.stage !== "failed";
  return (
    <Page className="max-w-none pb-0">
      <BackLink search={listSearch} />
      <PageHeader
        title={details.pull.title}
        description={`${owner}/${repo} #${number} · ${details.head} → ${details.base}`}
        actions={
          <>
            {url && (
              <Button asChild variant="outline" size="sm">
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon /> Open in Forgejo
                </a>
              </Button>
            )}
            {details.headSha && (
              <Tip label="Check the head commit out in a worktree of a local project">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog("worktree")}
                >
                  <BoxIcon /> Inspect in container
                </Button>
              </Tip>
            )}
            {details.headSha && (
              <Tip
                label={
                  reviewing
                    ? "Have an agent review the head commit and suggest line comments"
                    : "Have an agent review the head commit; hand its findings to the agent that fixes them"
                }
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aiBusy}
                  onClick={() => setDialog("ai")}
                >
                  <SparklesIcon /> {aiBusy ? "AI reviewing…" : "AI review"}
                </Button>
              </Tip>
            )}
            <Refresh
              busy={fetchingDetails || patch.isFetching}
              onClick={() => void refresh()}
            />
          </>
        }
      />
      <ForgejoGate>
        <div className="flex flex-wrap items-center gap-2">
          <Chip>{details.pull.state}</Chip>
          {details.draft && <Chip>Draft</Chip>}
          {details.mergeable === false && isOpen && (
            <Chip>Merge conflicts</Chip>
          )}
          <ForgejoApprovals pull={details.pull} />
          <span className="text-muted-foreground text-sm">
            By {details.author}
          </span>
          {details.labels.map((l) => (
            <Chip key={l}>{l}</Chip>
          ))}
          <div className="ml-auto">
            <Segmented
              label="What you're doing"
              value={mode}
              onChange={setMode}
              options={[
                { id: "address", label: "Address feedback" },
                { id: "review", label: "Review" },
              ]}
            />
          </div>
        </div>
        <p className="text-muted-foreground -mt-2 text-sm">
          {reviewing
            ? "Write your review: comment on lines, and accept or dismiss what an AI review suggests."
            : "Pick the feedback an agent should work on: comments, reviews, failing checks and AI findings, then hand it off."}
        </p>
        <AiReviewPanel
          ai={ai}
          general={generalAi}
          inline={inlineAi.length}
          renderGeneral={(s) => suggestionCard(s, false)}
          onRerun={() => setDialog("ai")}
        />
        <ForgejoContext
          key={mode}
          details={details}
          selected={selection}
          onPick={reviewing ? undefined : pick}
          collapsed={reviewing}
          stack={<ForgejoStack details={details} search={listSearch} />}
          description={
            <Section title="Description">
              {details.body ? (
                <MarkdownBody className="p-4">{details.body}</MarkdownBody>
              ) : (
                <p className="text-muted-foreground p-4 text-sm">
                  No description.
                </p>
              )}
            </Section>
          }
        />
        {dialog === "handoff" && (
          <ForgejoHandoff
            details={details}
            feedback={selectedFeedback(selection)}
            onClose={() => setDialog(undefined)}
          />
        )}
        {dialog === "review" && (
          <ForgejoReviewDialog
            pull={details.pull}
            commitId={details.headSha}
            comments={comments}
            body={summary}
            onBody={setSummary}
            onDelete={deleteComment}
            onSent={() => {
              setComments([]);
              setSummary("");
              void refetchDetails();
            }}
            onClose={() => setDialog(undefined)}
          />
        )}
        {dialog === "worktree" && (
          <ForgejoWorktreeDialog
            pull={details.pull}
            commitId={details.headSha}
            onClose={() => setDialog(undefined)}
          />
        )}
        {dialog === "ai" && (
          <ForgejoAiReviewDialog
            details={details}
            onStart={startAi}
            onClose={() => setDialog(undefined)}
          />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <FilesToggle view={diffView} onChange={changeDiffView} />
          <h2 className="font-semibold">Changes</h2>
          <span className="text-muted-foreground text-sm max-sm:hidden">
            {reviewing &&
              isOpen &&
              "Click the + beside a line to comment on it."}
            {!reviewing &&
              !!inlineForgejo.length &&
              `${pluralize(inlineForgejo.length, "inline comment")} shown at their lines.`}
          </span>
          <div className="ml-auto">
            <LayoutToggle view={diffView} onChange={changeDiffView} />
          </div>
        </div>
        {patch.isPending && (
          <div role="status" aria-label="Loading pull request diff">
            <DiffLinesSkeleton />
          </div>
        )}
        {patch.error && (
          <div role="alert">
            <Note warn>{patch.error.message}</Note>
            <Button variant="link" onClick={() => void patch.refetch()}>
              Retry diff
            </Button>
          </div>
        )}
        {patch.data &&
          (files.length ? (
            <NoteContext.Provider value={renderNote}>
              <ReviewDiffs
                files={files}
                view={diffView}
                version={details.headSha}
                comments={reviewing ? comments : []}
                notes={notes}
                renderNote={renderNoteSlot}
                open={reviewing ? open : undefined}
                placeholder="Review comment…"
                onAnchor={reviewing && isOpen ? openLineComment : undefined}
                onAdd={addLineComment}
                onCancel={cancelLineComment}
                onDelete={deleteComment}
              />
            </NoteContext.Provider>
          ) : (
            <Empty title="No changes in this pull request" />
          ))}
        <div className="bg-background sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t px-4 py-3 md:-mx-8 md:px-8">
          {reviewing ? (
            <>
              <span className="text-sm">
                {pluralize(comments.length, "draft comment")}
                {!!aiById.size && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {pluralize(aiById.size, "AI suggestion")} to go through
                  </span>
                )}
              </span>
              <div className="ml-auto flex gap-2">
                {isOpen ? (
                  <Button size="sm" onClick={() => setDialog("review")}>
                    <MessageSquareIcon /> Submit review…
                  </Button>
                ) : (
                  <span className="text-muted-foreground text-sm">
                    This pull request is {details.pull.state}.
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <span className="text-sm">
                {picked
                  ? `${pluralize(picked, "item")} for the agent`
                  : "Nothing picked yet; the agent gets the PR and its description."}
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={selectUnresolved}>
                  Pick all open feedback
                </Button>
                {!!picked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelection({})}
                  >
                    Clear
                  </Button>
                )}
                <Button size="sm" onClick={() => setDialog("handoff")}>
                  <BotIcon /> Hand off to agent…
                </Button>
              </div>
            </>
          )}
        </div>
      </ForgejoGate>
    </Page>
  );
};

const ALL = "";
/** Keeps a filter from the URL selectable while its list is loading or doesn't include it. */
const withCurrent = (names: string[] | undefined, current: string) =>
  current && !names?.includes(current)
    ? [current, ...(names ?? [])]
    : (names ?? []);

const OrgTeamFilter = ({
  org,
  team,
  onChange,
}: {
  org: string;
  team: string;
  onChange: (org: string, team: string) => void;
}) => {
  const orgs = useForgejoQuery(["orgs"], fetchForgejoOrganizations);
  const teams = useForgejoQuery(
    ["teams", org],
    (signal) => fetchForgejoTeams(org, signal),
    !!org
  );
  return (
    <>
      <Choice
        className="w-full sm:w-48"
        label="Organization filter"
        value={org}
        disabled={orgs.isError && !org}
        onChange={(value) => onChange(value, ALL)}
        options={[
          { label: "All organizations", value: ALL },
          ...withCurrent(orgs.data?.orgs, org).map((name) => ({
            label: name,
            value: name,
          })),
        ]}
      />
      {org && (
        <Choice
          className="w-full sm:w-48"
          label="Team filter"
          value={team}
          disabled={teams.isError && !team}
          onChange={(value) => onChange(org, value)}
          options={[
            {
              label: teams.isError ? "Teams unavailable" : "All teams",
              value: ALL,
            },
            ...withCurrent(teams.data?.teams, team).map((name) => ({
              label: name,
              value: name,
            })),
          ]}
        />
      )}
    </>
  );
};

// oxlint-disable-next-line complexity
export const ForgejoPage = () => {
  const { forgejo } = useDash();
  const [search, setSearch] = useSearchParams();
  // Explicit URL filters win; a bare sidebar link restores the last view.
  const filters = search.size
    ? search
    : new URLSearchParams(readForgejoPreference("inbox"));
  const state: ForgejoPullFilter =
    filters.get("state") === "all" || filters.get("state") === "closed"
      ? (filters.get("state") as ForgejoPullFilter)
      : "open";
  let inbox: ForgejoInbox;
  if (
    ["assigned", "review-requested", "review"].includes(
      filters.get("inbox") ?? ""
    )
  ) {
    inbox = filters.get("inbox") as ForgejoInbox;
  } else if (filters.get("tab") === "review") {
    inbox = "review";
  } else {
    inbox = "authored";
  }
  const q = filters.get("q") ?? "";
  const repository = filters.get("repository") ?? "";
  const org = filters.get("org") ?? "";
  const team = org ? (filters.get("team") ?? "") : "";
  const [queryInput, setQueryInput] = useState(q);
  const [repoInput, setRepoInput] = useState(repository);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(filters);
    next.set(key, value);
    setSearch(next, { replace: true });
  };
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setQueryInput(q);
    setRepoInput(repository);
  }, [q, repository]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (queryInput === q && repoInput === repository) {
        return;
      }
      const next = new URLSearchParams(filters);
      next.set("q", queryInput.trim());
      next.set("repository", repoInput.trim());
      setSearch(next, { replace: true });
    }, 400);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies react-hooks/exhaustive-deps
  }, [queryInput, repoInput, q, repository, filters.toString(), setSearch]);
  const listSearch = new URLSearchParams({
    inbox,
    state,
    ...(q ? { q } : {}),
    ...(repository ? { repository } : {}),
    ...(org ? { org } : {}),
    ...(team ? { team } : {}),
  }).toString();
  useEffect(() => {
    saveForgejoPreference("inbox", listSearch);
  }, [listSearch]);
  const query = useInfiniteQuery({
    enabled: !!forgejo?.enabled,
    getNextPageParam: (last: ForgejoPulls) => last.nextPage,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchForgejoPulls(
        { inbox, org, page: pageParam, q, repository, state, team },
        signal
      ),
    queryKey: [
      "forgejo",
      forgejo?.url,
      "inbox",
      { inbox, org, q, repository, state, team },
    ],
  });
  const pulls = [
    ...new Map(
      (query.data?.pages.flatMap((p) => p.pulls) ?? []).map((p) => [
        `${p.owner}/${p.repo}/${p.number}`,
        p,
      ])
    ).values(),
  ];
  const username = query.data?.pages[0]?.username;
  return (
    <Page>
      <PageHeader
        title="Forgejo"
        description={
          username
            ? `Pull requests for ${username}.`
            : "Your pull requests and review inbox."
        }
        actions={
          <Refresh busy={query.isFetching} onClick={() => query.refetch()} />
        }
      />
      <ForgejoGate>
        <Segmented
          label="Pull request inbox"
          value={inbox}
          onChange={(value) => change("inbox", value)}
          options={[
            { id: "authored", label: "Authored by me" },
            { id: "review-requested", label: "Review requested" },
            { id: "assigned", label: "Assigned to me" },
            { id: "review", label: "Review all" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Pull request state"
            value={state}
            onChange={(value) => change("state", value)}
            options={[
              { id: "all", label: "All" },
              { id: "open", label: "Open" },
              { id: "closed", label: "Closed / merged" },
            ]}
          />
          <Input
            className="w-full sm:w-64"
            aria-label="Search pull requests"
            placeholder="Search pull requests…"
            value={queryInput}
            maxLength={200}
            onChange={(e) => setQueryInput(e.target.value)}
          />
          <Input
            className="w-full sm:w-56"
            aria-label="Repository filter"
            placeholder="Repository: owner/name"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
          />
          <OrgTeamFilter
            org={org}
            team={team}
            onChange={(nextOrg, nextTeam) => {
              const next = new URLSearchParams(filters);
              next.set("org", nextOrg);
              next.set("team", nextTeam);
              setSearch(next, { replace: true });
            }}
          />
        </div>
        <RequestState query={query} />
        {query.data && !pulls.length && (
          <Empty
            title={
              query.hasNextPage
                ? "No matches in the loaded pages"
                : "No pull requests"
            }
          >
            <p className="text-muted-foreground text-sm">
              {query.hasNextPage
                ? "Load more to search the remaining pages."
                : "No pull requests match this view in repositories accessible to the token."}
            </p>
          </Empty>
        )}
        {!!pulls.length && (
          <Section title="Pull requests" hint={`${pulls.length} loaded`}>
            <ul className="divide-y">
              {stackForgejoPulls(pulls).map(({ pull, depth }) => (
                <li key={`${pull.owner}/${pull.repo}/${pull.number}`}>
                  <Link
                    className="hover:bg-muted/50 focus-visible:outline-ring flex items-start gap-3 px-4 py-3 transition-colors focus-visible:outline-2"
                    style={
                      depth
                        ? { paddingLeft: `${1 + depth * STACK_INDENT_REM}rem` }
                        : undefined
                    }
                    to={`/forgejo/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/${pull.number}?${listSearch}`}
                  >
                    {depth > 0 && (
                      <CornerDownRightIcon
                        aria-label="Stacked on the pull request above"
                        className="text-muted-foreground mt-0.5 -mr-1 size-4 shrink-0"
                      />
                    )}
                    <PullStateIcon state={pull.state} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium break-words">{pull.title}</p>
                      <p className="text-muted-foreground text-sm break-words">
                        {pull.owner}/{pull.repo} #{pull.number}
                        {pull.stack && (
                          <>
                            {" "}
                            into{" "}
                            <code className="text-xs">{pull.stack.base}</code>
                          </>
                        )}{" "}
                        · Updated <When at={pull.updatedAt} />
                      </p>
                      {depth === 0 && pull.stack?.parent && (
                        <p className="text-muted-foreground flex items-center gap-1 text-sm">
                          <LayersIcon className="size-3.5 shrink-0" />
                          <span className="min-w-0 break-words">
                            Stacked on #{pull.stack.parent.number}{" "}
                            {pull.stack.parent.title}
                          </span>
                        </p>
                      )}
                    </div>
                    <ForgejoApprovals pull={pull} lazy />
                    <Chip>{pull.state}</Chip>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {query.hasNextPage && (
          <Button
            className="self-start"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more pull requests"}
          </Button>
        )}
        {query.dataUpdatedAt > 0 && (
          <p className="text-muted-foreground text-xs">
            Last refreshed <When at={query.dataUpdatedAt} />
            {query.isFetching && " · Refreshing…"}
          </p>
        )}
      </ForgejoGate>
    </Page>
  );
};
export const ForgejoPullPage = () => {
  const { owner = "", repo = "", number = "" } = useParams();
  return (
    <PullDiff
      key={`${owner}/${repo}/${number}`}
      owner={owner}
      repo={repo}
      number={number}
    />
  );
};
