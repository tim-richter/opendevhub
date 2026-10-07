import type { ApiContext } from "waku/router";
import { unstable_notFound } from "waku/router/server";

import { docsLlms, source } from "@/lib/source";

export const GET = async (
  _: Request,
  { params }: ApiContext<"/llms.mdx/docs/[...slugs]/content.md">
) => {
  const { slugs } = params;
  const page = source.getPage(slugs);
  if (!page) {
    unstable_notFound();
  }

  return new Response(await docsLlms.page(page), {
    headers: {
      "Content-Type": "text/markdown",
    },
  });
};

export const getConfig = async () => {
  const pages = source
    .generateParams()
    .map((item) => (item.lang ? [item.lang, ...item.slug] : item.slug));

  return {
    render: "static" as const,
    staticPaths: pages,
  } as const;
};
