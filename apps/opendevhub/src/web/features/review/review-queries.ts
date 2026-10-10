import { queryOptions, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { DashboardSnapshot, ReviewMode } from "../../../shared/types";
import { fetchPublishInfo, fetchReview } from "../../api";
import { checksKey } from "../checks/checks-queries";
import { specKey } from "../specs/spec-queries";

const DIFF_GC_MS = 5 * 60_000;

export interface ReviewOptions {
  base?: string;
  mode?: ReviewMode;
  /** Turn mode: the session and the prompt whose turn to show. */
  session?: string;
  from?: string;
}

/** A checkout's diffs, whichever options they were read with. */
export const reviewKey = (projectId: string, directory: string) =>
  ["review", projectId, directory] as const;

/** A checkout's changes. Diffs can be large, so they leave memory soon after the page does. */
export const reviewQuery = (
  projectId: string,
  directory: string,
  options: ReviewOptions = {}
) =>
  queryOptions({
    gcTime: DIFF_GC_MS,
    queryFn: ({ signal }) => fetchReview(projectId, directory, options, signal),
    queryKey: [...reviewKey(projectId, directory), options],
    // A diff that moves under the cursor loses comment boxes; refresh on visits and agent turns only.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

/** The checkout's remotes, forge and pull request; for one remote, or the default one. */
export const publishInfoQuery = (
  projectId: string,
  directory: string,
  remote?: string
) =>
  queryOptions({
    queryFn: ({ signal }) =>
      fetchPublishInfo(projectId, directory, remote, signal),
    queryKey:
      remote === undefined
        ? ["publish-info", projectId, directory]
        : ["publish-info", projectId, directory, remote],
    staleTime: 60_000,
  });

/** Reads a checkout's changes, checks and spec again, wherever they are shown. */
export const refreshCheckout = (
  queryClient: QueryClient,
  projectId: string,
  directory: string
) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: reviewKey(projectId, directory),
    }),
    // A commit makes the last check run out of date.
    queryClient.invalidateQueries({
      queryKey: checksKey(projectId, directory),
    }),
    queryClient.invalidateQueries({ queryKey: specKey(projectId, directory) }),
  ]);

/** Refreshes a checkout when an agent working there stops, e.g. at the end of its turn. */
export const useRefreshFinishedCheckouts = (
  snapshot: DashboardSnapshot | undefined
) => {
  const queryClient = useQueryClient();
  const running = useRef(
    new Map<string, { projectId: string; directory: string }>()
  );
  useEffect(() => {
    if (!snapshot) {
      return;
    }
    const now = new Map<string, { projectId: string; directory: string }>();
    for (const view of snapshot.projects) {
      for (const session of view.sessions) {
        if (session.status === "running") {
          now.set(session.id, {
            directory: session.directory,
            projectId: view.project.id,
          });
        }
      }
    }
    for (const [id, where] of running.current) {
      if (!now.has(id)) {
        void refreshCheckout(queryClient, where.projectId, where.directory);
      }
    }
    running.current = now;
  }, [snapshot, queryClient]);
};
