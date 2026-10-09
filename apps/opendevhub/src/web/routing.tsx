import {
  Navigate as RouterNavigate,
  Link as RouterLink,
  useLocation,
  useNavigate as useRouterNavigate,
  useSearch,
} from "@tanstack/react-router";
import type { LinkComponentProps } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

/**
 * The app builds its URLs as plain strings ("/p/acme-web?session=ses_1"); these wrap TanStack Router so a
 * string with a query or hash still lands on the right path, search and hash.
 */

const ORIGIN = "http://opendevhub.local";

/** Search params stay flat strings, as the address bar shows them, instead of TanStack's JSON values. */
export const parseSearch = (search: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(search));

export const stringifySearch = (search: Record<string, unknown>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
};

/** Splits "/path?query#hash" into the `to`, `search` and `hash` TanStack Router navigates with. */
const locationOf = (href: string) => {
  const url = new URL(href, ORIGIN);
  return {
    hash: url.hash.slice(1) || undefined,
    search: parseSearch(url.search),
    to: url.pathname,
  };
};

/** Whether the current path is `to` (with `end`) or under it. */
export const useIsActive = (to: string, end = false): boolean => {
  const { pathname } = useLocation();
  const path = locationOf(to).to;
  if (pathname === path) {
    return true;
  }
  return !end && pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
};

export const Link = ({
  to,
  ...props
}: Omit<LinkComponentProps, "to" | "search" | "hash"> & { to: string }) => (
  <RouterLink {...props} {...locationOf(to)} />
);

export const Navigate = ({
  to,
  replace,
}: {
  to: string;
  replace?: boolean;
}) => <RouterNavigate {...locationOf(to)} replace={replace} />;

export const useNavigate = () => {
  const navigate = useRouterNavigate();
  return useCallback(
    (to: string, options: { replace?: boolean } = {}) =>
      navigate({ ...locationOf(to), ...options }),
    [navigate]
  );
};

type SearchInit = URLSearchParams | Record<string, string>;

/** The current search as `URLSearchParams`, and a setter that keeps the path. */
export const useSearchParams = () => {
  const search = useSearch({ strict: false }) as Record<string, string>;
  const navigate = useRouterNavigate();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const setParams = useCallback(
    (
      next: SearchInit | ((prev: URLSearchParams) => SearchInit),
      options: { replace?: boolean } = {}
    ) =>
      navigate({
        ...options,
        search: (prev: Record<string, string>) =>
          Object.fromEntries(
            new URLSearchParams(
              typeof next === "function"
                ? next(new URLSearchParams(prev))
                : next
            )
          ),
        to: ".",
      }),
    [navigate]
  );
  return [params, setParams] as const;
};
