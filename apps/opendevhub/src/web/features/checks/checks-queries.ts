import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import type { ChecksView } from "../../../shared/types";
import { fetchCheckRun, fetchChecks } from "../../api";
import { isRunning, withRun } from "./checks";

const POLL_MS = 1000;

/** A checkout's checks, or with no directory the project's configured ones; the latter prefixes the former. */
export const checksKey = (projectId: string, directory?: string) =>
  directory === undefined
    ? (["checks", projectId] as const)
    : (["checks", projectId, directory] as const);

/**
 * A checkout's checks and latest run. While a run goes it polls only the run, and reads everything
 * again once it ends.
 */
export const checksQuery = (
  queryClient: QueryClient,
  projectId: string,
  directory: string
) => {
  const queryKey = checksKey(projectId, directory);
  return queryOptions({
    queryFn: async ({ signal }): Promise<ChecksView> => {
      const previous = queryClient.getQueryData<ChecksView>(queryKey);
      if (previous && isRunning(previous.run)) {
        const run = await fetchCheckRun(projectId, directory, signal);
        if (isRunning(run)) {
          return withRun(previous, run);
        }
      }
      return fetchChecks(projectId, directory, signal);
    },
    queryKey,
    refetchInterval: (query) =>
      isRunning(query.state.data?.run) ? POLL_MS : false,
    // The checkout changes outside the app; show the last result and read it again on every visit.
    staleTime: 0,
  });
};

/** The project's checks as configured, for its settings. */
export const projectChecksQuery = (projectId: string) =>
  queryOptions({
    queryFn: ({ signal }) => fetchChecks(projectId, undefined, signal),
    queryKey: checksKey(projectId),
  });
