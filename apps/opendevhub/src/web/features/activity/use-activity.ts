import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type {
  ActivityEvent,
  ActivityFilter,
  ObjectType,
} from "../../../shared/activity";
import { fetchActivity, fetchProvenance } from "../../api";
import { useDash } from "../../dashboard-context";
import { filterKey, mergeEvents } from "./activity";

interface Older {
  key: string;
  events: ActivityEvent[];
  /** The cursor after the last older page; null once the feed is exhausted. */
  next: number | null | undefined;
}

/**
 * A feed, newest first. The first page is fetched again whenever the snapshot's newest event id changes; older pages
 * are kept as they load, and both are merged by id.
 */
export const useActivity = (filter: ActivityFilter) => {
  const { snapshot, report } = useDash();
  const latestId = snapshot?.activity?.latestId;
  const key = filterKey(filter);
  const head = useQuery({
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchActivity(filter, undefined, signal),
    queryKey: ["activity", key, latestId],
  });
  const [older, setOlder] = useState<Older>({
    events: [],
    key,
    next: undefined,
  });
  const [loading, setLoading] = useState(false);
  // A different feed starts over.
  const current: Older =
    older.key === key ? older : { events: [], key, next: undefined };
  const cursor =
    current.next === undefined ? head.data?.next : (current.next ?? undefined);
  const hasMore = cursor !== undefined;
  const loadMore = useCallback(async () => {
    if (loading || cursor === undefined) {
      return;
    }
    setLoading(true);
    try {
      const page = await fetchActivity(filter, cursor);
      setOlder((prev) => {
        const base = prev.key === key ? prev.events : [];
        return {
          events: mergeEvents(base, page.events),
          key,
          next: page.next ?? null,
        };
      });
    } catch (error) {
      report(error);
    } finally {
      setLoading(false);
    }
  }, [cursor, filter, key, loading, report]);
  return {
    error: head.error,
    events: mergeEvents(head.data?.events ?? [], current.events),
    hasMore,
    isLoading: head.isPending,
    loadMore,
    loadingMore: loading,
  };
};

/** Where an entity came from; fetched again when anything is recorded. */
export const useProvenance = (type: ObjectType, id: string | undefined) => {
  const { snapshot } = useDash();
  const latestId = snapshot?.activity?.latestId;
  return useQuery({
    enabled: id !== undefined && id !== "",
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchProvenance(type, id ?? "", signal),
    queryKey: ["provenance", type, id, latestId],
    retry: false,
  });
};
