import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GitBranchIcon, ListTodoIcon, SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { ForgejoPullDetails } from "../../../shared/forgejo";
import type { PullLinks, StoredAiReview } from "../../../shared/types";
import { fetchPullLinks } from "../../api";
import { Chip, Section } from "../../components/page";
import { When } from "../../components/when";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { checkoutOf, checkoutPath } from "../checkouts/checkouts";
import { taskPath } from "../tasks/tasks";

const SHORT_SHA = 8;

/**
 * What opendevhub knows about a pull request, from its records. Fetched again when the number of tasks in the
 * snapshot changes or `revision` does (say, when an AI review finishes).
 */
export const usePullLinks = (url: string, revision?: unknown) => {
  const { snapshot } = useDash();
  const tasks = snapshot?.projects.reduce((n, v) => n + v.tasks.length, 0) ?? 0;
  return useQuery({
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchPullLinks(url, signal),
    queryKey: ["links", "pull", url, tasks, revision],
  });
};

/** The tasks that made the pull request: variants whose branch was published as its head. */
const madeBy = (links: PullLinks) =>
  links.branches.flatMap((b) =>
    b.role === "head" && b.task ? [{ ...b.task, projectId: b.projectId }] : []
  );

/** "Made by task …" and the live checkouts opendevhub made for the pull request, as one line of links. */
export const PullOrigins = ({ links }: { links: PullLinks }) => {
  const { snapshot } = useDash();
  const tasks = madeBy(links);
  const checkouts = links.branches.flatMap((b) =>
    b.role === "checkout"
      ? b.worktrees.flatMap((w) => {
          if (w.removed) {
            return [];
          }
          const view = snapshot?.projects.find(
            (p) => p.project.id === b.projectId
          );
          const checkout = view && checkoutOf(view, w.path);
          return view && checkout ? [{ branch: b.name, checkout, view }] : [];
        })
      : []
  );
  if (tasks.length === 0 && checkouts.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {tasks.map((t) => (
        <Link
          key={`${t.id}/${t.n}`}
          to={taskPath(t.projectId, t.id)}
          className="text-foreground inline-flex items-center gap-1.5 hover:underline"
        >
          <ListTodoIcon className="text-muted-foreground size-3.5" />
          Made by task {t.title || t.id}
          <span className="text-muted-foreground">· variant {t.n}</span>
        </Link>
      ))}
      {checkouts.map(({ view, checkout, branch }) => (
        <Link
          key={`${view.project.id}:${checkout.directory}`}
          to={checkoutPath(view.project.id, checkout.target)}
          className="text-foreground inline-flex items-center gap-1.5 hover:underline"
        >
          <GitBranchIcon className="text-muted-foreground size-3.5" />
          Checked out in {view.project.name} › {branch}
        </Link>
      ))}
    </p>
  );
};

/** The AI reviews stored for the pull request, newest first; one can be shown in the diff again. */
export const EarlierAiReviews = (props: {
  reviews: StoredAiReview[];
  details: ForgejoPullDetails;
  /** The stored review whose findings the diff shows now, if any. */
  openId?: number;
  onOpen: (review: StoredAiReview) => void;
}) => {
  if (props.reviews.length === 0) {
    return null;
  }
  return (
    <Section title="Earlier AI reviews" hint={props.reviews.length}>
      <ul className="divide-y">
        {props.reviews.map((r) => {
          const outdated = r.headSha !== props.details.headSha;
          return (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
            >
              <SparklesIcon className="text-primary size-4 shrink-0" />
              <When at={r.createdAt} className="text-muted-foreground" />
              <code className="text-muted-foreground text-xs">
                {r.headSha.slice(0, SHORT_SHA)}
              </code>
              {outdated && (
                <Chip title="Made against an older head commit">outdated</Chip>
              )}
              <span className="text-muted-foreground">
                {r.mode === "quick" ? "quick" : "agent"} · {r.findings.length}{" "}
                finding{r.findings.length === 1 ? "" : "s"}
              </span>
              <span className="min-w-0 flex-1 truncate" title={r.summary}>
                {r.summary}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={props.openId === r.id}
                onClick={() => props.onOpen(r)}
              >
                {props.openId === r.id ? "In the diff" : "Show in diff"}
              </Button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
};
