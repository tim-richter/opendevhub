import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

// Exported at build time and searched in the browser, since GitHub Pages can't run a server.
export const { staticGET: GET } = createFromSource(source);

export const getConfig = async () =>
  ({
    render: "static" as const,
  }) as const;
