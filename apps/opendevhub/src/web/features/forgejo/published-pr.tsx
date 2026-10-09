import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { publishInfoQuery } from "../review/review-queries";
import { forgejoRoute } from "./forgejo";

const PR_NUMBER = /\/(?:pulls|pull|merge_requests)\/(?<n>\d+)\/?$/u;

/** A badge for the pull request this checkout's branch was published to, if opendevhub knows one. */
export const PublishedPr = (props: {
  projectId: string;
  directory: string;
  enabled: boolean;
}) => {
  const { forgejo } = useDash();
  const { data } = useQuery({
    ...publishInfoQuery(props.projectId, props.directory),
    enabled: props.enabled,
  });
  const pr = data?.pr;
  if (!pr) {
    return null;
  }
  const number = PR_NUMBER.exec(pr)?.groups?.n;
  const label = number ? `PR #${number}` : "Pull request";
  const internal = forgejo?.enabled ? forgejoRoute(pr, forgejo.url) : undefined;
  return (
    <Badge variant="outline" asChild className="gap-1 font-sans font-normal">
      {internal ? (
        <Link to={internal}>
          <GitPullRequestIcon className="size-3" /> {label}
        </Link>
      ) : (
        <a href={pr} target="_blank" rel="noreferrer">
          <GitPullRequestIcon className="size-3" /> {label}
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </Badge>
  );
};
