import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  BoxIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LayersIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type {
  ForgejoInbox,
  ForgejoPullFilter,
  ForgejoPulls,
} from "../../shared/forgejo";
import {
  fetchForgejoDetails,
  fetchForgejoDiff,
  fetchForgejoPulls,
} from "../api";
import { ForgejoApprovals } from "../components/ForgejoApprovals";
import { ForgejoContext, RequestState } from "../components/ForgejoContext";
import type { ForgejoFeedback } from "../components/ForgejoContext";
import { ForgejoHandoff } from "../components/ForgejoHandoff";
import {
  ForgejoReviewDialog,
  ForgejoWorktreeDialog,
} from "../components/ForgejoReviewDialogs";
import { ForgejoStack } from "../components/ForgejoStack";
import { MarkdownBody } from "../components/MarkdownBody";
import {
  Chip,
  Empty,
  Note,
  Page,
  PageHeader,
  Section,
  Segmented,
} from "../components/Page";
import {
  FilesToggle,
  LayoutToggle,
  ReviewDiffs,
} from "../components/ReviewDiffs";
import { DiffLinesSkeleton } from "../components/Skeletons";
import { Tip } from "../components/Tip";
import { useDash } from "../DashboardContext";
import {
  forgejoReviewFiles,
  readForgejoPreference,
  saveForgejoPreference,
  stackForgejoPulls,
} from "../forgejo";
import { useForgejoQuery } from "../hooks/useForgejo";
import { newId, readDiffView, writeDiffView } from "../review";
import type { DiffView, LineAnchor, ReviewComment } from "../review";

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

