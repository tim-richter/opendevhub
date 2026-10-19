# Design

## Context

See proposal.md for why. The current state that shapes the approach:

- **Server entry.** `server.ts` routes each request by Host header: the dashboard (`localhost:<port>`), an environment's opencode through the proxy (`<env>.localhost:<port>`), or a 421. The dashboard is a Hono app (`createDashboardApp`). The terminal and proxy WebSocket upgrades are handled beside it. Origin checks exist on all three, but nothing authenticates a caller that sends no Origin.
- **Main container.** `Environments.bringUp` runs `devcontainer up` on the project folder. It doesn't read the config first.
- **Task containers.** `Environments.bringUpTask` builds the base image from the worktree (`images.ensureBase`), then reads its config (`readConfig`, which runs `devcontainer read-configuration`). It writes an override config and runs `up`. `ensureTaskEnv` runs `bringUpTask` inside `exclusiveEnv`.
- **Remote nodes.** Remote nodes run the same calls through their kit.
- **Variant setup.** `CheckoutSetup` reports a variant's steps through its sink, and `EnvSetup` passes the image and container steps on. Since the state-bug fixes, a sink can say it was `cancelled` (the variant was discarded).
- **State.** The state database migrates by appending to `MIGRATIONS`. The state folder holds `config.json`, the database and other owner-only files.

## Goals / Non-Goals

**Goals:**

- An agent can't get host-affecting config used, or approve it, without the user.
- Approvals are rare in practice: only host-affecting settings count, and an empty set needs none.
- Most of the change stays out of the Hono routes, so existing API tests keep working.

**Non-Goals:**

- Git hooks, `core.fsmonitor` and other `.git/config` paths to the host. That's a separate change.
- Sandboxing what runs inside containers (lifecycle commands, Dockerfile `RUN`), or remote nodes' own hosts beyond the same gate.
- Multi-user access, accounts or remote access to the dashboard.

## Decisions

### 1. Host-affecting settings come from the resolved, merged configuration

`readConfig` gains `--include-merged-configuration`. It returns the configuration and the `mergedConfiguration`, in which features' metadata (mounts, `privileged`, `capAdd`, `securityOpt`, `init`, `entrypoint`) is merged in. A pure function, `hostSurface(read, files)`, builds a normalized object:

- `initializeCommand` as written;
- `mounts` and `workspaceMount` from the merged form, with feature-added entries marked by feature id;
- `runArgs`, `privileged`, `capAdd`, `securityOpt`, `appPort`;
- `build.context`, resolved against the config file's folder and made relative to the repository root (marked `outside` when it leaves the repository), plus `build.options`; the legacy `context` key likewise;
- for Compose: `service`, `runServices`, and a SHA-256 of each listed file's contents, with the contents kept for the review;
- `entrypoint` and `init` are left out: they run in the container.

The fingerprint is a SHA-256 of the surface's canonical JSON (keys sorted, no whitespace). An empty surface is always allowed.

_Alternatives considered:_

- **Hashing the whole config:** every `postCreateCommand` edit would ask.
- **Listing feature ids:** version bumps would ask even when nothing host-affecting changed. The merged metadata captures what features actually add.

_If the merged read fails_ (feature metadata is fetched from registries, so it can fail offline), the surface falls back to the plain configuration. It adds `features` (ids and options) as a host-affecting key, which errs on the side of asking.

### 2. Approvals in the state database; pending ones in memory

- **Migration:** `config_approvals (id, project_id, fingerprint, surface TEXT, approved_at, UNIQUE (project_id, fingerprint))`.
- **`ConfigApprovals`** (`server/environments/approvals.ts`):
  - `check(project, surface, source)` returns `ok`, or a pending approval: id = fingerprint, sources, surface, and the diff to the closest approval;
  - `approve(project, fingerprint)` and `refuse(project, fingerprint)`;
  - `wait(project, fingerprint, cancelled)` returns a promise that settles `approved`, `refused` or `cancelled`;
  - `subscribe` for the snapshot.
- **Closest approval:** the approved surface with the fewest differing top-level keys; the newest wins ties.
- **Pending approvals are not persisted.** A restart fails waiting variants anyway, and a direct start asks again when retried.

_Alternative:_ storing approvals in `config.json`. Rejected: a typo there now stops opendevhub, and keeping security state apart from user-editable settings is simpler.

### 3. Where the gate sits

- **Main container:** `bringUp` calls `readConfig(project.path)`, then `check`. On a pending approval it throws `ApprovalRequiredError`, a `ConflictError`, so it becomes a 409 with the approval id.
- **Task container:** `ensureTaskEnv` reads the worktree's config through the node's kit and calls `check` before `exclusiveEnv`.
  - With an `EnvSetup` (a starting variant), it reports step `approval` and awaits `wait(…, setup.cancelled)`.
  - On `approved` it re-reads and re-checks: the config may have changed while waiting, and a new pending approval then waits again.
  - On `refused` it throws `NotApprovedError`; on `cancelled`, the setup's `DiscardedError`.
  - Without an `EnvSetup` (the Worktrees tab) it throws `ApprovalRequiredError`.
  - Inside `bringUpTask`, the config is re-read and checked again (`ensureBase` now comes after that read). This closes the window between the check and the build: a mismatch now throws instead of waiting.
- **Adoption** of running containers at startup is not gated.

