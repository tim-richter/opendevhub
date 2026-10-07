# OpenDevHub local development and developer experience backlog

Reviewed: 2026-10-06

Implementation: `40130054abd8304e9b362742da88a9a8a26c4588` (`opendevhub` package version `0.1.0`)

Status: proposed backlog; no product changes made as part of this review.

## Goal and scope

Make OpenDevHub a dependable daily workspace for a developer running agent tasks on their own computer: easy to set up, easy to diagnose, predictable with existing repositories, and comfortable for the human who reviews and finishes the work. Add Jira, GitHub, and Forgejo integrations without making a hosted service or an external account necessary for local use.

This review inspected the CLI, server, dashboard, tests, CI, README, documentation, and existing design/backlog documents in the checkout. Findings marked **confirmed** follow directly from source or documented limitations. **Proposed** items anticipate needs; their absence is a product opportunity, not a demonstrated bug. Existing design documents express intentions and are not evidence that a feature shipped.

Validation: eight focused test files covering checks, configuration, discovery, tasks, forge helpers, preflight, and shared/web task/check logic passed: **131 tests**. The full unit/integration attempt was interrupted after runtime failures; a separate relay run confirmed `listen EPERM` on loopback in this execution sandbox. The `pnpm test` entry point also encountered an environment setup error creating pnpm's home data directory, so the focused tests used the installed Vitest binary. No complete test-suite pass, live browser evaluation, real Docker/devcontainer run, real provider login, or live Jira/forge interaction is claimed. Runtime-dependent recommendations need validation on actual developer machines.

## What already works

These are foundations to extend, not missing features:

- Linux/macOS CLI with remembered roots/port, shallow project discovery, and generated devcontainer onboarding for common stacks.
- Docker/devcontainer orchestration, container adoption on restart, direct and gateway routing, relay recovery, forwarded ports, and editor launching.
- New tasks, up to four model variants, worktrees, optional isolated task containers, and remote SSH nodes in preview.
- Live sessions, inline permissions/questions, Web Push notifications, usage history, CPU/memory stats, and selective cleanup.
- Review of working changes or branch changes, syntax highlighting, split/unified diffs, review comments sent to agents, commit, update from base, and merge into base.
- Configurable host/container checks, explicit approval of host commands, commit-associated results, and asking an agent to fix failures.
- Token-free publish through host/container Git: GitHub/GitLab/Bitbucket compare links and Forgejo/Gitea AGit publishing, with no force push.
- Git identity setup, known-host copying, and SSH-agent forwarding.

Relevant baseline: [README](../README.md), [existing backlog](superpowers/backlog.md), and [existing specifications](superpowers/specs/).

## Priorities and index

All items begin in **Proposed** status. P0 means a correctness issue to resolve before relying on the affected behavior. P1 means a daily local-use or requested-integration improvement. P2 means valuable after the foundations. P3 is an optional extension. Effort is relative: S = narrow change, M = several components, L = substantial subsystem or platform work; these are not delivery estimates.

| ID | Improvement | Priority | Effort | Depends on |
| --- | --- | --- | --- | --- |
| DX-01 | Bind checks to exact checkout contents | P0 | M | — |
| DX-02 | Preview-bound Git mutations and selective commits | P1 | M | DX-01 |
| DX-03 | Guided first run and repeatable doctor | P1 | M | — |
| DX-04 | Provider credentials and private Git setup | P1 | L | DX-03 |
| DX-05 | Editable roots and explicit project registration | P1 | M | — |
| DX-06 | Versioned configuration, state recovery, single instance | P1 | M | — |
| DX-07 | Durable tasks, session history, and outcomes | P1 | L | DX-06 |
| DX-08 | Retry, cancel, and resume task setup | P1 | M | DX-07 |
| DX-09 | Diagnostics, durable logs, and runtime recovery | P1 | M | DX-03, DX-06 |
| DX-10 | Deterministic environment rebuilds | P1 | L | DX-06 |
| DX-11 | Docker Compose service ports and task isolation | P1 | L | DX-10 |
| DX-12 | Runtime limits, queueing, and opt-in idle stop | P1 | M | DX-07, DX-08 |
| DX-13 | Host Git and review when containers are stopped | P1 | M | DX-02, DX-05 |
| DX-14 | Persistent terminal and development commands | P2 | M | DX-09 |
| DX-15 | Task drafts, templates, and explicit context | P1 | M | DX-07 |
| DX-16 | Local/offline notifications and notification policy | P2 | M | DX-07 |
| INT-01 | Local connector foundation and account settings | P1 | L | DX-04, DX-06 |
| INT-02 | GitHub/Forgejo issues to tasks | P1 | M | INT-01, DX-07, DX-15 |
| INT-03 | Jira issues to tasks | P1 | L | INT-01, DX-07, DX-15 |
| INT-04 | Full PR lifecycle, reviews, and CI visibility | P1 | L | INT-01, INT-02 |
| DX-17 | Budget warnings and usage confidence | P2 | M | DX-07, DX-12 |
| DX-18 | Practical project trust and permission policies | P2 | M | DX-04, DX-06 |
| DX-19 | Keyboard, accessibility, and large-workspace performance | P2 | M | DX-07 |
| DX-20 | Real local-platform and browser regression coverage | P1 | L | Incremental alongside other items |
| EXT-01 | Optional remote access and remote-node parity | P3 | L | DX-09, DX-18, DX-20 |
| EXT-02 | Bounded scheduled/reactive task automation | P3 | L | DX-08, DX-12, INT-04, DX-17 |

