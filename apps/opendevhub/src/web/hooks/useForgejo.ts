import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useDash } from "../DashboardContext";
import type { ForgejoPage } from "../../shared/forgejo";

export function useForgejoQuery<T>(key: readonly unknown[], load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const { forgejo } = useDash();
  return useQuery({ queryKey: ["forgejo", forgejo?.url, ...key], queryFn: ({ signal }) => load(signal),
    enabled: !!forgejo?.enabled && enabled });
}
export function useForgejoPages<T>(key: readonly unknown[], load: (page: number, signal: AbortSignal) => Promise<ForgejoPage<T>>, enabled = true) {
  const { forgejo } = useDash();
  return useInfiniteQuery({ queryKey: ["forgejo", forgejo?.url, ...key],
    queryFn: ({ pageParam, signal }) => load(pageParam, signal), initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage, enabled: !!forgejo?.enabled && enabled });
}
