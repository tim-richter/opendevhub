## Why

The AI review of a pull request runs as an opencode agent prompt, and we pull findings out of its free-text reply. Open Code Review (`ocr`), Alibaba's code review CLI, reviews a diff file by file with its own engine: a pass per file, line numbers resolved from the code it quotes, and categories and suggested code. It prints structured JSON. Offering it as a second engine lets the user compare its precision with the agent review's recall, and its findings need no parsing heuristics.

Using OCR should take no setup inside each devcontainer. So opendevhub ships the CLI itself, and the model provider is configured once in opendevhub's settings. This change covers pull requests only. Reviewing local changes with OCR is a separate, later change.

## What Changes

- **Bundled CLI**: opendevhub pins an `ocr` version. It downloads the static Linux binary for each environment's architecture from the npm registry, verifies it, caches it, and copies it into the environment on first use. Users never install `ocr`.
- **Open Code Review settings**: a new section in the settings modal.
  - It holds the **default provider**: a preset (OCR's built-in providers, or a custom one), base URL, protocol, model, and API key.
  - It holds the **review limits**: concurrency, per-file timeout, token budget, and run limit.
  - The key goes in the OS credential store, as integration tokens do.
  - The section can test the connection and import the active provider from the host's `~/.opencodereview/config.json`.
- **Project override**: a project can keep the default or use its own provider, URL, protocol, model, and an optional key that falls back to the default key. It is set in the project's settings next to its Jira and Forgejo links. OCR doesn't use opencode's models, so this is for a different account, gateway or model per codebase.
- **Engine choice**: the pull request's **AI review** button offers **Agent review** (today's flow) and **Open Code Review**. Until OCR is configured, the OCR item links to its settings.
- **OCR's own review mode**: an OCR review runs `ocr review --from <base> --to <head> --format json --audience agent` inside a checkout of the PR, chosen with the existing checkout picker. It runs with the project's effective provider, the global limits, and an isolated `HOME`, so a config already in the container never overrides them. It doesn't use opencode, and delegation mode is out of scope.
- **Findings**: OCR comments map onto `AiFinding`s with a new-side line range, severity (`critical/high/medium/low` → `blocker/major/minor/nit`), and two new optional fields, `category` and `suggestion`. They appear in the diff like agent findings.
- **Storage**: stored reviews gain a third mode, `ocr`. The earlier-reviews list shows the engine.

## Capabilities

### New Capabilities

- `ocr-settings`: the default OCR provider and review limits in opendevhub, a per-project provider override, keeping keys secret, testing the connection, and importing the active provider from an existing OCR config.
- `ocr-review`: providing the pinned `ocr` binary in an environment, running it against a pull request checkout with the configured provider, and turning its JSON into review findings.

### Modified Capabilities

- `ai-review-records`: a stored review's mode can be `ocr`. An OCR review has no session, and its task is the one that owns the checkout, if any. Findings may carry a category and a suggestion. The list shows the engine.

## Impact

- **Server**:
  - New `server/ocr/`:
    - `binary.ts`: download, verify, cache, and install into an environment.
    - `settings.ts`: global settings, project override and resolution, plus `SecretStore`.
    - `review.ts`: command, env, and JSON mapping.
  - New routes for global OCR settings, the project override, connection test, import, and running a review.
  - `Containers.exec` gains an `input` (stdin) passthrough so the key never appears in argv.
- **DB**: a migration that widens `reviews.mode` to include `'ocr'` (a table rebuild).
- **Shared types**: `AiFinding.category?`, `AiFinding.suggestion?`, review mode `ocr`, the OCR settings types, and a snapshot of OCR's built-in provider presets.
- **Web**:
  - A new "Open Code Review" settings section, and an OCR block in project settings.
  - The AI review button becomes a menu.
  - The dialog gets an engine prop.
  - The suggestion card shows category and suggested code.
  - The earlier-reviews list shows the engine.
  - MSW handlers and stories cover the new parts.
- **Dependencies**: no npm dependency. opendevhub fetches `@alibaba-group/ocr-linux-{x64,arm64}` (and the host platform's binary, for the connection test) at a pinned version (1.12.13) from the npm registry at runtime. It needs network access on first use per architecture.