## Local correctness and setup

### DX-01 — Bind checks to exact checkout contents

**Confirmed.** `Checks.view()` considers a run current when HEAD and the boolean dirty flag match. Editing an already dirty checkout keeps both values unchanged. A check that passed before the edit can therefore still appear current. Results also live only in an in-memory map. See [checks.ts](../apps/opendevhub/src/server/checks.ts), especially `view`, `prepare`, and `state`, and [web check state](../apps/opendevhub/src/web/checks.ts).

**Scope:** identify the actual inputs to a run: HEAD, index/worktree content including untracked files, check definitions, and execution environment identity. Capture state before and after execution; distinguish passed, failed, stale, interrupted, and unknown. Persist completed runs with bounded output. Keep publish warnings by default; offer an explicit project setting for required checks enforced by the server.

**Acceptance criteria:**

- Passing checks on dirty checkout A, then changing any relevant tracked or untracked content to B without committing, marks those results stale.
- Changes during execution prevent a result from being presented as validation of the final checkout. A Git read failure produces unknown state, never an assumption that the checkout is clean.
- Changing a command or rebuilding its execution environment invalidates affected results; unchanged inputs retain valid results after a dashboard restart.
- Required-check policy blocks publish through the API as well as the UI and explains precisely which input/result is missing or stale.

### DX-02 — Preview-bound Git mutations and selective commits

**Confirmed limitation; proposed improvement.** `GitOps.commit()` stages everything with `git add -A`. The orchestrator serializes its own Git operations, but editors and agents can still change files between review and commit. Existing merge/rebase abort handling and clean-check safeguards are useful foundations. See [git.ts](../apps/opendevhub/src/server/git.ts), [orchestrator Git actions](../apps/opendevhub/src/server/orchestrator.ts), and [review UI](../apps/opendevhub/src/web/pages/ProjectReview.tsx).

**Scope:** add file selection first, optional hunk selection later, and show what the commit will include. Carry the reviewed HEAD/content identity into mutation requests and reject stale previews. Show fetch freshness and distinguish updating from a local base from updating from the remote base. Apply preview identity checks to destructive worktree/variant cleanup too.

**Acceptance criteria:**

- A developer can commit selected files without including unrelated edits; existing staging is preserved or any replacement is explicitly shown.
- Changes made after the preview cause a refresh-required response before commit/removal proceeds.
- Concurrent agent activity is visible; review actions offer to interrupt the agent or wait before taking a consistent snapshot.
- Update from base shows the exact ref/commit and whether it was fetched; conflicts retain the existing safe abort behavior and useful file-level diagnostics.

### DX-03 — Guided first run and repeatable doctor

**Confirmed.** Starting without roots exits with instructions. Local preflight checks only Docker reachability and the devcontainer CLI and runs at startup. The dashboard displays errors, but there is no doctor command or complete onboarding workflow. See [cli.ts](../apps/opendevhub/src/server/cli.ts), [preflight.ts](../apps/opendevhub/src/server/preflight.ts), and [shell notices](../apps/opendevhub/src/web/layout/Shell.tsx).

**Scope:** allow a first-run setup screen without configured roots; add `opendevhub doctor` and `doctor --json`, plus rerun from the UI. Report host checks separately from per-project checks: Node/Git versions, Docker context/socket, devcontainer CLI, opencode version/API compatibility, routing, worktree compatibility, editor support, and credential readiness. Add a tiny documented example project.

**Acceptance criteria:**

- A fresh install reaches setup, selects a repository, checks prerequisites, previews generated files, and starts a first task without editing global JSON by hand.
- Each failure has a specific next action; credentials are reported as configured/missing without displaying their values.
- Fixing Docker or PATH after startup can be detected with Rerun checks, without restarting OpenDevHub.
- Doctor output can be attached to an issue after a redaction preview. Benchmark first task startup and document a target after measuring Linux/macOS cold and warm runs.

### DX-04 — Provider credentials and private Git setup

**Confirmed.** Provider credentials are left to devcontainer environment/mount configuration. SSH identity/agent support exists; HTTPS credentials, signing, and SSH aliases inside containers are documented limitations. See [credentials.ts](../apps/opendevhub/src/server/credentials.ts), [opencode client](../apps/opendevhub/src/server/opencode/client.ts), and [Git/SSH documentation](../apps/docs/content/docs/git-and-ssh.mdx).

**Scope:** expose provider connection and model readiness, reusing supported opencode credential/OAuth APIs after capability verification. Support per-project secret references backed by the OS credential store or an explicit existing environment source; define availability for main and isolated containers. Add HTTPS helper integration, SSH alias resolution, and optional signing passthrough. Never copy the entire host credential directory into a task container.

**Acceptance criteria:**

- A connected provider is usable in both the main and a new isolated environment; expired/missing credentials produce a focused reconnect action.
- Credentials do not enter repository files, normal configuration exports, prompts, logs, generated configs, or command-line arguments. Replace the documented opencode password argument exposure.
- Private SSH-alias and HTTPS repositories can fetch and push with documented supported host/container paths; signing support is explicit and tested.
- Existing user Git/SSH/provider configuration is preserved, and disconnect/revoke explains which running environments require restart or refresh.

