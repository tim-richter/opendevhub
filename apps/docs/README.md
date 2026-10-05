# docs

The opendevhub documentation site at https://tim-richter.github.io/opendevhub/, built with [Waku](https://waku.gg) and [Fumadocs](https://fumadocs.dev). Pages are MDX files in `content/docs`; `content/docs/meta.json` sets the sidebar order.

```bash
pnpm dev:docs                  # from the repo root; open http://localhost:3000/opendevhub/
pnpm --filter docs build       # static site in dist/public
```

The site is fully static so GitHub Pages can serve it: `basePath` in `waku.config.ts` matches the Pages sub-path, and search uses an index exported at build time (`src/pages/_api/api/search.ts`) that the browser searches itself. `.github/workflows/docs.yml` deploys it on every push to `main` that touches `apps/docs`.
