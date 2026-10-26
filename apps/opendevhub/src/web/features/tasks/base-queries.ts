import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import type { AppPreferences, BasePosition } from "../../../shared/types";
import {
  fetchBasePosition,
  fetchPreferences,
  pullBase,
  savePreferences,
} from "../../api";

/** Every base position of a project, whichever base and branch they were read for. */
export const basePositionKey = (projectId: string) =>
  ["base-position", projectId] as const;

/**
 * Where a base (the main checkout's own when empty) stands against its upstream. The server fetches when its last
 * fetch is older than five minutes, so reading it again soon is cheap.
 */
export const basePositionQuery = (
  projectId: string,
  base: string,
  branch?: string
) =>
  queryOptions({
    queryFn: ({ signal }) =>
      fetchBasePosition(
        projectId,
        { ...(base ? { base } : {}), ...(branch ? { branch } : {}) },
        signal
      ),
    queryKey: [...basePositionKey(projectId), base, branch ?? ""],
    retry: false,
    staleTime: 30_000,
  });

/** Fetches now, whatever the last fetch's age, and puts the answer where `basePositionQuery` reads it. */
export const useFetchBase = (
  projectId: string,
  base: string,
  branch?: string
) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchBasePosition(projectId, {
        fetch: true,
        ...(base ? { base } : {}),
        ...(branch ? { branch } : {}),
      }),
    onSuccess: (position: BasePosition) =>
      queryClient.setQueryData(
        basePositionQuery(projectId, base, branch).queryKey,
        position
      ),
  });
};

/** Fast-forwards the base to its upstream; every position of the project is read again after. */
export const usePullBase = (
  projectId: string,
  base: string,
  branch?: string
) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      pullBase(projectId, {
        ...(base ? { base } : {}),
        ...(branch ? { branch } : {}),
      }),
    onSuccess: async (position: BasePosition) => {
      queryClient.setQueryData(
        basePositionQuery(projectId, base, branch).queryKey,
        position
      );
      await queryClient.invalidateQueries({
        queryKey: basePositionKey(projectId),
      });
    },
  });
};

export const PREFERENCES_KEY = ["preferences"] as const;

export const preferencesQuery = () =>
  queryOptions({
    queryFn: ({ signal }) => fetchPreferences(signal),
    queryKey: PREFERENCES_KEY,
    staleTime: 60_000,
  });

export const useSavePreferences = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (p: AppPreferences) => savePreferences(p),
    onSuccess: async (saved: AppPreferences) => {
      queryClient.setQueryData(PREFERENCES_KEY, saved);
      // What starting a task would do with the base depends on the setting.
      await queryClient.invalidateQueries({ queryKey: ["base-position"] });
    },
  });
};
