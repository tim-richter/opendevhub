import type { Query } from "@tanstack/react-query";
import type {
  PersistedClient,
  PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";

import { version } from "../../../package.json";

const IDB_KEY = "opendevhub-query-cache";
/**
 * Bump when a persisted response changes shape: the version only changes on release, so without this a dev build
 * (or anyone between releases) restores responses the new code can't read.
 */
const CACHE_SHAPE = 2;
const DAY_MS = 24 * 60 * 60_000;

/** How long a cached response may be restored after a reload; queries must stay in memory as long. */
export const PERSIST_MAX_AGE_MS = DAY_MS;

/**
 * Diffs can run to megabytes and the whole cache is rewritten on every change; the git setup is live machine state
 * that a restored copy would only show stale, and so is where a base stands against its upstream.
 */
const UNPERSISTED_KEYS = new Set([
  "patch",
  "review",
  "local-links",
  "git-setup",
  "base-position",
]);

const shouldPersist = (query: Query): boolean =>
  query.state.status === "success" &&
  !query.queryKey.some(
    (part) => typeof part === "string" && UNPERSISTED_KEYS.has(part)
  );

export const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
  // A new release may change response shapes; start over rather than render stale ones.
  buster: `${version}+${CACHE_SHAPE}`,
  dehydrateOptions: { shouldDehydrateQuery: shouldPersist },
  maxAge: PERSIST_MAX_AGE_MS,
  persister: {
    persistClient: async (client: PersistedClient) => {
      await set(IDB_KEY, client);
    },
    removeClient: async () => {
      await del(IDB_KEY);
    },
    restoreClient: async () => await get<PersistedClient>(IDB_KEY),
  },
};
