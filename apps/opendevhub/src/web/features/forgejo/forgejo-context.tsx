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
  AiFinding,
  ForgejoCheck,
  ForgejoComment,
  ForgejoPullDetails,
  ForgejoReview,
} from "../../../shared/forgejo";
import { fetchForgejoReviewComments } from "../../api";
import { MarkdownBody } from "../../components/markdown-body";
import { Chip, Note, PanelSection, Section } from "../../components/page";
import { When } from "../../components/when";
import { forgejoReviewers } from "./forgejo";
import { useForgejoQuery } from "./use-forgejo";
import { usePullFeedback } from "./use-pull-feedback";

export interface ForgejoFeedback {
  comments: ForgejoComment[];
  reviews: ForgejoReview[];
  checks: ForgejoCheck[];
  ai: AiFinding[];
}

export type FeedbackKind = keyof ForgejoFeedback;
export type FeedbackValue = ForgejoComment | ForgejoReview | ForgejoCheck;

/** Feedback picked for an agent handoff, keyed `<kind>-<id>`. */
export type FeedbackSelection = Record<
  string,
  { kind: FeedbackKind; value: FeedbackValue | AiFinding }
>;

export const feedbackKey = (kind: FeedbackKind, id: number | string) =>
  `${kind}-${id}`;

/** The selection as the handoff wants it, in the order things were picked. */
export const selectedFeedback = (
  selection: FeedbackSelection
): ForgejoFeedback => {
  const of = <T,>(kind: FeedbackKind) =>
    Object.values(selection)
      .filter((v) => v.kind === kind)
      .map((v) => v.value as T);
  return {
    ai: of<AiFinding>("ai"),
    checks: of<ForgejoCheck>("checks"),
    comments: of<ForgejoComment>("comments"),
    reviews: of<ForgejoReview>("reviews"),
  };
};
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
        <Note error>{query.error.message}</Note>
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

/**
 * The pull request's description and conversation, with a sidebar of its stack, checks and
 * reviewers that stays in view while the conversation scrolls.
 */
export const ForgejoContext = ({
  details,
  description,
  stack,
  selected,
  onPick,
  collapsed = false,
}: {
  details: ForgejoPullDetails;
  description: ReactNode;
  stack: ReactNode;
  selected: FeedbackSelection;
  /** Without it nothing can be picked for a handoff. */
  onPick?: (kind: FeedbackKind, value: FeedbackValue, checked: boolean) => void;
  /** Starts with the conversation folded away, for when the diff is what matters. */
  collapsed?: boolean;
}) => {
  const { owner, repo, number } = details.pull;
  const args = [owner, repo, String(number)] as const;
  const { comments, reviews, checks, allComments, allReviews, allChecks } =
    usePullFeedback(details);
  const [showConversation, setShowConversation] = useState(!collapsed);
  const commentCard = (c: ForgejoComment) => (
    <article
      key={c.id}
      className="flex flex-col gap-2 border-b p-4 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <MessageSquareIcon className="text-muted-foreground size-4 shrink-0" />
        <strong>{c.author}</strong>
        <span className="text-muted-foreground">
          commented <When at={c.updatedAt} />
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
      {onPick && (
        <SelectFeedback
          label="Add to handoff"
          checked={!!selected[feedbackKey("comments", c.id)]}
          onChange={(checked) => onPick("comments", c, checked)}
        />
      )}
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
          <When at={r.submittedAt} />
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
      {onPick && (
        <SelectFeedback
          label="Add review to handoff"
          checked={!!selected[feedbackKey("reviews", r.id)]}
          onChange={(checked) => onPick("reviews", r, checked)}
        />
      )}
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
                  {onPick && (
                    <input
                      type="checkbox"
                      className="accent-primary mt-1 shrink-0"
                      aria-label={`Add ${c.name} to handoff`}
                      checked={!!selected[feedbackKey("checks", c.id)]}
                      onChange={(e) => onPick("checks", c, e.target.checked)}
                    />
                  )}
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
          {onPick && !!allChecks.length && (
            <p className="text-muted-foreground px-4 pt-1 text-xs">
              Ticked checks go to the agent with the handoff.
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
        <Section
          title="Conversation"
          hint={
            loadedConversation ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                aria-expanded={showConversation}
                onClick={() => setShowConversation((v) => !v)}
              >
                {showConversation ? "Hide" : `Show ${timeline.length}`}
              </Button>
            ) : undefined
          }
        >
          <RequestState query={comments} />
          <RequestState query={reviews} />
          {showConversation && (
            <>
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
            </>
          )}
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
