import { ExternalLinkIcon, TicketIcon } from "lucide-react";
import { Link } from "react-router";

import { jiraTicketUrl } from "../../shared/jira";
import type { JiraTaskSource } from "../../shared/jira";
import { useDash } from "../DashboardContext";

/** Keep the original requirements available even when Jira is disabled or unreachable. */
export const JiraSourceCard = ({ source }: { source: JiraTaskSource }) => {
  const { jira } = useDash();
  return (
    <div className="rounded-lg border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <TicketIcon className="text-muted-foreground size-4" />
        <span className="font-medium">
          {source.key}: {source.title}
        </span>
        {jira?.enabled && jira.url === source.instanceUrl && (
          <Link
            className="text-muted-foreground underline"
            to={`/jira/${encodeURIComponent(source.key)}`}
          >
            Ticket details
          </Link>
        )}
        <a
          className="text-muted-foreground inline-flex items-center gap-1 underline"
          href={jiraTicketUrl(source)}
          target="_blank"
          rel="noreferrer"
        >
          Open in Jira <ExternalLinkIcon className="size-3" />
        </a>
      </div>
      <details className="mt-2">
        <summary className="text-muted-foreground cursor-pointer">
          Ticket description at task creation
        </summary>
        <p className="mt-2 break-words whitespace-pre-wrap">
          {source.description || "No description provided."}
        </p>
      </details>
    </div>
  );
};
