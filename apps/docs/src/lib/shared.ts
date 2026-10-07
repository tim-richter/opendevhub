import { createGetUrl } from "fumadocs-core/source";

export const appName = "opendevhub";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";
// basePath from waku.config.ts, without the trailing slash
export const basePath = import.meta.env.BASE_URL.replace(/\/$/u, "");

export const gitConfig = {
  branch: "main",
  repo: "opendevhub",
  user: "tim-richter",
};

const getContentUrl = createGetUrl(basePath + docsContentRoute);

export const getPageMarkdownUrl = (page: {
  slugs: string[];
  locale?: string;
}) => {
  const segments = [...page.slugs, "content.md"];

  return { segments, url: getContentUrl(segments, page.locale) };
};

const getImageUrl = createGetUrl(basePath + docsImageRoute);

export const getPageImageUrl = (page: { slugs: string[]; locale?: string }) => {
  const segments = [...page.slugs, "image.webp"];

  return { segments, url: getImageUrl(segments, page.locale) };
};