Waiting outside `exclusiveEnv` keeps the worktree's other actions (remove, logs) usable while a variant waits.

_Alternative:_ gating in `Containers.up`. Rejected: too low. It can't wait or report a variant's step, and the image build happens before it.

### 4. Waking waiters

`wait` resolves on `approve` or `refuse` of its fingerprint. Cancellation is observed through a `TaskStore.subscribe` listener that re-evaluates `cancelled()` on every task change, so a pick or dismissal ends the wait at once without polling. `approve` also retries direct starts. Each environment whose start failed with that fingerprint is remembered, and approving starts it again, so the banner's Approve is one click.

### 5. New start step

`StartStep` gains `approval`, inside `SETUP_STEPS`, so a restart fails it like the other setup steps. The web's `startStepLabel` shows "Needs approval". The variant card links to the review.

### 6. Access token and cookies, at the HTTP layer

`server/access.ts`:

- `loadToken(stateDir)`: reads or creates `access-token` (32 random bytes, hex, mode 0600). `resetToken` replaces it.
- `dashboardCookie(token)` = HMAC-SHA256(token, `"dashboard"`).
- `envCookie(token, envId)` = HMAC-SHA256(token, `"env:" + envId`). Values are compared in constant time.
- One-time codes: an in-memory map, code → env id with an expiry 60 s ahead, deleted on use.

`server.ts`, before dispatching:

- **Dashboard host:**
  - `?token=` on a page request: when valid, set the `odh` cookie (HttpOnly, SameSite=Strict, Path=/, Max-Age one year, no Domain) and 302 to the same URL without the token.
  - `/api/*` without a valid `odh` cookie: 401 JSON.
  - `/api/access`: 200 or 401, for the page to check.
  - Pages and static files: always served.
- **Terminal upgrade:** requires the `odh` cookie, beside its existing Origin check.
- **Environment host:**
  - `/__odh/enter?code=` exchanges the code for a host-only `odh_env` cookie and 302s to `/`.
  - Any other request, the WebSocket upgrade included, requires `odh_env` for that env id, or gets a 401 (an HTML page for navigations).
- **Opening an environment:** `GET /api/envs/:env/enter`, behind `odh`, mints a code and 302s to `http://<env>.localhost:<port>/__odh/enter?code=…`. The snapshot's `openUrl` points at this route, so links keep working without client code. A top-level navigation from the dashboard is same-site, so the Strict cookie is sent. A link on another site is not, so it gets 401.

The Hono app stays unaware of auth, so `dashboard-api` tests that call `app.request` are unchanged. Server tests and the e2e harness get the cookie from a helper.

_Alternatives considered:_

- **An `Authorization` header:** EventSource, WebSocket and plain links can't send one.
- **A per-launch token:** every restart would log the browser out.
- **The token in the cookie itself:** HMACs let a reset invalidate all cookies, and the raw token never sits in a cookie jar.

### 7. Web

- **Access check:** the app calls `/api/access` before connecting. On 401 it shows an access page with the CLI command (`opendevhub open`) instead of the shell.
- **Snapshot:** `projects[].approvals` lists the pending approvals.
- **Banner:** shown on the project overview and on the worktree row (Review, Approve, Keep stopped).
- **Review dialog:** shows the settings as added, changed or removed against the closest approval. Compose files show as text with a line diff.
- **Approve:** posts `{ fingerprint }`. A 409 "changed" refreshes the review.

### 8. CLI

- `opendevhub` prints `opendevhub running at http://localhost:<port>/?token=…` and opens that URL.
- `opendevhub open` reads the token, checks the port answers, and opens the link.
- `opendevhub token --reset` replaces the token and prints the new link.
- `service.ts` mentions `opendevhub open` instead of a bare URL.

## Risks / Trade-offs

- [Docker Desktop and OrbStack reachability of host loopback is unverified] → The token is cheap and right either way. Check on macOS while implementing and note the result in the docs.
- [Users lose access after the upgrade until they use the link] → The access page names the command; Getting started and the changeset say so.
- [Approval fatigue] → Only host-affecting settings count, approvals apply project-wide and across branches, and an empty surface is free.
- [The merged read needs the network for feature metadata] → Falls back to the plain configuration with features counted as host-affecting. Log the fallback.
- [A config changing between the check and `devcontainer up`] → `bringUpTask` re-checks just before the build and `up`. The remaining window is milliseconds and needs a process that is already running in a container; accepted.
- [`devcontainer build` might run `initializeCommand`] → The gate comes before the build, so it doesn't matter which.
- [A waiting variant waits indefinitely] → It holds no lock, shows its step, and can be discarded or dismissed. A restart fails it.
- [Cookies on `*.localhost`] → Host-only cookies need no Domain handling. Every browser treats `<env>.localhost` as its own host.

## Migration Plan

- The migration adds `config_approvals` empty. Every project with a host-affecting config is asked on its next start; projects without one notice nothing.
- The token is created on first start after the upgrade, and the CLI prints the link. Existing tabs get the access page until opened with it.
- **Rollback:** an older opendevhub refuses the newer database (`NewerDatabaseError`). Rolling back means restoring the database backup or deleting the approvals migration's table by hand; the token file is ignored by older versions.

## Open Questions

- Whether the review should allow approving a surface for one branch only. Deferred; project-wide approvals cover the decided behavior.
