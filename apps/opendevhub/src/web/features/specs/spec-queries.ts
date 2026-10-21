import { queryOptions } from "@tanstack/react-query";

import { fetchSpec } from "../../api";

/** A checkout's spec views, whichever change they show. */
export const specKey = (projectId: string, directory: string) =>
  ["spec", projectId, directory] as const;

/**
 * A checkout's OpenSpec changes as `session`'s variant sees them, showing `change` (which the server then records
 * for it) or the one the server picks.
 */
export const specQuery = (
  projectId: string,
  directory: string,
  session?: string,
  change?: string
) =>
  queryOptions({
    queryFn: ({ signal }) =>
      fetchSpec(projectId, directory, { change, session }, signal),
    queryKey: [
      ...specKey(projectId, directory),
      session ?? null,
      change ?? null,
    ],
    // The agent edits the spec in the checkout; read it again on visits and when its turn ends.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
