import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type { ForgejoPage } from "../../shared/forgejo";
import { useDash } from "../DashboardContext";

export const useForgejoQuery = <T>(
  key: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
  options: { refetchOnWindowFocus?: boolean; refetchOnReconnect?: boolean } = {}
) => {
  const { forgejo } = useDash();
  return useQuery({
    enabled: !!forgejo?.enabled && enabled,
    queryFn: ({ signal }) => load(signal),
    queryKey: ["forgejo", forgejo?.url, ...key],
    ...options,
  });
};
export const useForgejoPages = <T>(
  key: readonly unknown[],
  load: (page: number, signal: AbortSignal) => Promise<ForgejoPage<T>>,
  enabled = true
) => {
  const { forgejo } = useDash();
  return useInfiniteQuery({
    enabled: !!forgejo?.enabled && enabled,
    getNextPageParam: (last: ForgejoPage<T>) => last.nextPage,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => load(pageParam, signal),
    queryKey: ["forgejo", forgejo?.url, ...key],
  });
};
