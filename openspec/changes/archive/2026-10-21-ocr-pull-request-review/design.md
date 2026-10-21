## Context

The pull request page (`web/features/forgejo/forgejo-ai-review.tsx`) offers an **AI review**:

- The user picks a checkout of the PR: an existing one, or a new worktree.
- opendevhub starts an opencode session with `aiReviewPrompt`, then asks it for JSON findings (`aiFindingsPrompt`).
- It parses them with `parseAiReview` (`server/integrations/ai-review.ts`).
- A quick mode reviews only the patch.

Findings are `AiFinding`s (file, line, side, start, severity, body). They render in the diff as suggestion cards and are stored in `reviews` (`LinkStore.insertReview`, `mode IN ('session','quick')`).

Open Code Review (`ocr`) is a Go CLI with no JS API. Verified against the v1.12 source and the installed v1.7.16:

- **Packaging:** npm `@alibaba-group/open-code-review` is a launcher. The binary ships in per-platform optional dependencies `@alibaba-group/ocr-<os>-<arch>` (`bin/ocr`, about 53 MB unpacked). Releases are built with `CGO_ENABLED=0`, so the Linux binaries are static and run in any Linux container of the same architecture.
- **Diff range:** `ocr review --from <ref> --to <ref>` reviews the merge-base diff. `--background <text>` adds context. `--timeout <min>` is the per-task timeout.
- **Output:** `--format json --audience agent` prints one JSON document on stdout. Warnings and the update banner go to stderr.
  - Success looks like `{"status":"success","project_summary","summary":{"files_reviewed",…},"comments":[…],"warnings":[…]}`.
  - `"status":"skipped"` means nothing was reviewable.
  - On failure, a `{"status":"failed"}` document goes to stderr and the exit code is non-zero.
- **A comment** has `path`, `content`, `start_line`, `end_line` (new-file lines resolved from `existing_code`), and optionally `severity` (`critical|high|medium|low`), `category` (`bug|security|performance|maintainability|test|style|documentation|other`), `suggestion_code` and `existing_code`.
- **Endpoint resolution** takes the first complete source in this order:
  1. `$HOME/.opencodereview/config.json`
  2. `OCR_LLM_URL` + `OCR_LLM_TOKEN` + `OCR_LLM_MODEL` (+ `OCR_LLM_PROTOCOL`: `anthropic`, `openai`, `openai-responses`)
  3. `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL`
  4. The shell rc file

  `ocr llm test` checks connectivity. `ocr llm providers` lists the built-in presets as name, protocol and base URL.

Git and the checkouts live inside devcontainers, locally or on remote nodes, at container paths. So `ocr` has to run in the checkout's environment through `Containers.exec`. Integration tokens are already stored as a reference in a settings file, with the secret in the OS credential store (`FileIntegrationSettings` + `OsSecretStore`).

## Goals / Non-Goals

**Goals:**

- OCR works with no setup inside environments: opendevhub supplies the binary and the provider settings.
- The provider is configured once in opendevhub's settings modal. A project can override it, and existing host OCR configs can be imported.
- OCR's own review engine reviews PRs. Its findings appear in the diff with severity, category and suggested code, and are stored like agent reviews.

**Non-Goals:**

- Delegation mode, where the agent does the review with OCR's rules. It was rejected because it loses OCR's engine.
- OCR on local or uncommitted changes. That is a follow-up, and `server/ocr/` is built to be reused there.
- Per-run provider overrides and per-project tuning, live progress, cancel, and `--resume`.
- Using a user-installed `ocr`. The bundled, pinned binary is always used.
- Posting OCR findings to Forgejo automatically.

## Decisions

### 1. Bundle by fetching pinned platform binaries at runtime

`server/ocr/binary.ts` pins `OCR_VERSION = "1.12.13"`, and the SRI `integrity` of each platform tarball is recorded in code.

`ensureBinary(platform)` works like this:

1. It downloads `https://registry.npmjs.org/@alibaba-group/ocr-<platform>/-/ocr-<platform>-<version>.tgz`.
2. It checks the tarball against the pinned integrity.
3. It extracts `package/bin/ocr` into `<configDir>/tools/ocr/<version>/<platform>/ocr` (mode 0755), atomically: temp file, then rename.

Concurrent callers share one in-flight download.

_Alternative_: an npm dependency. Rejected: npm installs only the host platform's optional dependency, so a macOS host or an arm64 container would get the wrong binary, and forcing every platform adds about 300 MB to the install. _Alternative_: GitHub release assets. The npm registry is the documented channel and gives integrity hashes.

### 2. Install into the environment on demand

`ensureInEnv(target, env)` installs the binary into an environment:

