## 1. Setting and persistence

- [ ] 1.1 Append a migration adding `workspace TEXT NOT NULL DEFAULT 'bind' CHECK (workspace IN ('bind','volume'))` to `environments`, with a migration test.
- [ ] 1.2 Add `workspace` to `EnvSettings`/`resolveEnvSettings` from `config.json` only, with unit tests (default, invalid value, ignored in `devcontainer.json`).
- [ ] 1.3 Carry the mode on the environment record, store and shared types.

## 2. Provisioning

- [ ] 2.1 In `Containers.up`, build the override config with a volume `workspaceMount` and `workspaceFolder`, keep `--workspace-folder` on the Hub's repository, and fix the `/workspaces/<basename>` fallback to use the mount target.
- [ ] 2.2 Pass `--skip-post-create` for `volume` environments and run the user commands after seeding; verify against the CLI version we pin.
- [ ] 2.3 Read `origin` from the Hub repository and the current branch; fail with a clear error when there is no `origin`.
- [ ] 2.4 Add a seed step that runs a partial `git clone` in the container as the remote user, skipped when the workspace already holds a repository.
- [ ] 2.5 Reorder `bringUp` for `volume`: `up`, connect (route, relay, credentials), seed, lifecycle commands, opencode.
- [ ] 2.6 Replace a config's `workspaceMount` in `volume` mode and log it; keep the config's value in `config-surface.ts` and keep the override out of it.
- [ ] 2.7 Check `readAndCheck` and the other `hostPath ?? project.path` readers (`environments.ts`) against `volume`, and note the limitation in code.
- [ ] 2.8 Refuse task environments for `volume` projects with an `UnavailableError`.

## 3. Removal and cleanup

- [ ] 3.1 Require `confirmVolumeLoss` on removal of a `volume` environment and project in the API, and reject without it.
- [ ] 3.2 Add the volume to `cleanup-targets.ts` and run `docker volume rm` on confirmed removal. Never on stop or rebuild.
- [ ] 3.3 Report volumes without an environment row in cleanup without deleting them.

## 4. Dashboard

- [ ] 4.1 Hide host-path entries in the open-in menu when there is no `hostPath`; keep terminal, in-browser editor and attach.
- [ ] 4.2 Add the `workspace` control to project settings, the Linux note, and the "recreate to switch" note.
- [ ] 4.3 Add the removal confirmation dialog naming the volume and the work it holds.
- [ ] 4.4 Show the "task environments need bind mode" message where a task would start.

## 5. Tests and docs

- [ ] 5.1 Unit tests for the override config, seed command and the reordered `bringUp`, with fakes for `Containers`.
- [ ] 5.2 E2E: start a `volume` project, check the clone, a `onCreateCommand` that sees the files, a restart without re-cloning, a rebuild that keeps files, and a confirmed removal.
- [ ] 5.3 Document the mode, its trade-offs and the node_modules-volume alternative; run `graphify update .`.
