import { useQuery } from "@tanstack/react-query";

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
