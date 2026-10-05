import { defineConfig } from 'waku/config';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Served from GitHub Pages at https://tim-richter.github.io/opendevhub/
  basePath: '/opendevhub/',
  vite: {
    resolve: {
      tsconfigPaths: true,
      dedupe: ['waku'],
    },

    plugins: [tailwindcss(), fumadocsMdx()],
  },
});