// oxlint-disable-next-line complexity
const PullDiff = ({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: string;
}) => {
  const { forgejo } = useDash();
  const [search] = useSearchParams();
  const client = useQueryClient();
  // Draft line comments for a Forgejo review; they belong to the head commit they were written on.
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const drafting = comments.length > 0;
  const key = ["pull", owner, repo, number];
  const details = useForgejoQuery(
    [...key, "details"],
    (signal) => fetchForgejoDetails(owner, repo, number, signal),
    true,
    { refetchOnReconnect: !drafting, refetchOnWindowFocus: !drafting }
  );
  const patch = useForgejoQuery(
    [
      ...key,
      "patch",
      details.data?.headSha,
      details.data?.base,
      details.data?.pull.updatedAt,
    ],
    (signal) => fetchForgejoDiff(owner, repo, number, signal),
    !!details.data,
    { refetchOnReconnect: !drafting, refetchOnWindowFocus: !drafting }
  );
  const [diffView, setDiffView] = useState(readDiffView);
  const changeDiffView = (change: Partial<DiffView>) => {
    const next = { ...diffView, ...change };
    setDiffView(next);
    writeDiffView(next);
  };
  const [open, setOpen] = useState<{ file: string; anchor: LineAnchor }>();
  const [feedback, setFeedback] = useState<ForgejoFeedback>({
    checks: [],
    comments: [],
    reviews: [],
  });
  const [dialog, setDialog] = useState<"handoff" | "review" | "worktree">();
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setFeedback({ checks: [], comments: [], reviews: [] });
    setComments([]);
    setOpen(undefined);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [details.data?.headSha]);
  const files = useMemo(
    () => forgejoReviewFiles(patch.data?.patch ?? ""),
    [patch.data?.patch]
  );
  const openLineComment = useCallback(
    (file: string, anchor: LineAnchor) => setOpen({ anchor, file }),
    []
  );
  const addLineComment = useCallback(
    (file: string, anchor: LineAnchor, text: string) => {
      setComments([
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
    []
  );
  const cancelLineComment = useCallback(() => setOpen(undefined), []);
  const deleteComment = useCallback(
    (id: string) => setComments(commentsRef.current.filter((c) => c.id !== id)),
    []
  );
  const isOpen = details.data?.pull.state === "open";
  const url = forgejo?.url
    ? `${forgejo.url}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`
    : undefined;
  const refresh = async () => {
    // Keep old content visible while fetching. Commit-specific patch/check keys prevent mixing revisions.
    if (
      drafting &&
      !confirm(
        "Refresh the pull request? If it has new commits, your draft review comments are discarded."
      )
    ) {
      return;
    }
    await details.refetch();
    await client.invalidateQueries({
      predicate: (query) => query.queryKey[6] !== "details",
      queryKey: ["forgejo", forgejo?.url, ...key],
    });
    await client.invalidateQueries({
      queryKey: ["forgejo", forgejo?.url, "checks", owner, repo],
    });
  };
  return (
    <Page className="max-w-none">
      <Link
        to={`/forgejo?${search.size ? search.toString() : readForgejoPreference("inbox")}`}
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm"
      >
        <ArrowLeftIcon className="size-4" /> Pull requests
      </Link>
      <PageHeader
        title={details.data?.pull.title ?? `${owner}/${repo} #${number}`}
        description={
          details.data
            ? `${owner}/${repo} #${number} · ${details.data.head} → ${details.data.base}`
            : "Pull request"
        }
        actions={
          <>
            {url && (
              <Button asChild variant="outline" size="sm">
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon /> Open in Forgejo
                </a>
              </Button>
            )}
            {details.data?.headSha && (
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
            {isOpen && details.data?.headSha && (
              <Tip label="Send your line comments as a review">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog("review")}
                >
                  <MessageSquareIcon /> Review
                  {drafting ? ` (${comments.length})` : ""}
                </Button>
              </Tip>
            )}
            {details.data && (
              <Button size="sm" onClick={() => setDialog("handoff")}>
                Continue with agent
              </Button>
            )}
            <Refresh
              busy={details.isFetching || patch.isFetching}
              onClick={() => void refresh()}
            />
          </>
        }
      />
      <ForgejoGate>
        <RequestState query={details} />
        {details.data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Chip>{details.data.pull.state}</Chip>
              {details.data.draft && <Chip>Draft</Chip>}
              {details.data.mergeable === false &&
                details.data.pull.state === "open" && (
                  <Chip>Merge conflicts</Chip>
                )}
              <ForgejoApprovals pull={details.data.pull} />
              <span className="text-muted-foreground text-sm">
                By {details.data.author}
              </span>
              {details.data.labels.map((l) => (
                <Chip key={l}>{l}</Chip>
              ))}
            </div>
            <ForgejoContext
              key={details.data.headSha}
              details={details.data}
              onSelection={setFeedback}
              stack={
                <ForgejoStack
                  details={details.data}
                  search={search.toString()}
                />
              }
              description={
                <Section title="Description">
                  {details.data.body ? (
                    <MarkdownBody className="p-4">
                      {details.data.body}
                    </MarkdownBody>
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
                details={details.data}
                feedback={feedback}
                onClose={() => setDialog(undefined)}
              />
            )}
            {dialog === "review" && (
              <ForgejoReviewDialog
                pull={details.data.pull}
                commitId={details.data.headSha}
                comments={comments}
                onDelete={deleteComment}
                onSent={() => {
                  setComments([]);
                  void details.refetch();
                }}
                onClose={() => setDialog(undefined)}
              />
            )}
            {dialog === "worktree" && (
              <ForgejoWorktreeDialog
                pull={details.data.pull}
                commitId={details.data.headSha}
                onClose={() => setDialog(undefined)}
              />
            )}
            <div className="flex flex-wrap items-center gap-3">
              <FilesToggle view={diffView} onChange={changeDiffView} />
              <h2 className="font-semibold">Changes</h2>
              {isOpen && (
                <span className="text-muted-foreground text-sm max-sm:hidden">
                  Click the + beside a line to comment on it.
                </span>
              )}
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
                <ReviewDiffs
                  files={files}
                  view={diffView}
                  version={details.data.headSha}
                  comments={comments}
                  open={open}
                  placeholder="Review comment…"
                  onAnchor={isOpen ? openLineComment : undefined}
                  onAdd={addLineComment}
                  onCancel={cancelLineComment}
                  onDelete={deleteComment}
                />
              ) : (
                <Empty title="No changes in this pull request" />
              ))}
          </>
        )}
      </ForgejoGate>
    </Page>
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
        { inbox, page: pageParam, q, repository, state },
        signal
      ),
    queryKey: [
      "forgejo",
      forgejo?.url,
      "inbox",
      { inbox, q, repository, state },
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
                        · Updated {new Date(pull.updatedAt).toLocaleString()}
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
            Last refreshed {new Date(query.dataUpdatedAt).toLocaleTimeString()}
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
