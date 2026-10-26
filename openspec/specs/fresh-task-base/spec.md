# fresh-task-base Specification

## Purpose

Starting each task from the latest base: fetching the base's remote and fast-forwarding the local base when that's safe, falling back to the local base when it isn't, the new task dialog's base status line, the base position endpoint and its fetch throttling, and the setting that turns the update off.

## Requirements

### Requirement: Base is updated before a task starts

Before creating a task's worktrees, opendevhub SHALL fetch the base branch's remote in the main checkout. When the setting "Update the base branch before starting a task" is on and the update is safe, it SHALL then fast-forward the local base branch to its upstream. The base is the Base field's value, or the main checkout's current branch when that field is empty.

The base's upstream SHALL be its configured upstream (`<base>@{u}`). Without one, it SHALL be `<remote>/<base>` when that ref exists, where the remote is `origin`, or else the first remote.

The update SHALL be safe only when the upstream contains the local base (a fast-forward), and either:

- the base is not checked out in the main checkout, in which case only the ref is moved, or
- the base is checked out in the main checkout and the main checkout has no uncommitted changes, in which case the main checkout is fast-forwarded.

opendevhub SHALL NOT merge, rebase, reset or stash to update the base. The fetch and update SHALL run once per task, before any of its variants' worktrees are created. All variants SHALL then branch from the same commit.

#### Scenario: Stale local main

- **WHEN** the user starts a two-variant task with an empty Base, the main checkout is on `main` with no uncommitted changes, and `origin/main` has 5 commits that local `main` lacks
- **THEN** opendevhub fetches `origin`, fast-forwards `main` by 5 commits, and both variants' branches start from the new `main`

#### Scenario: Base not checked out

- **WHEN** the user starts a task with Base `release/2.0`, the main checkout is on `main`, and `origin/release/2.0` is 2 commits ahead of local `release/2.0`
- **THEN** opendevhub moves `release/2.0` to `origin/release/2.0` without touching the main checkout's files, and the task branches from it

#### Scenario: Setting off

- **WHEN** "Update the base branch before starting a task" is off and the user starts a task
- **THEN** opendevhub still fetches but leaves the local base where it is, and the task branches from the local base

### Requirement: Unsafe updates fall back to the local base

When the base can't be safely fast-forwarded or the fetch fails, the task SHALL still start, from the local base as it is. opendevhub SHALL record the reason in the project's activity log. The reasons are:

- the main checkout has uncommitted changes (and the base is checked out there)
- the local base has commits its upstream lacks
- the base has no upstream
- the remote couldn't be reached, or the fetch timed out

Each of the task's variants SHALL also carry the reason as its setup notice, so the task page shows it. A failed fetch or update SHALL NOT fail the task.

#### Scenario: Uncommitted changes in the main checkout

- **WHEN** the main checkout is on `main` with uncommitted changes, `origin/main` is ahead, and the user starts a task
- **THEN** the task branches from local `main`, the main checkout is left untouched, and the activity log says `main` wasn't updated because the main checkout has uncommitted changes

#### Scenario: Diverged base

- **WHEN** local `main` has 2 commits that `origin/main` lacks, and `origin/main` has 3 that local `main` lacks
- **THEN** the task branches from local `main`, and the activity log says `main` has local commits that aren't on `origin`

#### Scenario: Offline

- **WHEN** fetching `origin` fails and the user starts a task
- **THEN** the task branches from local `main`, and the activity log records that the fetch failed and when the last successful fetch was

### Requirement: Base status in the new task dialog

When the new task dialog creates worktrees, it SHALL show one status line under the Base field for the base it will use. The line SHALL read one of:

- "Will update <base> from <remote> first · <n> new commits", when the setting is on and a safe update is possible
- "<base> is up to date with <remote>", when the local base contains its upstream
- "<base> is <n> behind <remote>; starting from local <base>", when the setting is off
- the fallback reason, when a safe update isn't possible (as in "Unsafe updates fall back to the local base")

Each line SHALL end with how long ago the remote was last fetched, for example "fetched just now" or "fetched 2h ago". While the position is being read, the line SHALL show a loading state. The line SHALL follow the Base field as the user edits it, debounced. The line SHALL NOT block starting the task.

#### Scenario: Opening the dialog with a stale main

- **WHEN** the user opens the new task dialog, the setting is on, and `origin/main` is 5 commits ahead of a clean, checked-out `main`
- **THEN** the line under Base reads "Will update main from origin first · 5 new commits · fetched just now"

#### Scenario: Typing another base

- **WHEN** the user types `release/2.0` into Base
- **THEN** the line updates to describe `release/2.0` relative to its upstream

#### Scenario: Not a worktree task

- **WHEN** the user creates a task that runs in the main checkout rather than in a new worktree
- **THEN** no base status line is shown

### Requirement: Base position endpoint

The server SHALL report a branch's position for a project: its upstream ref, the commits it is ahead of and behind that upstream, whether a safe fast-forward is possible and, if not, why, and when the remote was last fetched.

When the remote's last successful fetch is older than 5 minutes, or has never happened, reading the position SHALL fetch first. A request MAY ask for a fetch regardless of age. Concurrent fetches of the same project's remote SHALL be shared, so that at most one runs at a time.

#### Scenario: Throttled fetch

- **WHEN** the dialog reads `main`'s position twice within a minute
- **THEN** the first read fetches `origin` and the second answers from the refs already fetched, both reporting the same last-fetched time

#### Scenario: Forced fetch

- **WHEN** the user clicks the fetch action 30 seconds after a fetch
- **THEN** opendevhub fetches again and reports the new last-fetched time

### Requirement: Update setting

The Git settings page SHALL hold "Update the base branch before starting a task", one setting for all projects. It SHALL default to on.

#### Scenario: Default

- **WHEN** the user has never changed this setting
- **THEN** starting a task updates the base when that's safe

### Requirement: Remote nodes keep the local base

A task whose worktree is created on a remote node SHALL branch as it does today, with no fetch or update of the base by this change.

#### Scenario: Node task

- **WHEN** the user starts a task on node `builder`
- **THEN** opendevhub neither fetches nor updates the base for it, and the new task dialog shows no base status line for it
