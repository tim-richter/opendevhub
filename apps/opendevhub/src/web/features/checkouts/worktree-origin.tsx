import { ExternalLinkIcon, GitPullRequestIcon, TicketIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { forgejoRoute } from "../forgejo/forgejo";

const PR_NUMBER = /\/(?:pulls|pull|merge_requests)\/(?<n>\d+)\/?$/u;
const JIRA_BROWSE = /\/browse\/(?<key>[^/?#]+)\/?$/u;

/** How to show an origin URL: its label, icon and, when opendevhub has a page for it, that page. */
const describe = (
  origin: string,
  forgejoUrl: string | undefined,
  jiraUrl: string | undefined
) => {
  const pr = PR_NUMBER.exec(origin)?.groups?.n;
  if (pr) {
    return {
      Icon: GitPullRequestIcon,
      internal: forgejoRoute(origin, forgejoUrl),
      label: `PR #${pr}`,
    };
  }
  const key = JIRA_BROWSE.exec(origin)?.groups?.key;
  if (key) {
    const ticket = decodeURIComponent(key);
    const base = jiraUrl?.replace(/\/$/u, "");
    return {
      Icon: TicketIcon,
      internal:
        base && origin.startsWith(`${base}/`)
          ? `/jira/${encodeURIComponent(ticket)}`
          : undefined,
      label: ticket,
    };
  }
  return { Icon: ExternalLinkIcon, internal: undefined, label: "Origin" };
};

/** A badge linking back to the pull request or ticket this worktree was created for. */
export const WorktreeOrigin = ({ origin }: { origin: string }) => {
  const { forgejo, jira } = useDash();
  const { Icon, internal, label } = describe(
    origin,
    forgejo?.enabled ? forgejo.url : undefined,
    jira?.enabled ? jira.url : undefined
  );
  const title = `Created for ${label}`;
  return (
    <Badge
      variant="outline"
      asChild
      className="gap-1 font-sans font-normal"
      title={title}
    >
      {internal ? (
        <Link to={internal}>
          <Icon className="size-3" /> From {label}
        </Link>
      ) : (
        <a href={origin} target="_blank" rel="noopener noreferrer">
          <Icon className="size-3" /> From {label}
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </Badge>
  );
};