1. It runs `uname -m` in the environment to pick `linux-x64` or `linux-arm64`.
2. It checks `test -x /tmp/.opendevhub/ocr/<version>/ocr`. The path is versioned, so an upgrade installs alongside the old binary.
3. If the binary is missing, it copies it in with `docker cp` on the machine that runs the container. Locally that is the host runner. On a remote node, the file is first uploaded to the node's tools folder through the node connection, and `Host.writeFile` is extended to accept a `Buffer`.

The container filesystem survives stop and start. A rebuilt container simply reinstalls the binary on the next run.

_Alternative_: bind-mount the tools folder into every container. Rejected: existing containers would need a rebuild, and remote nodes would still need the file.

### 3. Settings: global default plus an optional project override

OCR calls its provider directly. It never uses opencode or a project's models and agents, so the provider is not inherently project-specific. Two layers still serve the real cases: a different account or gateway per project, or a cheaper or stronger model for one codebase.

**Global** (`server/ocr/settings.ts`, `<configDir>/ocr.json`):

- **Provider:** `{ preset, url, protocol, model, keyRef? }`. This is the default every project uses.
- **Tuning**, which always applies globally:

  | Setting | Flag | Default |
  | --- | --- | --- |
  | concurrency | `--concurrency` | 8 |
  | per-file timeout in minutes | `--timeout` | 15 |
  | token budget, 0 for unlimited | `--max-tokens-budget` | 0 |
  | run limit in minutes, the overall exec timeout | — | 30, and always more than the per-file timeout |

**Project override:** stored in the project's `config.json` entry under `ocr`, through `ProjectSettingsStore`, next to the Jira and Forgejo links:

- `{ mode: "global" }`, the default, or `{ mode: "custom", preset, url, protocol, model, keyRef? }`.
- A custom override's key is optional. When it is missing, the global key is used, so changing only the model on the same provider needs no second key.
- Removing a project removes its override secret.

**Resolution:** `resolveOcrProvider(projectId)` returns the effective `{ url, protocol, model, key, source: "global" | "project" }`, or `undefined` when the result is incomplete. OCR is **configured for a project** when the effective URL, protocol, model and key are all set.

**Keys:** they live in `OsSecretStore` under a `keyRef`, and the API only ever returns `hasKey`.

**Presets:** `shared/ocr.ts` holds `OCR_PROVIDER_PRESETS`, a snapshot of `ocr llm providers` for the pinned version (name, protocol and base URL) plus "Custom". Picking a preset fills in the URL and protocol.

**URL validation:** the same as integration URLs, HTTPS or HTTP on loopback only.

The routes are:

| Route | What it does |
| --- | --- |
| `GET`/`PUT /api/ocr/settings` | The global provider and tuning, with `hasKey`. The key is replaced only when a new one is sent, and `clearKey` removes it. |
| `GET`/`PUT /api/projects/:id/ocr` | The project override. `GET` also returns the effective model and its source, for display. |
| `POST /api/ocr/settings/test` | Runs `ocr llm test` on the host with the host-platform binary and the given values. Missing keys fall back to the saved project key, then the global key. Takes an optional `projectId`. |
| `POST /api/ocr/settings/import` | Reads the host's `~/.opencodereview/config.json` and returns **only the active provider** (preset or custom entry, with the key). It fills a form, and saving moves the key into the secret store. |

### 4. Run with isolated HOME, settings via env, key via stdin

The run command is `["sh","-c", SCRIPT, "ocr-review", bin, directory, base, head, background]`. The script:

