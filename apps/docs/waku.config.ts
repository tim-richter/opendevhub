import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "waku/config";

export default defineConfig({
  // Served from GitHub Pages at https://tim-richter.github.io/opendevhub/
  basePath: "/opendevhub/",
  vite: {
    plugins: [tailwindcss(), fumadocsMdx()],

    resolve: {
      dedupe: ["waku"],
      tsconfigPaths: true,
    },
  },
});
