import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  EyeIcon,
  MessageSquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type {
  ForgejoCheck,
  ForgejoComment,
  ForgejoPullDetails,
  ForgejoReview,
} from "../../shared/forgejo";
import {
  fetchForgejoChecks,
  fetchForgejoComments,
  fetchForgejoReviewComments,
  fetchForgejoReviews,
} from "../api";
import { forgejoReviewers } from "../forgejo";
import { useForgejoPages, useForgejoQuery } from "../hooks/useForgejo";
import { MarkdownBody } from "./MarkdownBody";
import { Chip, Note, PanelSection, Section } from "./Page";

export interface ForgejoFeedback {
  comments: ForgejoComment[];
  reviews: ForgejoReview[];
  checks: ForgejoCheck[];
}
export const RequestState = ({
  query,
}: {
  query: { isPending: boolean; error: Error | null; refetch: () => unknown };
}) => (
  <>
    {query.isPending && (
      <p role="status" className="text-muted-foreground p-4 text-sm">
        Loading…
      </p>
    )}
    {query.error && (
      <div role="alert" className="p-4">
        <Note warn>{query.error.message}</Note>
        <Button variant="link" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    )}
  </>
);
const More = ({
  query,
}: {
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => unknown;
  };
}) =>
  query.hasNextPage && (
    <Button
      className="m-4"
      variant="outline"
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    >
      {query.isFetchingNextPage ? "Loading…" : "Load more"}
    </Button>
  );
const SelectFeedback = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) => (
  <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
    {label}
  </label>
);
type TimelineEntry =
  | { kind: "review"; at: string; review: ForgejoReview }
  | { kind: "comment"; at: string; comment: ForgejoComment };

/** Review states that are requests or drafts rather than something someone said. */
const HIDDEN_REVIEW_STATES = new Set(["REQUEST_REVIEW"]);

const reviewVerb: Record<string, string> = {
  APPROVED: "approved",
  COMMENT: "reviewed",
  PENDING: "has a pending review",
  REQUEST_CHANGES: "requested changes",
};

const reviewIcon = (state: string) => {
  if (state === "APPROVED") {
    return <CircleCheckIcon className="text-ok size-4 shrink-0" />;
  }
  if (state === "REQUEST_CHANGES") {
    return <CircleXIcon className="text-destructive size-4 shrink-0" />;
  }
  return <EyeIcon className="text-muted-foreground size-4 shrink-0" />;
};

const checkIcon = (status: string) => {
  if (status === "success") {
    return <CircleCheckIcon className="text-ok size-4" />;
  }
  if (status === "failure" || status === "error") {
    return <CircleXIcon className="text-destructive size-4" />;
  }
  if (status === "warning") {
    return <TriangleAlertIcon className="text-warn size-4" />;
  }
  return <CircleDashedIcon className="text-warn size-4" />;
};

const reviewerStatus: Record<string, { label: string; className: string }> = {
  APPROVED: { className: "text-ok", label: "Approved" },
  COMMENT: { className: "text-muted-foreground", label: "Commented" },
  REQUEST_CHANGES: {
    className: "text-destructive",
    label: "Changes requested",
  },
  REQUEST_REVIEW: { className: "text-warn", label: "Requested" },
};

const formatTime = (at: string) => (at ? new Date(at).toLocaleString() : "");

/**
 * The pull request's description and conversation, with a sidebar of its stack, checks and
 * reviewers that stays in view while the conversation scrolls.
 */
