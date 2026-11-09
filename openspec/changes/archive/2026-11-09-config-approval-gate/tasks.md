## 1. Access token

- [x] 1.1 Add `server/access.ts`: load or create the owner-only `access-token` in the state folder, `resetToken`, HMAC dashboard and environment cookie values with constant-time checks, and one-time environment codes (60 s, single use). Verify with unit tests: same token across loads, file mode 0600, reset invalidates both cookie kinds, a code works once and expires.
- [x] 1.2 In `server.ts`, exchange `?token=` on a dashboard page for the `odh` cookie and redirect without it. Answer 401 on `/api/*` without the cookie, serve `/api/access`, and require the cookie on the terminal upgrade. Verify with server tests: a no-cookie POST from a fake container caller gets 401, a page with the token sets the cookie with the spec's attributes and redirects, and pages and static files are served without the cookie.
- [x] 1.3 Gate the environment proxy: `/api/__odh/enter?code=` sets the host-only `odh_env` cookie, every other request and the upgrade require it, and `GET /api/envs/:env/enter` mints a code and redirects. Point the snapshot's `openUrl` at that route. Verify with server tests: a request with another env's Host header and no cookie never reaches the upstream; a code exchanged once works; a reused code is refused.
- [x] 1.4 CLI: print and open the URL with the token, add `opendevhub open` and `opendevhub token --reset`, and change the service's message. Verify with CLI tests (or a manual run where `node-pty` can't load).
- [x] 1.5 Web: check `/api/access` before connecting and show the access page on 401. Verify with a web test of the 401 path and the MSW mocks.
- [x] 1.6 Update the test helpers and the e2e harness to send the cookie. Verify that `pnpm test` shows no new failures and that the e2e suite passes where Docker is available.

## 2. Host-affecting settings

- [x] 2.1 `readConfig` gains `--include-merged-configuration` and returns the merged configuration and the config file path. If the merged read fails, it falls back to the plain read and says so. Verify with `containers.test.ts` against recorded CLI output for both cases.
- [x] 2.2 Add `hostSurface` and `fingerprint` (in `environments/approvals.ts` or beside it), per design decision 1: compose file contents read through the node's host, and the build context resolved and marked when outside the repository. Verify with unit tests covering each spec scenario: lifecycle-only changes give an equal fingerprint, a feature mount counts, `../..` context counts, an empty surface, the fallback that counts `features`.
- [x] 2.3 Add the `config_approvals` migration and `ConfigApprovals` (check, approve, refuse, wait, subscribe, closest-approval diff). Verify with unit tests: approval across branches, two approved surfaces, the diff for added, changed and removed settings, waiters settling on approve, refuse and cancel.

## 3. Gate

- [x] 3.1 Main container: read the config and check it in `bringUp` before `up`, and throw `ApprovalRequiredError` (409) with the pending id. Approving retries the start. Verify with environment tests: an `initializeCommand` added after approval blocks `up`, and approve starts it.
- [x] 3.2 Task container: check in `ensureTaskEnv` before `exclusiveEnv`, and move `ensureBase` after the config read in `bringUpTask`, which re-checks. Without a setup, throw `ApprovalRequiredError`. Cover remote nodes through their kit. Verify with tests: no image build or `up` while pending; the Worktrees-tab start fails with the approval; a remote-node env is gated the same way.
- [x] 3.3 Waiting: add the `approval` start step (shared type, `SETUP_STEPS`, web label), pass `cancelled` through `EnvSetup`, and re-check after approval. Verify with task tests: a variant waits at `approval` and resumes on approve; Keep stopped fails it with the not-approved error; a pick ends the wait without a build; `failInterrupted` fails a waiting variant.
- [x] 3.4 Leave adoption ungated. Verify with a test: rescanning with a running container whose config needs approval adopts it without asking.

## 4. API and UI

- [x] 4.1 Snapshot `projects[].approvals`, plus `POST /api/projects/:id/config-approvals` with `{ fingerprint }` (409 when it is no longer pending) and `DELETE …/:fingerprint` for Keep stopped. Verify with `dashboard-api` tests.
- [x] 4.2 Web: the approval banner on the project overview and worktree row, the review dialog with the diff (compose files as a text diff), and the Needs approval step on variant cards linking to it. Verify with web tests and Storybook stories for the banner and dialog with mock approvals.

## 5. Docs and release

- [x] 5.1 Docs: a page on dashboard access and config approvals (what counts as host-affecting, approving, the link and `opendevhub open`), and a Getting started note about the link. Verify the docs build.
- [x] 5.2 Add a changeset flagging the one-time link after upgrading. Verify `pnpm changeset status`.
- [x] 5.3 Check on macOS with Docker Desktop or OrbStack whether a container can reach the dashboard through `host.docker.internal`, and record the result in the docs page. Verify by a manual note in the PR.

## Workflow follow-up

- Archive the change with `/opsx:archive` after it is merged.
