import { queryOptions } from "@tanstack/react-query";

import { fetchSpec } from "../../api";

/** A checkout's spec views, whichever change they show. */
export const specKey = (projectId: string, directory: string) =>
  ["spec", projectId, directory] as const;

/** A checkout's OpenSpec changes, showing `change` or the one the server picks. */
export const specQuery = (
  projectId: string,
  directory: string,
  change?: string
) =>
  queryOptions({
    queryFn: ({ signal }) => fetchSpec(projectId, directory, change, signal),
    queryKey: [...specKey(projectId, directory), change ?? null],
    // The agent edits the spec in the checkout; read it again on visits and when its turn ends.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