export const ForgejoContext = ({
  details,
  description,
  stack,
  onSelection,
}: {
  details: ForgejoPullDetails;
  description: ReactNode;
  stack: ReactNode;
  onSelection: (feedback: ForgejoFeedback) => void;
}) => {
  const { owner, repo, number } = details.pull;
  const args = [owner, repo, String(number)] as const;
  const key = ["pull", ...args];
  const comments = useForgejoPages([...key, "comments"], (page, signal) =>
    fetchForgejoComments(...args, page, signal)
  );
  const reviews = useForgejoPages([...key, "reviews"], (page, signal) =>
    fetchForgejoReviews(...args, page, signal)
  );
  const checks = useForgejoPages(
    ["checks", owner, repo, details.headSha],
    (page, signal) =>
      fetchForgejoChecks(owner, repo, details.headSha, page, signal),
    !!details.headSha
  );
  const [selected, setSelected] = useState<
    Record<
      string,
      {
        kind: keyof ForgejoFeedback;
        value: ForgejoComment | ForgejoReview | ForgejoCheck;
      }
    >
  >({});
  const pick = (
    kind: keyof ForgejoFeedback,
    value: ForgejoComment | ForgejoReview | ForgejoCheck,
    checked: boolean
  ) => {
    const next = { ...selected };
    const id = `${kind}-${value.id}`;
    if (checked) {
      next[id] = { kind, value };
    } else {
      delete next[id];
    }
    setSelected(next);
    onSelection({
      checks: Object.values(next)
        .filter((v) => v.kind === "checks")
        .map((v) => v.value as ForgejoCheck),
      comments: Object.values(next)
        .filter((v) => v.kind === "comments")
        .map((v) => v.value as ForgejoComment),
      reviews: Object.values(next)
        .filter((v) => v.kind === "reviews")
        .map((v) => v.value as ForgejoReview),
    });
  };
  const commentCard = (c: ForgejoComment) => (
    <article
      key={c.id}
      className="flex flex-col gap-2 border-b p-4 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <MessageSquareIcon className="text-muted-foreground size-4 shrink-0" />
        <strong>{c.author}</strong>
        <span className="text-muted-foreground">
          commented {formatTime(c.updatedAt)}
        </span>
        {c.resolved && <Chip>Resolved</Chip>}
      </div>
      {c.path && (
        <p className="font-mono text-xs break-all">
          {c.path}:{c.line || c.oldLine || "?"}
        </p>
      )}
      <MarkdownBody>{c.body}</MarkdownBody>
      {c.diffHunk && (
        <details>
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Diff context
          </summary>
          <pre className="overflow-x-auto p-2 text-xs">{c.diffHunk}</pre>
        </details>
      )}
      <SelectFeedback
        label="Include in agent handoff"
        checked={!!selected[`comments-${c.id}`]}
        onChange={(checked) => pick("comments", c, checked)}
      />
    </article>
  );
  const reviewCard = (r: ForgejoReview) => (
    <article
      key={`review-${r.id}`}
      className="flex flex-col gap-2 border-b p-4 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {reviewIcon(r.state)}
        <strong>{r.author}</strong>
        <span className="text-muted-foreground">
          {reviewVerb[r.state] ?? r.state.toLowerCase().replaceAll("_", " ")}{" "}
          {formatTime(r.submittedAt)}
        </span>
        {r.commit && (
          <code className="text-muted-foreground text-xs">
            {r.commit.slice(0, 10)}
          </code>
        )}
        {r.dismissed && <Chip>Dismissed</Chip>}
        {r.stale && <Chip>Stale</Chip>}
      </div>
      {r.body && <MarkdownBody>{r.body}</MarkdownBody>}
      <SelectFeedback
        label="Include review in agent handoff"
        checked={!!selected[`reviews-${r.id}`]}
        onChange={(checked) => pick("reviews", r, checked)}
      />
      {!!r.commentsCount && (
        <ReviewComments
          args={args}
          review={r.id}
          count={r.commentsCount}
          render={commentCard}
        />
      )}
    </article>
  );
  const allComments = unique(
    comments.data?.pages.flatMap((p) => p.items) ?? []
  );
  const allReviews = unique(reviews.data?.pages.flatMap((p) => p.items) ?? []);
  const allChecks = unique(checks.data?.pages.flatMap((p) => p.items) ?? []);
  const timeline: TimelineEntry[] = [
    ...allReviews
      .filter((r) => !HIDDEN_REVIEW_STATES.has(r.state))
      .map((review): TimelineEntry => ({
        at: review.submittedAt,
        kind: "review",
        review,
      })),
    ...allComments.map((comment): TimelineEntry => ({
      at: comment.updatedAt,
      comment,
      kind: "comment",
    })),
  ].toSorted((a, b) => a.at.localeCompare(b.at));
  const reviewers = forgejoReviewers(allReviews, details.reviewers);
  const passed = allChecks.filter((c) => c.status === "success").length;
  const loadedConversation = !!comments.data && !!reviews.data;
  const moreConversation = {
    fetchNextPage: () => {
      if (comments.hasNextPage) {
        void comments.fetchNextPage();
      }
      if (reviews.hasNextPage) {
        void reviews.fetchNextPage();
      }
    },
    hasNextPage: comments.hasNextPage || reviews.hasNextPage,
    isFetchingNextPage:
      comments.isFetchingNextPage || reviews.isFetchingNextPage,
  };
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="gap-0 divide-y overflow-hidden py-0 lg:sticky lg:top-4 lg:col-start-2 lg:row-start-1 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
        {stack}
        <PanelSection
          title="Checks"
          hint={
            allChecks.length
              ? `${passed} of ${allChecks.length} passed`
              : undefined
          }
        >
          {details.headSha ? (
            <RequestState query={checks} />
          ) : (
            <p className="text-muted-foreground px-4 text-sm">
              The head commit is unavailable. Open the pull request in Forgejo
              to see its checks.
            </p>
          )}
          {checks.data && !allChecks.length && (
            <p className="text-muted-foreground px-4 text-sm">
              No checks reported for this commit.
            </p>
          )}
          {!!allChecks.length && (
            <ul>
              {allChecks.map((c) => (
                <li key={c.id} className="flex items-start gap-2 px-4 py-1.5">
                  <input
                    type="checkbox"
                    className="accent-primary mt-1 shrink-0"
                    aria-label={`Include ${c.name} in agent handoff`}
                    checked={!!selected[`checks-${c.id}`]}
                    onChange={(e) => pick("checks", c, e.target.checked)}
                  />
                  <span className="mt-0.5 shrink-0">
                    {checkIcon(c.status)}
                    <span className="sr-only">{c.status}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm">{c.name}</span>
                      {c.url && (
                        <a
                          className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs underline"
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Details
                        </a>
                      )}
                    </span>
                    {c.description && (
                      <span
                        className="text-muted-foreground line-clamp-2 block text-xs break-words"
                        title={c.description}
                      >
                        {c.description}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!!allChecks.length && (
            <p className="text-muted-foreground px-4 pt-1 text-xs">
              Ticked checks are included when you continue with an agent.
            </p>
          )}
          <More query={checks} />
        </PanelSection>
        <PanelSection title="Reviewers">
          <RequestState query={reviews} />
          {reviews.data && !reviewers.length && (
            <p className="text-muted-foreground px-4 text-sm">
              No reviewers yet.
            </p>
          )}
          {!!reviewers.length && (
            <ul>
              {reviewers.map((r) => {
                const status = reviewerStatus[r.state];
                return (
                  <li
                    key={r.name}
                    className="flex items-baseline justify-between gap-2 px-4 py-1 text-sm"
                  >
                    <span className="truncate">{r.name}</span>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        status?.className ?? "text-muted-foreground"
                      )}
                    >
                      {status?.label ?? r.state.toLowerCase()}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </PanelSection>
      </Card>
      <div className="flex min-w-0 flex-col gap-4">
        {description}
        <Section title="Conversation">
          <RequestState query={comments} />
          <RequestState query={reviews} />
          {loadedConversation && !timeline.length && (
            <p className="text-muted-foreground p-4 text-sm">
              No comments or reviews yet.
            </p>
          )}
          {timeline.map((entry) =>
            entry.kind === "review"
              ? reviewCard(entry.review)
              : commentCard(entry.comment)
          )}
          <More query={moreConversation} />
        </Section>
      </div>
    </div>
  );
};
const ReviewComments = ({
  args,
  review,
  count,
  render,
}: {
  args: readonly [string, string, string];
  review: number;
  count: number;
  render: (c: ForgejoComment) => ReactNode;
}) => {
  const [expanded, setExpanded] = useState(false);
  const query = useForgejoQuery(
    ["pull", ...args, "review-comments", review],
    (signal) => fetchForgejoReviewComments(...args, review, signal),
    expanded
  );
  return (
    <div>
      <Button
        variant="link"
        className="px-0"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded
          ? "Hide inline comments"
          : `Show ${count} inline comment${count === 1 ? "" : "s"}`}
      </Button>
      {expanded && (
        <>
          <RequestState query={query} />
          {query.data?.map(render)}
        </>
      )}
    </div>
  );
};
const unique = <T extends { id: number }>(items: T[]): T[] => [
  ...new Map(items.map((i) => [i.id, i])).values(),
];
