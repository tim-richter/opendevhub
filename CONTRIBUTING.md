# Contributing

This is a pnpm workspace:

- `apps/opendevhub`: the CLI, server and dashboard (published to npm as `opendevhub`)
- `apps/docs`: the documentation site at https://tim-richter.github.io/opendevhub/ ([Waku](https://waku.gg) + [Fumadocs](https://fumadocs.dev)), content in `apps/docs/content/docs`

```bash
pnpm install
pnpm test               # unit + integration tests
pnpm test:e2e           # real devcontainer + opencode (slow, needs Docker)
OPENDEVHUB_ROUTE=gateway pnpm test:e2e   # the same, through the gateway (the macOS path)
pnpm dev                # API server + live UI (Vite HMR, TanStack devtools) on :7777
pnpm dev:web            # standalone Vite dev server that proxies /api to :7777
pnpm dev:docs           # docs site
pnpm storybook          # dashboard pages and components on :6006, API mocked with MSW
pnpm build              # apps/opendevhub/dist (bin.js + web) and apps/docs/dist
```

On macOS, the port forwarder tests use `127.0.0.2` and `127.0.0.3`, which macOS does not configure by default: `sudo ifconfig lo0 alias 127.0.0.2 up && sudo ifconfig lo0 alias 127.0.0.3 up`.

## Storybook

Stories live next to the code (`*.stories.tsx`, CSF Next). Page stories render the whole app at a route (`parameters: { route: "/p/acme-web" }`) against [MSW](https://mswjs.io) mocks of every `/api` route, the `/api/events` snapshot stream included. The fixtures are in `src/web/mocks/fixtures.ts`; a story swaps them or fails a route with `beforeEach: mockApi({ snapshot: emptySnapshot }, failing("get", "/api/usage", "..."))`.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets):

1. In a PR that changes `opendevhub`, run `pnpm changeset`, pick the bump (patch/minor/major) and describe the change for users. Commit the generated `.changeset/*.md`.
2. Once CI (typecheck, unit tests and build) passes on `main`, the Release workflow opens (or updates) a **chore: version packages** PR that bumps the version and writes `apps/opendevhub/CHANGELOG.md`.
3. Merging that PR runs CI and then the Release workflow again: it builds, publishes to npm with provenance, pushes the `opendevhub@x.y.z` tag and creates a GitHub release.

npm auth: configure [trusted publishing](https://docs.npmjs.com/trusted-publishers) for `opendevhub` (repo `tim-richter/opendevhub`, workflow `release.yml`). The package has to exist on npm before that can be set up, so the first release needs an `NPM_TOKEN` repository secret (a granular token with publish rights); remove the secret once trusted publishing is configured.
