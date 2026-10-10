import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { JiraTicket } from "../../../shared/jira";
import { fetchTicketLinks } from "../../api";
import { useDash } from "../../dashboard-context";

/** A Jira request, cached per instance so revisiting a page shows the last result while it refreshes. */
export const useJiraQuery = <T>(
  key: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>
) => {
  const { jira } = useDash();
  return useQuery({
    enabled: !!jira?.enabled,
    queryFn: ({ signal }) => load(signal),
    queryKey: ["jira", jira?.url, ...key],
  });
};

/**
 * The tasks started from a ticket and their pull requests, from opendevhub's records. Fetched again when the number
 * of tasks in the snapshot changes, so a task just started from the ticket shows up.
 */
export const useTicketLinks = (
  ticket: Pick<JiraTicket, "instanceUrl" | "key"> | undefined
) => {
  const { snapshot } = useDash();
  const tasks = snapshot?.projects.reduce((n, v) => n + v.tasks.length, 0) ?? 0;
  return useQuery({
    enabled: !!ticket,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      fetchTicketLinks(ticket?.instanceUrl ?? "", ticket?.key ?? "", signal),
    queryKey: ["links", "ticket", ticket?.instanceUrl, ticket?.key, tasks],
  });
};