### DX-05 — Editable roots and explicit project registration

**Confirmed.** Discovery is depth two, recognizes two fixed devcontainer paths, skips hidden/symlink directories, and stops descending after claiming a project. CLI roots are merged; there is no root-management UI or explicit project registry. Add project only offers discovered Git repositories. See [discovery.ts](../apps/opendevhub/src/server/discovery.ts), [config.ts](../apps/opendevhub/src/server/config.ts), and [onboarding.ts](../apps/opendevhub/src/server/onboarding.ts).

**Scope:** roots CRUD, configurable depth/exclusions, direct Add path, monorepo/nested projects, and selection among multiple `.devcontainer/<name>/devcontainer.json` definitions. Canonicalize paths and deduplicate symlinked locations. Distinguish hiding/removing registration from deleting files or containers.

**Acceptance criteria:**

- A deeply nested repository or a repository outside scanned roots can be registered directly and persists after restart.
- A monorepo can expose two explicit project/config entries; overlapping roots and symlinks do not create duplicates.
- Users can remove a root, see projects/environments affected, and choose what stays registered without deleting work.
- Unknown/unreadable roots and unsupported devcontainer definitions produce visible diagnostics, not silent disappearance.

### DX-06 — Versioned configuration, state recovery, and single-instance ownership

**Confirmed partial support.** JSON writes are atomic, state is written with mode `0600`, and malformed JSON is backed up. There is no config/state schema version or migration framework; parser output is treated as typed input and semantically invalid JSON is only partly validated. Settings use paths and project IDs derive from paths. There is no explicit shared-state process lock. See [config.ts](../apps/opendevhub/src/server/config.ts), [ids.ts](../apps/opendevhub/src/server/ids.ts), [state.ts](../apps/opendevhub/src/server/state.ts), and [cli.ts](../apps/opendevhub/src/server/cli.ts).

**Scope:** typed schema validation, actionable errors, versioned migrations/backups, and ownership of a config/state directory by one server. Introduce stable registered project identity and a Move/relink workflow. Export/import portable settings separately from secrets and machine runtime identifiers.

**Acceptance criteria:**

- Valid JSON with wrong top-level types or an invalid saved port produces a recoverable diagnostic instead of an obscure startup failure.
- Two instances sharing a state directory cannot race even on different ports; intentional separate profiles can run independently.
- Migration failure preserves the previous files; recovery can rediscover labeled containers and reconnect projects.
- Moving a repository preserves its task associations/settings through an explicit relink. Export omits credentials, container IDs, and inappropriate host-specific paths.

## Daily task and environment workflows

### DX-07 — Durable task/session history and meaningful outcomes

**Confirmed.** Task metadata survives in opencode sessions, but dashboard discovery is constrained by the newest-session listing. The monitor compensates for some missing active/pending sessions with bounded lookups; the task page explicitly says older sessions can be missing. Starting jobs are in memory. Raw sessions expose outcomes, while the primary dashboard status vocabulary is running/idle/needs-input. See [monitor.ts](../apps/opendevhub/src/server/monitor.ts), [tasks.ts](../apps/opendevhub/src/server/tasks.ts), [state.ts](../apps/opendevhub/src/server/state.ts), and [task page](../apps/opendevhub/src/web/pages/ProjectTask.tsx).

**Scope:** a lightweight local task index containing original prompt/context references, variants, setup progress, environment/session IDs, outcomes, checks, and external links. Reconcile it with opencode rather than duplicating its complete conversation store. Separate agent activity from task result and from user-confirmed completion. Include searchable history/archive and export.

**Acceptance criteria:**

- Creating over 50 sessions does not make a known task inaccessible; stopped/deleted environments leave a usable task record.
- A restart during setup produces a reconciled completed/failed/interrupted record, with paths to retained work.
- Idle is not presented as evidence of successful completion; interrupted/failed outcomes and still-needed review/checks are visible.
- Search finds title, branch, source issue key, and prompt; archive is reversible and deletion has explicit retention semantics.

### DX-08 — Retry, cancel, and resume task setup

**Confirmed.** Background task setup exposes progress and failures; failed starting entries can be dismissed. There is no retry/cancel setup workflow or retained request needed to resume a failed variant. The New task dialog requires the main project to be running. See [task orchestration](../apps/opendevhub/src/server/orchestrator.ts), [NewTaskDialog](../apps/opendevhub/src/web/components/NewTaskDialog.tsx), and [ProjectTask](../apps/opendevhub/src/web/pages/ProjectTask.tsx).

**Scope:** one Start task flow that can start a stopped project, idempotent submission, retry failed variants from their last safe step, setup cancellation, and interrupt/resume agent actions without deleting sessions. Keep existing work by default; make discard separate.

**Acceptance criteria:**

- A stopped project can be selected and started as part of task submission with progress in one place.
- Retrying after an image, auth, or prompt-send failure reuses valid worktrees/sessions and does not create duplicate branches or resend a prompt whose delivery is already confirmed.
- A double click or retry after a lost HTTP response returns the same task via an idempotency key.
- Cancellation terminates the owned operation/process group where supported, releases queue locks, records what remains, and offers resume or explicit cleanup.

