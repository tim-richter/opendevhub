import { useLocation } from "@tanstack/react-router";
import { useCallback } from "react";
import type { ComponentProps } from "react";

import { Link } from "../../routing";

/** The search parameter that opens Settings over the current page, naming its section. */
export const SETTINGS_PARAM = "settings";

export const DEFAULT_SECTION = "general";

/** Builds the current page's URL with Settings open at `section`, so closing it lands back here. */
export const useSettingsHref = () => {
  const { pathname, search } = useLocation();
  return useCallback(
    (section: string = DEFAULT_SECTION, hash?: string): string => {
      const params = new URLSearchParams(search as Record<string, string>);
      params.set(SETTINGS_PARAM, section);
      return `${pathname}?${params.toString()}${hash ? `#${hash}` : ""}`;
    },
    [pathname, search]
  );
};

/** A link that opens Settings at `section` over the current page. */
export const SettingsLink = ({
  section,
  hash,
  ...props
}: Omit<ComponentProps<typeof Link>, "to"> & {
  section?: string;
  hash?: string;
}) => {
  const href = useSettingsHref();
  return <Link to={href(section, hash)} {...props} />;
};
