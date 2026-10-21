# ocr-review Specification

## Purpose

Running Open Code Review (OCR) on a pull request: providing the pinned `ocr` binary in an environment, choosing the review engine, running it against a pull request checkout with the configured provider, turning its JSON into review findings, and reporting failures.

## Requirements

### Requirement: Bundled OCR binary

The system SHALL use its own pinned `ocr` version, never one the user installed. On first use per platform, it SHALL download that version's platform package from the npm registry and verify the pinned integrity hash. It SHALL then cache the binary in opendevhub's config folder. Before each OCR run, it SHALL make sure the binary for the environment's architecture (`linux-x64` or `linux-arm64`) is at a versioned path inside that environment, and copy it in when missing. This SHALL work for local environments and environments on remote nodes.

#### Scenario: First OCR review in an environment

- **WHEN** the user starts the first OCR review in a container that has never had it
- **THEN** the review shows "Installing Open Code Review…", the binary is copied into the container, and the review runs

#### Scenario: Cached binary

- **WHEN** a second environment of the same architecture runs an OCR review
- **THEN** the cached binary is copied in without downloading again

#### Scenario: Tampered download

- **WHEN** the downloaded package does not match the pinned integrity hash
- **THEN** nothing is cached or installed, and the review fails with a download error

### Requirement: Choosing the review engine

The pull request page's AI review button SHALL offer **Agent review**, the existing opencode review, and **Open Code Review**. Both engines SHALL use the same checkout picker: an existing checkout of the pull request, or a new worktree at the head commit. Quick, diff-only review SHALL be offered only for the agent engine. While OCR is not configured for the project, choosing Open Code Review SHALL open the settings instead of the review dialog. It SHALL open the global section when no provider is set anywhere, and the project's settings when only the project's override is incomplete.

#### Scenario: Picking OCR

- **WHEN** OCR is configured and the user chooses Open Code Review on pull request #12
- **THEN** the review dialog opens with the OCR engine, names the effective model, and hides Quick review

#### Scenario: OCR not configured

- **WHEN** no OCR provider is configured and the user chooses Open Code Review
- **THEN** the settings modal opens on the Open Code Review section

### Requirement: Running an OCR review

An OCR review SHALL run the bundled binary inside the chosen checkout's environment and directory, as `review --from <base> --to <head commit> --format json --audience agent`. Here `<base>` is the pull request's base branch on the remote matching its base repository, fetched before the run. The title and description of the pull request SHALL be passed as background. The run SHALL use the project's effective provider, the global review limits, and an empty, temporary `HOME`, so no OCR config or Anthropic variables in the environment override them. The API key SHALL be passed on stdin. The system SHALL refuse to run when the checkout's HEAD is not the pull request's head commit. The run SHALL NOT go through opencode, SHALL NOT change the checkout, and SHALL stop at the configured run limit.

#### Scenario: Review of a checked-out PR

- **WHEN** the user starts an OCR review of pull request #12 (base `main`, head `abc123`) in its worktree
- **THEN** OCR reviews `origin/main`…`abc123` in that worktree's container with the project's effective model and the global limits

#### Scenario: Container has its own OCR config

- **WHEN** the container's home has a `~/.opencodereview/config.json` that points at another provider
- **THEN** the review still uses opendevhub's configured provider

#### Scenario: Stale checkout

- **WHEN** the worktree's HEAD is not the pull request's current head commit
- **THEN** the request fails with a message to update the checkout, and OCR is not run

### Requirement: Mapping OCR output to findings

The system SHALL parse the JSON that OCR prints on stdout and turn each comment into a finding:

- `path` becomes `file`.
- `end_line` becomes `line`, and `start_line` becomes `start` when it is lower.
- The side is `new`.
- `content` becomes `body`.
- `severity` maps `critical`→`blocker`, `high`→`major`, `medium`→`minor`, `low`→`nit`, and missing or unknown→`minor`.
- `category` is kept.
- `suggestion_code` becomes `suggestion`.

A comment without a positive line SHALL become a general finding. `project_summary` SHALL become the review summary. The system SHALL apply the agent review's limits on finding count and body length.

#### Scenario: Line comment

- **WHEN** OCR returns a comment on `src/a.ts` lines 40–42 with severity `high`, category `bug`, and suggestion code
- **THEN** the diff shows a `major` finding on new lines 40–42 of `src/a.ts`, with the `bug` category and the suggested code

#### Scenario: Nothing reviewable

- **WHEN** OCR returns `status` `skipped`
- **THEN** the panel says OCR found nothing to review, and a review with zero findings is stored

### Requirement: OCR failures are reported

When OCR exits non-zero, prints no parseable JSON, or reports `status` `failed`, the request SHALL fail and show the CLI's error, trimmed to its last lines and stripped of ANSI codes and the update notice. No review SHALL be stored. Partial file failures in a successful run SHALL be shown as a count of skipped files.

#### Scenario: Provider rejects the key

- **WHEN** the configured key is invalid
- **THEN** the review panel shows OCR's authentication error with a link to the Open Code Review settings, and nothing is stored
