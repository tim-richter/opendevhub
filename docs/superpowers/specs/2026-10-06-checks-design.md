# Checks: the commands a change must pass before it's published

Date: 2026-10-06
Status: Implemented
Depends on: [review](2026-10-03-review-design.md), [publish](2026-10-03-publish-design.md).

## Problem

An agent can finish its work without running the project's tests or lint, and most projects
also need their Dockerfile or compose file to build before anything is pushed. Today you check
this by hand in a terminal. A project should list these commands once, and Review should run them
on the checkout you are looking at, show the results, and warn you at publish time when they
haven't passed on the current commit.

## Defining checks

Checks live in `customizations.opendevhub` in the project's `devcontainer.json`, next to
`isolation`, `keyFiles` and `sshAgent`, so they are committed and shared with the team:

```jsonc
"customizations": {
  "opendevhub": {
    "checks": [
      { "name": "lint", "command": "pnpm lint" },
      { "name": "test", "command": "pnpm test", "timeout": 1200 },
      { "name": "image", "command": "docker compose build", "where": "host" }
    ]
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | (required) | 1–40 characters, unique within the list. |
| `command` | (required) | Run with `sh -c` in the checkout's folder. At most 4000 characters. |
| `where` | `container` | `container`: in the checkout's environment (its own container, or the project's). `host`: on this machine, in the checkout's host folder. |
| `timeout` | `900` | Seconds, 10 to 7200. |

Invalid entries are dropped with a message the UI shows; the valid ones still work.

**Your own settings win.** The project page has a Checks section to edit the list. Saving writes
`checks` to the project's entry in `config.json` (keyed by its path, like the other settings),
which replaces the `devcontainer.json` list as a whole. "Use devcontainer.json" removes that
entry again.

`devcontainer.json` is read from the project's main checkout on this machine
(`Project.devcontainerPath`) each time the checks are listed, as JSON with comments and trailing
commas. A change is picked up without restarting anything.

## Where they run

- **container**: `sh -c` through `devcontainer exec` in the environment that serves the checkout,
  the same one opencode works in. The command is wrapped in `timeout -k 10 <s>` when the
  container has `timeout`, so a timed-out check's whole process group ends in the container too.
  The environment must be running.
- **host**: `sh -c` in the checkout's host folder, in its own process group, so a timeout kills
  everything it started. A worktree that exists only inside the container can't run host checks.

Each check gets `OPENDEVHUB_CHECK=<name>` and `OPENDEVHUB_BRANCH=<branch>`. Host checks in a
worktree also get `COMPOSE_PROJECT_NAME=<project>-<branch>` (lowercased, only `[a-z0-9_-]`) unless
it is already set, so two worktrees' `docker compose` runs don't share containers, networks or
volumes. The main checkout keeps compose's default name.

Checks run one after another, in order, and every check runs even when an earlier one failed.
One run per checkout at a time; different checkouts may run at once. A single check can be run
on its own (to retry the one that failed).

Output is kept per check (the last 500 lines, ANSI stripped) in memory. The project log gets one
line per check: `checks: lint passed in 12 s`, `checks: test failed (exit 1) in 40 s`.

## Host commands need approval

The agent can edit `devcontainer.json`. If host commands came straight from that file, an agent
could change `docker compose build` into anything and your next click would run it on your machine.
Container checks need nothing extra: the agent can already run anything in its own container.

So a host check runs only once its exact command was approved. Approval stores
`sha256("host\0" + command)` in the project's `config.json` entry under `approvedHostChecks`.
Running asks for approval in the Review page whenever a host check's command is new or has
changed, showing the exact text. Commands you save yourself in the Checks section are approved
when saved. The server refuses to run an unapproved host command, whatever the UI did.

The Dockerfile and compose file still run through your host's Docker daemon; reviewing the diff
before running host checks remains the point.

## Results belong to a commit

A run records the checkout's `HEAD` and whether it had uncommitted changes. It is **current**
while `HEAD` is the same and the dirty flag still matches; otherwise the UI shows it as out of
date. Committing after a run on a dirty tree therefore makes it out of date, which is right: the
commit may differ from what was tested.

## Review

The toolbar gets a **Checks** button whose icon is the summary: none defined (hidden), not run or
out of date (circle), running (spinner), all passed (check, green), any failed (cross, red). It
toggles a Checks panel under the toolbar, which opens by itself while a run is going or when it
failed.

The panel lists each check with its `where`, status, duration and exit code; **Run all**, and a
run button per check; and the output of a check when expanded (failed checks expanded). When
host checks need approval, Run shows their commands and an **Approve and run** button.

When a check failed, **Ask agent to fix** sends the failed checks' commands and the last 80
lines of their output to the chosen session (the same choice as for review comments), like
"Ask agent to resolve" does for conflicts.

The page polls the run once a second while it is going and reloads the summary when it ends.

## Publish

Publishing is never blocked. When checks are defined and the latest run isn't current and all
passed, the Publish dialog shows a warning saying which (not run, out of date, or failed: names).

## API

| Route | Does |
| --- | --- |
| `GET /api/projects/:id/checks[?directory=]` | The resolved checks with their `approved` flag, the source (`devcontainer`, `settings` or `none`), both lists, parse errors; with `directory`, also its latest run and whether it is current. |
| `POST /api/projects/:id/checks/settings` `{ checks: Check[] \| null }` | Saves the `config.json` override (approving its host commands), or removes it with `null`. |
| `POST /api/projects/:id/checks/run` `{ directory, names?, approve? }` | Approves the listed commands if they are current host commands, then starts a run (all checks, or the named ones). 409 when one is already running there; 400 when a host check still needs approval. Returns the run. |
| `GET /api/projects/:id/checks/run?directory=` | The latest run only, cheap enough to poll. |

## Components

- `server/checks.ts`: pure parsing and resolution (`parseChecks`, `resolveChecks`, `hostCheckHash`,
  `parseJsonc`), and `Checks`, which owns runs. Its dependencies are ports: the orchestrator's
  `checkTarget` (project, environment target, checkout, branch; validates the directory),
  container exec with streaming, a host runner, git `HEAD`/clean, the project settings store,
  file reading and a log function.
- `server/config.ts`: `FileProjectSettings`, which reads and updates a project's `config.json`
  entry, re-reading the file first like `FileForgeStore`.
- `exec.ts` gains `cwd`; `Containers.exec` passes `onLine` through.
- Web: `api.ts` calls, `checks.ts` (summary, staleness, prompt text; unit tested),
  `components/ChecksPanel.tsx` for Review, `components/ChecksSettings.tsx` for the project page,
  and the warning in `PublishDialog`.

## Testing

Unit tests for parsing, JSONC, resolution, hashing, the run lifecycle (pass, fail, timeout,
approval refused, busy, host without a host folder, compose name), settings persistence, the API
routes, and the web summary and prompt helpers. Then a manual run in the real app.

## Not in this version

- Stopping a running check (the per-check timeout ends hung ones).
- Telling agents about the checks so they run them before finishing.
- Keeping results across a dashboard restart.
- Requiring checks before publishing.
