## 1. Bundled binary

- [x] 1.1 Add `server/ocr/binary.ts` with `OCR_VERSION = "1.12.13"` and the pinned integrity of the `@alibaba-group/ocr-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}` tarballs, taken from `npm view … dist.integrity`
- [x] 1.2 Implement `ensureBinary(platform)`: download from the npm registry, verify integrity, extract `package/bin/ocr` to `<configDir>/tools/ocr/<version>/<platform>/ocr` (temp file, then rename, 0755), with one in-flight download per platform
- [x] 1.3 Add `input` (stdin) to `Containers.exec` options, passed to the runner
- [x] 1.4 Implement `ensureInEnv(env)`: `uname -m` → platform, then `test -x /tmp/.opendevhub/ocr/<version>/ocr`, else `docker cp` on the machine running the container (host runner, or the node after uploading the binary to its tools folder; extend `Host.writeFile` to take a `Buffer`)
- [x] 1.5 Tests: an integrity mismatch caches nothing; concurrent `ensureBinary` calls download once; `ensureInEnv` skips the copy when the binary is present and picks arm64 for `aarch64`

## 2. OCR settings (server)

- [x] 2.1 Add `shared/ocr.ts`:
  - the types for global settings (provider plus limits), the project override (`mode: global|custom`), and the effective provider (`model`, `source`, `configured`)
  - `OCR_PROVIDER_PRESETS`, copied from `ocr llm providers` for the pinned version, plus Custom
  - the default limits
- [x] 2.2 Add `server/ocr/settings.ts` with global settings in `<configDir>/ocr.json`:
  - provider with `keyRef` into `OsSecretStore`
  - limits: concurrency 8, per-file timeout 15, budget 0, run limit 30, validated so the run limit is longer than the per-file timeout
  - keep, replace or clear the key
  - URL validation shared with `integrationUrl`
- [x] 2.3 Store the project override in the project's `config.json` entry via `ProjectSettingsStore` (key in `OsSecretStore`, optional), delete its secret when the project is removed, and add `resolveOcrProvider(projectId)` (override, then default, with the key falling back to the default key)
- [x] 2.4 Add the routes:
  - `GET`/`PUT /api/ocr/settings`
  - `GET`/`PUT /api/projects/:id/ocr`, where `GET` returns the effective model and source
  - `POST /api/ocr/settings/test`, which takes an optional `projectId` for key fallback, runs `ocr llm test` on the host with an isolated HOME, and passes the key on stdin
  - `POST /api/ocr/settings/import`, which returns only the active provider from the host's `~/.opencodereview/config.json`

  Add validation schemas for all of them.

- [x] 2.5 Tests:
  - keys are never in responses
  - saving without a key keeps it, and clearing deletes the secret
  - bad URLs and limits are rejected
  - resolution covers default only, a model-only override using the default key, a full override, and an override with no default
  - removing a project deletes its secret
  - import of a preset and of a custom provider takes the active one only
  - test errors are trimmed

## 3. Review run (server)

- [x] 3.1 Capture fixtures from real `ocr review --format json --audience agent` runs with 1.12.13 (comments, no comments, `skipped`, `failed` on stderr) into `test/fixtures/ocr/`
  - Written from the v1.12.13 output structs (`output.go`, `model/review.go`), not captured: running the downloaded binary was not permitted here. Replace with captured output during 6.2.
- [x] 3.2 Export the shared finding limits from `server/integrations/ai-review.ts`
- [x] 3.3 Add `server/ocr/review.ts`: `ocrReviewCommand` (script with temp HOME + trap, the key read from stdin into `OCR_LLM_TOKEN`, URL, model and protocol as args, Anthropic variables unset, the global limits as `--concurrency`/`--timeout`/`--max-tokens-budget`), `parseOcrOutput`, and `ocrFinding` (design decision 7)
- [x] 3.4 Unit tests for the mapping and parsing against every fixture, malformed JSON, and an unknown severity; assert the key is not in argv
- [x] 3.5 `POST /api/forgejo/pulls/:owner/:repo/:number/ocr-review`: resolve the project's effective provider (412 when incomplete), the HEAD check, base fetch from the matching remote, `ensureInEnv`, the run (exec timeout is the run limit), then store or fail with 502 and the trimmed error
- [x] 3.6 Route tests with fake `containers.exec`: not configured; project override used over default; limits passed as flags; stale HEAD refused before running; key passed on stdin; success stored; failure not stored

## 4. Shared types and storage

- [x] 4.1 Add `category?` and `suggestion?` to `AiFinding` and `"ocr"` to the stored review mode
- [x] 4.2 Add a migration that rebuilds `reviews` with `mode IN ('session','quick','ocr')`, copying rows and recreating `reviews_pull`
- [x] 4.3 Widen `NewReview`/`RawReview`; look up an OCR review's task from the variant owning the directory
- [x] 4.4 Tests: the migration keeps existing reviews; an `ocr` review with no session stores its findings with category and suggestion, and writes `review.run` with `mode: "ocr"`

## 5. Web

- [x] 5.1 Add an **Open Code Review** settings section (group integrations, with keywords):
  - a Default provider block: preset select that fills URL and protocol, URL, protocol, model, and key with the Saved/Replace/Remove pattern
  - Test connection, and Import from ~/.opencodereview (active provider only)
  - a Review limits block: concurrency, per-file timeout, token budget, run limit
  - the bundled version
- [x] 5.2 Add an **Open Code Review** block to project settings next to the Jira/Forgejo links: "Use the default (provider · model)" or "Use its own provider", with the provider form, the key hint "Leave empty to use the default key", and Test connection
- [x] 5.3 Turn the PR header's AI review button into a `DropdownMenu` (Agent review / Open Code Review); while OCR is unconfigured for the project, the OCR item opens the global section, or the project's settings when only its override is incomplete
- [x] 5.4 Give `ForgejoAiReviewDialog` an `engine` prop: OCR copy naming the effective model (with "(project)" for an override), no Quick review, and a **Start OCR review** button
- [x] 5.5 Add run kind `"ocr"` to `useAiReview`: stages "Installing Open Code Review…" then "reviewing… (mm:ss)"; errors link to settings when they are provider errors; retry and rerun
- [x] 5.6 `AiSuggestionCard`: category chip and suggested code (a `@pierre/diffs` patch of existing → suggestion, or a code block); accepting a finding into a Forgejo review appends the suggestion as a fenced block
- [x] 5.7 Show the engine on earlier-review entries; show "N files reviewed, M skipped" for OCR runs
- [x] 5.8 MSW handlers and fixtures for the settings and review routes; stories for the settings section (empty, configured, test failed), the project block (default, own provider), the dialog, and an OCR finding card

## 6. Verification

- [x] 6.1 `pnpm exec ultracite fix`, typecheck and the test suite pass
- [ ] 6.2 Manual: configure the provider by importing the host config, test the connection, then review a real open PR from a new worktree in a container without `ocr`; findings land on the right lines, are stored, and survive a reload
- [ ] 6.3 Manual: give one project its own model and check that its reviews use it while another project uses the default; put a conflicting `~/.opencodereview/config.json` in the container and confirm opendevhub's provider is used; confirm the key is not visible in `ps` on the host during a run
- [x] 6.4 `graphify update .`
