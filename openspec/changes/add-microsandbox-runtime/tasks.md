## 0. Resolve open questions

- [ ] 0.1 Install `msb` locally and answer the design's open questions (sandbox labels, a preflight probe that starts no VM, adding ports to a running sandbox, `exec` user and working directory). Record the answers in design.md and pin the minimum `msb` version

## 1. Runtime seam

- [ ] 1.1 Define `EnvironmentRuntime` (up, exec, ptyCommand, inspect with `reach(port)`, listManaged, logs, stop, remove, copyIn, readConfig, hostSurface) in `environments/runtime.ts`
- [ ] 1.2 Implement `DevcontainerRuntime` over the existing `Containers`, with `reach(port)` returning the container IP or the gateway route
- [ ] 1.3 Route `Environments`, relay runtime, terminals, checks, credentials and editors through the runtime instead of `Containers`; existing tests pass unchanged
- [ ] 1.4 Remove the remaining direct `devcontainer`/`docker` calls on environments outside the runtime (grep check)

## 2. Runtime selection and persistence

- [ ] 2.1 Append a migration adding `runtime` to `environments` (default `devcontainer`, CHECK constraint); test that existing rows upgrade to `devcontainer`
- [ ] 2.2 Resolve `runtime` from `customizations.opendevhub` with `config.json` precedence in `resolveEnvSettings`; unknown values fail the start
- [ ] 2.3 Record the runtime on environment creation; refuse to reuse an environment whose runtime differs, and make rebuild remove it via its original runtime
- [ ] 2.4 Add `runtime` to the project settings view and the `config.json` schema

## 3. Node support

- [ ] 3.1 Split `nodePreflight` into per-runtime checks; add the `msb` check (PATH, version, microVM support) with KVM/HVF-specific messages
- [ ] 3.2 Store and expose each node's supported runtimes; show them, and why one is missing, on the nodes page
- [ ] 3.3 Refuse to place an environment on a node lacking its project's runtime; fail the variant before creation

## 4. Microsandbox runtime: config translation

- [ ] 4.1 Translate a resolved devcontainer config into a sparse msb config (image, workdir, bind mounts, env, user, cpus/memory, published relay and opencode ports); unit tests per key
- [ ] 4.2 Refuse unsupported keys (Compose, `runArgs`, `privileged`, `capAdd`, `securityOpt`, `appPort`, `initializeCommand`, non-bind mounts) with one error naming all of them
- [ ] 4.3 Merge `devcontainer.metadata` from built images (feature env, user, lifecycle commands); fixture tests against images built by the real CLI
- [ ] 4.4 Build all `msb` argv and config files in one module; write config to `~/.opendevhub/sandboxes/<envId>.yaml` on the node, secrets only in the process environment

## 5. Microsandbox runtime: lifecycle

- [ ] 5.1 `up`: create or start the sandbox `odh-<envId>` from the image or snapshot, bind-mounting the checkout with the remote user's uid/gid
- [ ] 5.2 Run lifecycle commands in devcontainer order with a guest marker file for the once-only ones
- [ ] 5.3 `exec`, `ptyCommand` (`--tty`, resize), `logs`, `stop`, `remove`, `copyIn`, `inspect` and `listManaged` (by name prefix, plus labels if supported)
- [ ] 5.4 `reach(port)`: allocate host ports for relay and opencode on the node, return the loopback address, and use the gateway tunnel on remote nodes; disable direct-IP fallback in the port forwarder for sandboxes
- [ ] 5.5 Reattach to running sandboxes after a restart through the recorded runtime

## 6. Images and snapshots

- [ ] 6.1 For `build`/feature configs, `devcontainer build` and then `docker save | msb load --tag odh/<project>:<imageKey>`; skip when that tag is loaded; clear error when Docker is missing
- [ ] 6.2 Create the per-project base snapshot after `onCreate`/`updateContent` with no checkout mounted; restore task environments from it with the worktree mounted
- [ ] 6.3 Clean up loaded images and snapshots whose image key is no longer used, in `cleanup-targets.ts`

## 7. Secrets, egress and approval

- [ ] 7.1 Deliver agent API keys as msb secrets allowed for their provider hosts instead of env vars; test that the guest sees only a placeholder
- [ ] 7.2 Support `customizations.opendevhub.microsandbox.secrets` (read from host env, fail when missing) and `…network.allow` with opendevhub's required hosts added
- [ ] 7.3 Implement the microsandbox `hostSurface` (extra bind mounts, forwardPorts, allowlist or unrestricted, secrets with hosts, build context/options) and add `runtime` to every surface; approval tests for a new mount and a runtime switch

## 8. Dashboard

- [ ] 8.1 Hide attached-container editor entries for microsandbox environments; keep host-folder, in-browser editor and terminals
- [ ] 8.2 Show an environment's runtime on its environment and task pages

## 9. Verification

- [ ] 9.1 E2e on a KVM-capable runner: create a microsandbox project from an image config, run a task variant from the snapshot, open a terminal, forward a port, check file ownership in the checkout
- [ ] 9.2 E2e that a devcontainer project behaves exactly as before
- [ ] 9.3 Document the microsandbox runtime in the README: requirements, supported and refused keys, secrets and allowlist, limitations
- [ ] 9.4 Run `pnpm exec ultracite fix`, the test suite and `graphify update .`
