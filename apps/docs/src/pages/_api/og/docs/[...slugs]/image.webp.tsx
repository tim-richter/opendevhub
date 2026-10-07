import { generateOGImage } from "fumadocs-ui/og/takumi";
import type { ApiContext } from "waku/router";

import { appName } from "@/lib/shared";
import { source } from "@/lib/source";

export const GET = async (
  _: Request,
  { params }: ApiContext<"/og/docs/[...slugs]/image.webp">
) => {
  const page = source.getPage(params.slugs);

  if (!page) {
    return new Response(undefined, { status: 404 });
  }

  return generateOGImage({
    description: page.data.description,
    format: "webp",
    site: appName,
    title: page.data.title,
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
