import { ExternalLinkIcon, TicketIcon } from "lucide-react";

import { jiraTicketUrl } from "../../../shared/jira";
import type { JiraTaskSource } from "../../../shared/jira";
import type { TicketRef } from "../../../shared/types";
import { MarkdownBody } from "../../components/markdown-body";
import { Chip } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";

/**
 * Keep the original requirements available even when Jira is disabled or unreachable. `ticket` is the ticket as
 * last fetched, for its current status.
 */
export const JiraSourceCard = ({
  source,
  ticket,
}: {
  source: JiraTaskSource;
  ticket?: TicketRef;
}) => {
  const { jira } = useDash();
  return (
    <div className="rounded-lg border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <TicketIcon className="text-muted-foreground size-4" />
        <span className="font-medium">
          {source.key}: {source.title}
        </span>
        {ticket?.status && (
          <Chip
            title={
              ticket.fetchedAt === undefined
                ? undefined
                : `As of ${new Date(ticket.fetchedAt).toLocaleString()}`
            }
          >
            {ticket.status}
          </Chip>
        )}
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
          href={ticket?.url ?? jiraTicketUrl(source)}
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
        {source.description ? (
          <MarkdownBody className="mt-2">{source.description}</MarkdownBody>
        ) : (
          <p className="mt-2">No description provided.</p>
        )}
      </details>
    </div>
  );
};