### DX-09 — Diagnostics, durable logs, and runtime recovery

**Confirmed partial support.** Container adoption, refresh, SSE reconnects, health monitoring, and relay recovery exist. Logs are a bounded in-memory buffer; health failure handling often drops exception details, and command execution accumulates stdout/stderr in memory. See [monitor.ts](../apps/opendevhub/src/server/monitor.ts), [log-buffer.ts](../apps/opendevhub/src/server/log-buffer.ts), [exec.ts](../apps/opendevhub/src/server/exec.ts), and [orchestrator.ts](../apps/opendevhub/src/server/orchestrator.ts).

**Scope:** structured failure categories, operation IDs, bounded rotating logs, last-known-good timestamps, exportable diagnostic bundles, and a runtime health view covering Docker, opencode, gateway, relay, ports, and credentials. Recheck readiness after Docker restart, laptop sleep/wake, and network/context changes. Record bounded output while streaming long commands.

**Acceptance criteria:**

- A failed lifecycle command remains diagnosable after dashboard restart; searchable full logs have rotation and redaction.
- Recovery tests cover Docker off/on, sleep-like connection loss, gateway replacement, and opencode crash without duplicate sessions or permanent busy flags.
- The UI shows the last successful update and stale state while disconnected; sensitive mutations require fresh state.
- A large build log cannot grow server memory without bound; diagnostic export previews files and omits tokens, environment secrets, and private prompt text by default.

### DX-10 — Deterministic rebuilds and environment updates

**Confirmed.** Base image keys use Git objects at HEAD for `.devcontainer` and configured key files. Uncommitted config changes and dependencies outside that directory can miss invalidation. Task environment APIs currently provide create/start/stop/remove, while recreate, rebuild-image, outdated badges, and idle stop also appear in a design document. Generated onboarding uses rolling images and the current opencode installer. See [images.ts](../apps/opendevhub/src/server/images.ts), [env-config.ts](../apps/opendevhub/src/server/env-config.ts), [stack templates](../apps/opendevhub/src/shared/stacks.ts), and [environment design](superpowers/specs/2026-10-03-per-task-environments-design.md).

**Scope:** hash the actual effective build inputs, including dirty files, Dockerfile/context dependencies, relevant ignore rules, and resolved configuration. Show image/config provenance and outdated environments. Add explicit restart, recreate container, rebuild image, and rebuild without cache actions with data-impact previews. Support a tested opencode version range/capability check and a reproducible installation option.

**Acceptance criteria:**

- Editing an uncommitted devcontainer file or Dockerfile outside `.devcontainer` invalidates the correct image; unrelated source edits do not unnecessarily rebuild it.
- Users can rebuild one task environment without manually deleting Docker images or affecting another environment.
- Recreate/rebuild explains what happens to container home, sessions, bind mounts, and volumes; valuable state is exported or retained before destructive replacement.
- Warm-start cache reuse is measured, cache provenance is visible, and unsupported opencode APIs disable only affected features with a clear compatibility message.

### DX-11 — Docker Compose service ports and task isolation