1. Reads the key from stdin into `OCR_LLM_TOKEN`.
2. Creates a temp `HOME`: `mktemp -d`, removed on exit through `trap`.
3. Exports `OCR_LLM_URL`, `OCR_LLM_MODEL` and `OCR_LLM_PROTOCOL` from positional args.
4. Unsets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL`.
5. `cd`s into the checkout and execs `"$bin" review --from "$base" --to "$head" --format json --audience agent --concurrency "$c" --timeout "$t" [--max-tokens-budget "$b"] --background "$bg"`.

`Containers.exec` gains `input?: string`, passed to the runner's stdin. The runner already supports it.

Why this shape:

- An empty `HOME` means a `~/.opencodereview/config.json` or rc file in the container can't override opendevhub's settings. OCR's session files also stay out of the user's home.
- The key never appears in argv. `devcontainer exec --remote-env` would put it in the host's process list.
- Only the key is a secret. The other values are passed as args.

### 5. Diff range is PR base…head, checked first

Before running, the route makes two checks:

- It checks that `git rev-parse HEAD` in the checkout equals `details.headSha`. Otherwise it fails with "Update the checkout first".
- It fetches the base branch from the remote that matches the PR's base repo (else `origin`), and uses `--from <remote>/<base> --to <headSha>`.

### 6. Synchronous request, stored server-side

`POST /api/forgejo/pulls/:owner/:repo/:number/ocr-review` (`projectId`, `directory`, `commitId`) runs these steps:

1. Resolves the project's effective provider: 412 with "Set up Open Code Review in Settings" when it is incomplete.
2. Ensures the binary is in the environment.
3. Runs the review with the global tuning flags. The exec timeout is the run limit.
4. Parses the output and stores it.

The HTTP request stays open, as the agent findings request does. The review is stored before the response, so a reload mid-run still finds it in the earlier-reviews list.

_Alternative_: a background job with polling. That is more robust, but it is new job state. Revisit if long requests prove brittle.

### 7. One module owns the CLI contract

`server/ocr/review.ts` has `ocrReviewCommand`, `parseOcrOutput(stdout, stderr, exitCode)` and `ocrFinding(comment)`. The mapping:

- The side is `new`, `line` is `end_line`, and `start` is `start_line` when it is lower.
- Severity maps `critical`→`blocker`, `high`→`major`, `medium`→`minor`, `low`→`nit`, and anything else to `minor`.
- `category` is kept, and `suggestion_code` becomes `suggestion`.
- Lines of 0 make a general finding.
- `project_summary` becomes the summary.

The agent parser's limits (`MAX_FINDINGS`, `BODY_CHARS`) become shared exports. Error text is stripped of ANSI codes and the update banner, and trimmed to the last lines.

### 8. Findings, storage and UI

- **Findings and storage:**
  - `AiFinding` gains `category?` and `suggestion?`.
  - A new migration rebuilds `reviews` with `mode IN ('session','quick','ocr')`. It is a new migration, never an edit to migration 1.
  - OCR reviews have no session. Their task is looked up from the variant that owns the checkout's directory.
- **AI review button:** it becomes a shadcn `DropdownMenu` with **Agent review** and **Open Code Review**. When OCR isn't configured, its item reads "Set up Open Code Review…" and opens the settings section.
- **Review dialog** (`ForgejoAiReviewDialog`, `engine` prop): with OCR it explains that OCR reviews file by file with the effective model, named in the dialog with "(project)" when it comes from an override. It hides Quick review, and its submit button reads **Start OCR review**.
- **Run state:** `useAiReview` gains kind `"ocr"`. The stage text is "Open Code Review is reviewing… (mm:ss)". The first run in an environment shows "Installing Open Code Review…" until the copy finishes, and the API reports that phase as `installing`.
- **Results:** `AiSuggestionCard` shows a category chip and the suggested code: a `@pierre/diffs` patch of `existing_code` → `suggestion_code`, or a code block. Accepting a finding into a Forgejo review appends the suggestion as a fenced block. The panel shows files reviewed and skipped, and the earlier-reviews list shows the engine.
- **Global settings modal:** a new section **Open Code Review** (id `open-code-review`, group `integrations`, keywords `ocr review model provider api key timeout concurrency budget`). It has:
  - a **Default provider** block: preset select, URL, protocol, model and key, following the integration token pattern ("Key saved" / Replace / Remove)
  - **Test connection**
  - **Import from ~/.opencodereview**, shown only when the host file exists
  - a **Review limits** block: concurrency, per-file timeout, token budget and run limit
  - the bundled version
- **Project settings:** an **Open Code Review** block next to the project's Jira and Forgejo links. It has a radio for "Use the default (provider · model)" or "Use its own provider". Its own provider shows the same provider form, with "Leave empty to use the default key" on the key field, and **Test connection**.
- **Unconfigured menu item:** "Set up Open Code Review…" opens the global section when nothing is configured anywhere. When only this project's override is incomplete, it opens the project's settings.

## Risks / Trade-offs

- **[First-run download]** About 20 MB compressed per platform, which needs network access. → Cached once per version and platform, with a clear "Installing…" state, and a failure message that names the URL.
- **[Key at rest]** opendevhub now holds an LLM key. → It lives in the OS credential store, never in files, API responses or argv, and is passed only over stdin.
- **[Pinned version ages]** Preset snapshot and JSON shape tie to 1.12.13. → One constant and its integrity hashes to bump. The parser is lenient, with unit tests against captured fixtures.
- **[Long HTTP requests, no cancel]** → The CLI timeout is shorter than the exec timeout, the result is stored server-side, and a job-based runner is the fallback.
- **[Remote nodes]** Copying a 53 MB file over the node connection is slow. → It happens once per node and version, cached in the node's tools folder.
- **[Line mapping]** Comments OCR can't place come back with lines of 0 and become general findings instead of being dropped.

## Migration Plan

- The DB migration runs on start. Rolling back means deleting `ocr` rows, then restoring the CHECK.
- No feature flag: the OCR option prompts for setup until it is configured.
- Settings file and secret are new. Removing them is "Remove key" plus deleting `ocr.json`.

## Open Questions

- None blocking. Settled: tuning is global; import takes only the active provider; the provider is global with an optional per-project override.
