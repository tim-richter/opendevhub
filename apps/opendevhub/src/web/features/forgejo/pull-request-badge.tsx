import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import type { PullRequestRef } from "../../../shared/types";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { forgejoRoute } from "./forgejo";

/** A pull request opendevhub knows, as a badge: `PR #12 · merged`, linking to its page here or on its forge. */
export const PullRequestBadge = ({
  pull,
  prefix,
}: {
  pull: PullRequestRef;
  /** Leads the label, e.g. the variant it came from. */
  prefix?: string;
}) => {
  const { forgejo } = useDash();
  const number =
    pull.number === undefined ? "Pull request" : `PR #${pull.number}`;
  const label = [prefix, number, pull.state].filter(Boolean).join(" · ");
  const internal = forgejo?.enabled
    ? forgejoRoute(pull.url, forgejo.url)
    : undefined;
  const title = [
    pull.title,
    pull.fetchedAt === undefined
      ? undefined
      : `as of ${new Date(pull.fetchedAt).toLocaleString()}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Badge
      variant="outline"
      asChild
      className="gap-1 font-sans font-normal"
      title={title || undefined}
    >
      {internal ? (
        <Link to={internal}>
          <GitPullRequestIcon className="size-3" /> {label}
        </Link>
      ) : (
        <a href={pull.url} target="_blank" rel="noopener noreferrer">
          <GitPullRequestIcon className="size-3" /> {label}
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </Badge>
  );
};
