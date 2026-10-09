import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { fetchPublishInfo } from "../../api";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
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
    enabled: props.enabled,
    queryFn: ({ signal }) =>
      fetchPublishInfo(props.projectId, props.directory, undefined, signal),
    queryKey: ["publish-info", props.projectId, props.directory],
    staleTime: 60_000,
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