**Confirmed.** `db:5432` forwarding is rejected; Compose configs cannot get isolated task environments. Published ports, host networking, and some lifecycle variable use also block isolation. See [ports.ts](../apps/opendevhub/src/server/ports.ts), [isolation blockers](../apps/opendevhub/src/server/env-config.ts), and [known limitations](../README.md#known-limitations).

**Scope:** first forward service ports in existing Compose projects. Then support per-worktree Compose projects with generated overrides, unique Compose project names, explicit network/volume ownership, safe host-port allocation, and correct lifecycle substitution. Keep authored files unchanged. Offer deliberate snapshot/seed commands for databases rather than silently sharing mutable databases between variants.

**Acceptance criteria:**

- A main Compose project forwards `db:5432` to a labeled loopback endpoint, with useful service-down diagnostics.
- Two task environments using the same app/database Compose definition run simultaneously without port, container-name, or writable-volume collisions.
- Stop/recreate/cleanup targets only resources owned by that environment; external volumes/services are identified and excluded.
- Unsupported Compose constructs and intentionally shared resources are explained before starting; generated overrides can be inspected and reproduced.

### DX-12 — Resource limits, queueing, and opt-in idle stop

**Confirmed gap.** CPU/memory stats and selective cleanup exist, but settings only resolve isolation/key files/SSH-agent policy; runtime concurrency and idle-stop policies from the environment design are not implemented in those settings. Existing startup serialization addresses a CLI race, not a user-configurable resource budget. See [env settings](../apps/opendevhub/src/server/env-config.ts), [resources.ts](../apps/opendevhub/src/server/resources.ts), [cleanup.ts](../apps/opendevhub/src/server/cleanup.ts), and [orchestrator.ts](../apps/opendevhub/src/server/orchestrator.ts).

**Scope:** configurable maximum running environments and concurrent starts/tasks, queue visibility, Docker CPU/memory limits where supported, optional idle stop for main/task environments, and disk-usage estimates. Retain worktrees and task records; stopping must not mean deleting.

**Acceptance criteria:**

- Submitting several variants on a laptop produces a visible bounded queue instead of starting everything at once.
- Waiting-for-permission/question sessions and pinned terminals/dev servers prevent automatic stop; users can pin a project or disable the policy.
- Stop offers a clear resume path and shows which forwarding/SSH-agent features cease while stopped.
- Low-memory/disk-pressure notices identify the contributing environments and offer scoped cleanup; no general `docker system prune` is used.

### DX-13 — Host Git and review while containers are stopped

**Confirmed.** Local files and relative worktrees are host-accessible, and publish can use host Git. Review uses opencode VCS endpoints and the main environment gates the review UI; normal Git operations generally depend on the project container. See [ProjectReview](../apps/opendevhub/src/web/pages/ProjectReview.tsx), [GitOps](../apps/opendevhub/src/server/git.ts), [publisher location selection](../apps/opendevhub/src/server/publish.ts), and [worktrees.ts](../apps/opendevhub/src/server/worktrees.ts).

**Scope:** a host Git adapter for readable local checkouts, supporting status/diff/commit/fetch/merge/publish independently of opencode. Pick the execution location visibly and preserve host hooks, credential helpers, and signing. Keep container Git fallback for incompatible absolute worktree links.

**Acceptance criteria:**

- A stopped project can still review local changes, commit, run eligible host checks, and publish without starting Docker/opencode.
- Host-incompatible worktrees explain the restriction and offer container fallback; they are never silently relinked.
- Dirty-main-checkout semantics are explicit when creating a worktree: the base commit is shown and uncommitted changes are not implied to carry over.
- Git metadata remains valid on host and container for supported Git versions, custom workspace names, and repo paths with spaces/non-ASCII characters; submodules and Git LFS have documented/tested behavior.

### DX-14 — Persistent terminal and development commands

**Proposed; also in existing backlog.** Editors and lifecycle logs exist, but there is no dashboard terminal or general development command runner. Opencode PTY capabilities need verification against the supported release before reuse. See [existing backlog](superpowers/backlog.md) and [opencode client](../apps/opendevhub/src/server/opencode/client.ts).

**Scope:** a terminal bound to the selected checkout/environment, plus named commands such as start dev server, seed database, or run a focused test. Reuse PTYs where possible, respect host-command trust, and link started services to forwarded ports.

**Acceptance criteria:**

- A developer opens a terminal at the correct worktree with visible environment/node identity, resizes it, and reconnects after a dashboard reload.
- Named commands expose working directory, execution location, output, and stop action; restarting a command does not strand a second dev server.
- Terminal activity integrates with idle-stop pinning and process cleanup; a terminal failure remains independent from task/session deletion.

### DX-15 — Drafts, templates, and explicit task context

**Confirmed baseline; proposed extension.** New task accepts free text, branch/base, agent/model variants, and environment/node selection. Task metadata contains a minimal task identity; there is no durable draft/template/source-context model. Review comments already have their own persisted browser drafts. See [NewTaskDialog](../apps/opendevhub/src/web/components/NewTaskDialog.tsx), [task types](../apps/opendevhub/src/shared/types.ts), and [review helpers](../apps/opendevhub/src/web/review.ts).

**Scope:** save/resume task drafts, per-project reusable templates, remembered model/agent defaults, file/selection/diff references, and previewable source context. Preserve the originating prompt and acceptance criteria in task history. Context selection should be explicit and small by default.

**Acceptance criteria:**

- Closing/reloading the dialog does not lose a draft; saved templates can be edited without changing past tasks.
- Templates can supply checks, acceptance criteria, and model defaults while showing the final prompt before submission.
- A task records the base commit and a snapshot/reference for each selected context item; later edits do not silently rewrite what the agent received.
- Ignored files and credentials are excluded by default; attachments/comments from integrations require deliberate selection and a preview.

### DX-16 — Local/offline notifications and notification policy

**Confirmed.** Web Push supports closed tabs but depends on browser vendor services and internet; notification enablement is address/browser-specific. See [push.ts](../apps/opendevhub/src/server/push.ts), [notifier.ts](../apps/opendevhub/src/server/notifier.ts), and [notification docs](../apps/docs/content/docs/notifications.mdx).

**Scope:** an in-app event inbox with optional desktop-native notifications, per-project/event preferences, quiet hours, grouping, and generic outbound webhook/ntfy support. Choose whether prompt/command details appear in notification bodies. Preserve current Web Push actions.

**Acceptance criteria:**

- Local activity and an in-app notification history work without internet; an available native desktop adapter can notify without a push vendor.
- Reconnects do not replay a burst of already-handled notifications; unresolved input stays findable in the inbox.
- Optional webhook delivery supports test, bounded retry/backoff, and delivery diagnostics; configured URLs/tokens are redacted.
- Browser limitations and the requirement that OpenDevHub/the browser remain running are clearly shown.

## Jira and forge integrations

### INT-01 — Local connector foundation and account settings

**Confirmed gap.** `forges` currently describes host/kind/web origin; it is not an authenticated service connection. Existing forge logic detects hosts and generates publish destinations. No Jira connector exists. See [forge.ts](../apps/opendevhub/src/server/forge.ts), [publish.ts](../apps/opendevhub/src/server/publish.ts), and [config.ts](../apps/opendevhub/src/server/config.ts).

**Scope:** a small capability-based connector boundary for issue search/read, PR read/create, comments, CI read, and optional write actions. Implement only abstractions exercised by initial adapters. Add account/instance settings, project-to-repository mappings, authenticated connection tests, least-needed scopes, timeouts, pagination, caching, and rate-limit handling. Use polling for laptops; webhooks are optional and must not require a public inbound port.

**Acceptance criteria:**

- Multiple accounts and self-hosted instances can coexist; each project explicitly selects its connection/repository. Support configurable API/web origins, SSH aliases, and installed CA trust without disabling TLS verification.
- Tokens are stored through DX-04 secret references; disconnect removes access, with cache-retention choices documented.
- Unsupported provider capabilities are shown in the UI; a connection failure does not block local tasks or existing token-free publishing.
- Rate limits, expired credentials, pagination, and network outages produce actionable state. Cached data displays its fetch time and supports refresh.

**Boundary:** local issue/PR metadata is cached context; the external provider owns its issue/PR state. Agents receive selected issue content, not connector tokens. External text is context, not permission to execute embedded instructions or enable additional tools.

### INT-02 — GitHub and Forgejo issues to tasks

**Proposed; existing backlog has “Tasks from issues.”** Extend the already implemented publishing integration rather than replace it.

**Scope:** GitHub and Forgejo adapters first; search/filter assigned issues, paste an issue URL, preview title/body/selected comments, map repository to a local project, and create an issue-linked task/worktree. Include issue identity in branch naming and prompt context. GitLab/Gitea can follow through proven connector capabilities.

**Acceptance criteria:**

- A GitHub or self-hosted Forgejo issue can become a task in the mapped local repo with editable prompt and base branch.
- Task history records provider instance, repository, external ID/key, URL, imported revision/time, and selected context; retries do not accidentally create duplicate tasks.
- Branches/PR descriptions link the issue using provider-appropriate syntax; updates to the source issue are surfaced without silently altering the running task.
- “Post progress comment” and “close issue” are explicit configurable write actions; importing or finishing an agent turn alone does neither.

### INT-03 — Jira issues to tasks

**Proposed; specifically requested integration area.** Jira needs separate instance/account and workflow handling, not just forge issue URL parsing.

**Scope:** Jira Cloud first, with an adapter boundary and later compatibility spike for Jira Data Center. Support paste issue URL/key, JQL/assigned-to-me filters, project/repo mapping, rich-description conversion, selected comments, acceptance criteria, and parent/subtask links. A Jira project may map to several repositories, so let the user choose the target repo.

**Acceptance criteria:**

- A selected Jira issue becomes a local task with an editable context preview, original issue key/URL, and branch name such as `PROJ-123-fix-login`.
- Rich text/code blocks remain readable; comments and attachment contents are imported only when selected. Custom acceptance-criteria fields are configurable per instance/project.
- Draft PR descriptions include the issue link. Missing permission, an unmapped repository, or unsupported fields produce a useful fallback.
- Commenting, assignment changes, and workflow transitions are optional explicit actions; transition options are read from Jira, never hard-coded to a universal “Done.”
- Read-only Jira use works independently of forge credentials; a task can link a Jira issue and a GitHub/Forgejo PR simultaneously.

### INT-04 — Full PR lifecycle, reviews, and CI visibility

**Confirmed gap beyond publishing.** Current publishing pushes and records remote-output PR links, or opens a compare page. It does not provide authenticated PR creation/status/review/CI APIs. Forgejo AGit already creates/updates a PR through Git and should remain available. See [Publisher](../apps/opendevhub/src/server/publish.ts) and [PublishDialog](../apps/opendevhub/src/web/components/PublishDialog.tsx).

**Scope:** API-backed draft PR creation/update, reconcile already-existing PRs after timeouts, PR state, reviewer feedback, and CI checks/log links pinned to the latest commit. Import an existing PR into a worktree for local review/fix work. Show draft/published/merged/closed separately from “branch pushed.”

**Acceptance criteria:**

- GitHub/Forgejo users can create or update one draft PR, preserving Markdown, with editable title/body and supported metadata; a timeout/retry first checks whether creation succeeded.
- Existing Git-only publish remains functional without tokens. AGit's single-line description behavior is visible; the API path preserves full multiline descriptions.
- CI status and review comments show the corresponding commit and fetch time; old-commit success is not shown as validation of new changes.
- “Fix this failure/comment” creates or continues a local task using selected bounded context. It does not automatically publish, resolve threads, or merge.
- Merged PRs can suggest safe cleanup; external merge status alone never deletes dirty or unpushed local work.

## Developer control and polish

### DX-17 — Budget warnings and usage confidence

**Confirmed partial support.** A SQLite usage ledger and per-task/project totals exist. Usage is observed from session snapshots and booked using session update time, so the UI should distinguish reported usage from a billing system. There is no task budget policy. See [usage.ts](../apps/opendevhub/src/server/usage.ts), [UsagePage](../apps/opendevhub/src/web/pages/UsagePage.tsx), and [task usage](../apps/opendevhub/src/web/usage.ts).

**Scope:** per-task/project/day warning thresholds, aggregate comparison-variant spend, optional stop-on-budget where safely supported, export, and model/provider breakdown when upstream data permits. Show unknown pricing/missing telemetry and observation gaps.

**Acceptance criteria:**

- Creating four variants displays their combined budget and observed spend; threshold crossings emit one actionable warning.
- Restart/reconciliation does not double-count known usage; unavailable pricing is not represented as confirmed zero cost.
- Users can export totals and inspect reporting limitations; retrospective bookings are identified when activity occurred while disconnected.
- A configured stop policy interrupts without deleting work and describes polling latency/possible overshoot; it never claims a hard provider billing cap.

### DX-18 — Practical project trust and permission policies

**Confirmed foundations; proposed extension.** Host checks have exact-command approval, server/proxy enforce host/origin rules, and SSH forwarding is configurable. Task creation does not expose a complete project trust/permission policy. See [checks.ts](../apps/opendevhub/src/server/checks.ts), [dashboard-api.ts](../apps/opendevhub/src/server/dashboard-api.ts), [proxy.ts](../apps/opendevhub/src/server/proxy.ts), and [task creation](../apps/opendevhub/src/server/orchestrator.ts).

**Scope:** inspect the effective devcontainer configuration before first run: host lifecycle commands, mounts, Docker socket/privileged access, SSH forwarding, and requested provider capabilities. Persist trust per project/configuration. Add narrowly scoped permission presets and optional egress policy later; network filtering is a separate control, not proof that arbitrary auto-approval is safe.

**Acceptance criteria:**

- First-run trust shows actual host access and credential forwarding; materially changed host access requires renewed trust.
- Policy distinguishes safe repeated operations from publishing, external writes, credential access, and destructive actions; saved approvals are inspectable and revocable.
- Integration tools and permissions remain scoped to the selected project/account; imported issue/comment text cannot change these policies.
- Existing loopback host/origin protection is preserved as APIs grow, with regression coverage for HTTP mutations and WebSocket upgrades.

### DX-19 — Keyboard, accessibility, and large-workspace performance

**Proposed extension of existing UX.** Command palette, shortcuts, responsive components, diff limits, lazy-loaded review widgets, and batched logs already exist. Browser behavior and accessibility were not evaluated live in this review. See [CommandPalette](../apps/opendevhub/src/web/components/CommandPalette.tsx), [useDashboard](../apps/opendevhub/src/web/useDashboard.ts), [review limits](../apps/opendevhub/src/server/review.ts), and [monitor caps](../apps/opendevhub/src/server/monitor.ts).

**Scope:** keyboard-complete task/review/permission workflows, accessible destructive dialogs in place of native confirmation flows where appropriate, visible stale/loading/error states, pagination/virtualization, and searchable history. Monitor all relevant worktree directories without silent fixed-cap omission, while bounding concurrency and preserving prompt attention ordering.

**Acceptance criteria:**

- A keyboard-only user can create a task, answer input, navigate changed files, send comments, run checks, and publish with correct focus restoration and accessible names.
- Permission/question requests in more than 16 worktree directories remain discoverable; explicit monitoring limits/warnings replace silent gaps.
- A synthetic workspace of 50 projects and 500 indexed tasks remains usable under log/event bursts; record initial-load, interaction latency, and request counts before setting performance budgets.
- Large/binary diffs retain existing guardrails; truncation and failed loads are clear and recoverable without hiding the file list.

### DX-20 — Real local-platform and browser regression coverage

**Confirmed coverage gap.** Many unit/integration and real devcontainer E2E tests exist. CI currently runs on Ubuntu/Node 24; `test/web` runs in a Node environment and primarily exercises helper logic. The normal CI job does not run the Docker E2E suite. See [CI](../.github/workflows/ci.yml), [Vitest config](../apps/opendevhub/vitest.config.ts), and [existing E2E tests](../apps/opendevhub/test/e2e/).

**Scope:** preserve fast tests, add browser journeys, minimum-supported Node coverage, scheduled/release-gated Docker E2E, gateway-mode coverage, and supported macOS/Linux smoke environments. Test the packed npm artifact, not only the source checkout. Include installation and upgrade paths.

**Acceptance criteria:**

- Fast CI covers the documented Node floor and current release runtime; installation of the packed package can load its dashboard assets and run CLI help/doctor.
- Browser tests cover first run, failed/retried task setup, permission races, check staleness, selective commits, and draft persistence.
- Release validation exercises real devcontainers in direct/gateway modes and at least one supported macOS Docker setup; platform limitations and rootless Docker support are explicit.
- Fixture suites cover Compose services, relative worktrees, Git submodules/LFS where supported, isolated environments, restart adoption, and image invalidation. Connector contract tests use fixtures/mocks; live credentials are not needed for ordinary CI.

## Optional extensions

### EXT-01 — Remote access and remote-node parity

**Confirmed partial support.** SSH execution nodes already exist; remote checks and editor opening are documented gaps. The dashboard binds to loopback, so phone/LAN dashboard access is separate work. See [nodes documentation](../README.md#remote-nodes-preview), [server binding](../apps/opendevhub/src/server/server.ts), and [check target](../apps/opendevhub/src/server/orchestrator.ts).

**Scope:** after local reliability, support remote-node checks, terminal/editor attach, and equivalent diagnostics. Separately add opt-in authenticated dashboard access over a private tunnel/Tailscale or explicit secure origin; do not casually widen the existing bind.

**Acceptance criteria:**

- Remote checks use the selected node/environment and never silently run a remote task's host command on the local machine.
- Offline nodes preserve last-known state and recover without losing branch/task links; bringing work home is visible and idempotent.
- Remote access authenticates dashboard/API/WebSocket traffic, keeps origin protections and expiring sessions, and generates reachable links without relying on client `.localhost` names.

### EXT-02 — Bounded scheduled/reactive automation

**Proposed; already sketched in existing backlog.** Useful for dependency maintenance and CI fixes, but depends on reliable resumable tasks and integration identities.

**Scope:** opt-in schedules and reactions to selected CI/review events, initially producing drafts/tasks for human review. Include deduplication, quiet hours, per-project limits, budgets, and disable/pause controls.

**Acceptance criteria:**

- Restart or a repeated event does not create duplicate maintenance tasks; events are keyed to repository/PR/commit/check identity.
- Laptop sleep/offline periods have an explicit skip/catch-up policy; queued automation respects resource and cost limits.
- A fix→push→CI failure loop has bounded retries and an audit trail. Automatic external writes remain separately configured from task creation.

## Integration data contract

Start with a small versioned local task record, extending current `metadata.opendevhub` via reconciliation rather than putting all persistence into upstream session metadata:

| Field | Purpose |
| --- | --- |
| `taskId`, `projectId`, `createdAt` | Stable local task identity independent of process lifetime/path |
| `prompt`, `templateRef`, `acceptanceCriteria` | Original request and its reviewable intent |
| `baseRef`, `baseCommit` | Exact starting point |
| `contextRefs[]` | Selected source/file/issue snapshots with imported revision/time |
| `variants[]` | Session/environment/node/branch IDs, setup step, outcome, observed usage |
| `externalRefs[]` | Connection ID, provider/instance, repository/project, type, ID/key, canonical URL |
| `checkRunRefs[]`, `publishRefs[]` | Content/environment-bound validation and PR associations |
| `status`, `archivedAt`, `lastReconciledAt` | User workflow state and synchronization freshness |

Keep credentials out of these records. Import provider descriptions as text with source attribution; normalize display fields while retaining external IDs and capability-specific data. External writes need idempotency/reconciliation so a response timeout does not produce duplicate PRs/comments/transitions. Cache reads for offline reference; queue writes only with an explicit user-visible policy and reconfirm stale state before execution.

## Recommended delivery sequence

1. **Correctness and recovery:** DX-01, DX-02, DX-03, DX-06; start DX-20 coverage immediately. Exit when check freshness, stale previews, and setup diagnostics are trustworthy.
2. **Daily local workflow:** DX-04, DX-05, DX-07, DX-08, DX-09, DX-13, DX-15. Exit when a fresh machine can start/retry/review a task and previous work remains accessible after restart.
3. **Parallel environments:** DX-10, DX-11, DX-12. Start Compose service forwarding as an independently useful slice; then tackle per-task Compose isolation.
4. **Requested integrations:** INT-01, then a GitHub/Forgejo issue-import vertical slice (INT-02), Jira read/import (INT-03), and PR/CI APIs (INT-04). Begin account/data-contract design earlier; do not make connectors a prerequisite for local workflow.
5. **Polish and optional automation:** DX-14, DX-16 through DX-19, then EXT-01/EXT-02 according to actual use.

Within each item, split implementation into issues with the ID as a prefix, acceptance criteria copied verbatim or narrowed to the slice, evidence links, dependencies, and a demonstration scenario. Re-estimate effort after compatibility spikes for Compose, provider auth, and Jira Data Center.

## Decisions to settle when picking up work

- Is “works locally” strictly devcontainer-based, or should an opt-in host-only agent backend exist? Keep host Git/review (DX-13) in scope now; a second agent execution backend needs its own product decision.
- Which Linux/macOS Docker setups are release-supported? Document Windows/WSL status explicitly; do not promise native Windows support without a separate investigation.
- Is Jira Cloud the first target, and is Data Center required for the intended users? Which self-hosted Forgejo versions/CA/proxy setups matter?
- Which provider login flows can the supported opencode version handle without sharing container `$HOME`? Verify endpoints rather than relying on old design notes.
- What survives removal/recreation of a task container: conversation export, terminal history, generated artifacts, database volumes? Agree retention before exposing destructive rebuild automation.
- What is the desired privacy/default retention for prompts, imported issues, logs, notifications, and diagnostics? Favor local storage and explicit export with bounded retention.
- Should checks remain advisory or be mandatory per project? Keep the current advisory default and let teams opt into a clearly enforced policy.

## Relationship to the existing backlog

This file is the source-backed local/DX specification; [superpowers/backlog.md](superpowers/backlog.md) remains the historical sketch list. Before picking up its older items, reconcile their status:

- **Already implemented:** CPU/memory resource stats; syntax highlighting and split diffs. Do not open new implementation issues for these as missing features.
- **Still relevant:** credential setup, Compose service forwarding/isolation, issue-driven tasks, terminal, notification channels, remote access, idle stop, and bounded automation. Their expanded scopes appear above.
- **Partially implemented:** task environment lifecycle and remote nodes. Existing designs include later phases that are not present in the current APIs/settings.
- **Keep deferred:** a generic kanban board, automatic copying of dependency folders, and additional agent backends unless a concrete workflow justifies them. Improving durable searchable task history does not require a new board.

Completion of a backlog item means its acceptance criteria are demonstrated on the intended local setup, relevant automated checks pass, documentation is updated, and this file records status plus the implementing issue/PR. Feature names in documentation alone do not count as completion.
