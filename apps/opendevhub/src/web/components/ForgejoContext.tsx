import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

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
import { useForgejoPages, useForgejoQuery } from "../hooks/useForgejo";
import { Chip, Note, Section } from "./Page";

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
export const ForgejoContext = ({
  details,
  onSelection,
}: {
  details: ForgejoPullDetails;
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
        <strong>{c.author}</strong>
        <span className="text-muted-foreground">
          {c.updatedAt && new Date(c.updatedAt).toLocaleString()}
        </span>
        {c.resolved && <Chip>Resolved</Chip>}
      </div>
      {c.path && (
        <p className="font-mono text-xs break-all">
          {c.path}:{c.line || c.oldLine || "?"}
        </p>
      )}
      <p className="text-sm break-words whitespace-pre-wrap">{c.body}</p>
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
  const allComments = unique(
    comments.data?.pages.flatMap((p) => p.items) ?? []
  );
  const allReviews = unique(reviews.data?.pages.flatMap((p) => p.items) ?? []);
  const allChecks = unique(checks.data?.pages.flatMap((p) => p.items) ?? []);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Section title="Checks" hint={details.headSha.slice(0, 10)}>
        {details.headSha ? (
          <RequestState query={checks} />
        ) : (
          <Note>
            PR head commit unavailable; open Forgejo to inspect checks.
          </Note>
        )}
        {checks.data && !allChecks.length && (
          <p className="text-muted-foreground p-4 text-sm">
            No checks reported for this commit.
          </p>
        )}
        {allChecks.map((c) => (
          <article
            key={c.id}
            className="flex flex-col gap-2 border-b p-4 last:border-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">{c.name}</strong>
              <Chip className={checkStatusClass(c.status)}>{c.status}</Chip>
              {c.url && (
                <a
                  className="text-sm underline"
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Details
                </a>
              )}
            </div>
            <p className="text-sm break-words whitespace-pre-wrap">
              {c.description}
            </p>
            <SelectFeedback
              label="Include in agent handoff"
              checked={!!selected[`checks-${c.id}`]}
              onChange={(checked) => pick("checks", c, checked)}
            />
          </article>
        ))}
        <More query={checks} />
      </Section>
      <Section
        title="Reviews"
        hint={
          details.reviewers.length
            ? `Requested: ${details.reviewers.join(", ")}`
            : undefined
        }
      >
        <RequestState query={reviews} />
        {reviews.data && !allReviews.length && (
          <p className="text-muted-foreground p-4 text-sm">No reviews yet.</p>
        )}
        {allReviews.map((r) => (
          <article
            key={r.id}
            className="flex flex-col gap-2 border-b p-4 last:border-0"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <strong>{r.author}</strong>
              <Chip>{r.state.replaceAll("_", " ")}</Chip>
              {r.dismissed && <Chip>Dismissed</Chip>}
              {r.stale && <Chip>Stale</Chip>}
            </div>
            <p className="text-muted-foreground text-xs">
              {r.submittedAt && new Date(r.submittedAt).toLocaleString()} ·{" "}
              {r.commit?.slice(0, 10)}
            </p>
            <p className="text-sm break-words whitespace-pre-wrap">{r.body}</p>
            <SelectFeedback
              label="Include review in agent handoff"
              checked={!!selected[`reviews-${r.id}`]}
              onChange={(checked) => pick("reviews", r, checked)}
            />
            {!!r.commentsCount && (
              <ReviewComments args={args} review={r.id} render={commentCard} />
            )}
          </article>
        ))}
        <More query={reviews} />
      </Section>
      <Section title="Discussion" className="lg:col-span-2">
        <RequestState query={comments} />
        {comments.data && !allComments.length && (
          <p className="text-muted-foreground p-4 text-sm">No comments yet.</p>
        )}
        {allComments.map(commentCard)}
        <More query={comments} />
      </Section>
    </div>
  );
};
const ReviewComments = ({
  args,
  review,
  render,
}: {
  args: readonly [string, string, string];
  review: number;
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
        {expanded ? "Hide inline comments" : "Show inline comments"}
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

const checkStatusClass = (status: string): string => {
  if (status === "success") {
    return "text-ok";
  }
  return ["failure", "error"].includes(status) ? "text-destructive" : "";
};
