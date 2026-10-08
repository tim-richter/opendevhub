import { useQueries } from "@tanstack/react-query";

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
import { useDash } from "../dashboard-context";
import { useForgejoPages } from "./use-forgejo";

const unique = <T extends { id: number }>(items: T[]): T[] => [
  ...new Map(items.map((i) => [i.id, i])).values(),
];

/** Check states that something has to be done about. */
export const FAILED_CHECK = new Set(["failure", "error"]);

/**
 * The pull request's conversation, reviews, checks and every review's inline comments, loaded pages only. Shares
 * its queries with the conversation, so both show the same data.
 */
export const usePullFeedback = (details: ForgejoPullDetails) => {
  const { forgejo } = useDash();
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
  const allComments: ForgejoComment[] = unique(
    comments.data?.pages.flatMap((p) => p.items) ?? []
  );
  const allReviews: ForgejoReview[] = unique(
    reviews.data?.pages.flatMap((p) => p.items) ?? []
  );
  const allChecks: ForgejoCheck[] = unique(
    checks.data?.pages.flatMap((p) => p.items) ?? []
  );
  const withInline = allReviews.filter((r) => r.commentsCount > 0);
  const inline = useQueries({
    queries: withInline.map((r) => ({
      enabled: !!forgejo?.enabled,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchForgejoReviewComments(...args, r.id, signal),
      queryKey: [
        "forgejo",
        forgejo?.url,
        ...key,
        "review-comments",
        r.id,
      ] as const,
    })),
  });
  const inlineComments = unique(inline.flatMap((q) => q.data ?? []));
  return {
    allChecks,
    allComments,
    allReviews,
    checks,
    comments,
    inlineComments,
    reviews,
  };
};
