# manual-tasks Specification

## Purpose

How sessions that were not started as part of a task still belong to one: opendevhub gives every top-level session without a task an implicit manual task.

## Requirements

### Requirement: Every top-level session belongs to a task

The system SHALL make sure that every top-level session in a project's environments belongs to exactly one task. A session that does not belong to a started task SHALL belong to an implicit task of kind `manual` with a single variant. Subagent sessions SHALL NOT get tasks of their own.

#### Scenario: Subagents are not tasks

- **WHEN** a session spawns subagent sessions
- **THEN** only the top-level session belongs to a task, and no task is created for the subagent sessions

#### Scenario: One task per session

- **WHEN** a session is reconciled many times
- **THEN** it belongs to the same single task each time

### Requirement: Manual tasks for sessions opendevhub starts

When opendevhub creates a session outside a task, it SHALL create a manual task for that session before it reconciles the environment. This applies to a new session in a checkout, a new worktree started with a session, and a new session made to generate text. The variant SHALL record the session id, directory, environment, and the branch when the directory is a worktree.

#### Scenario: New session from the session list

- **WHEN** the user starts a new session in the main checkout
- **THEN** a task of kind `manual` exists with one variant whose session id is the new session's id and whose step is `session`

#### Scenario: New worktree with a session

- **WHEN** the user creates worktree `feature/login` and asks for a session in it
- **THEN** the session's manual task records branch `feature/login` and the worktree's directory on its variant

#### Scenario: Generated text in a new session

- **WHEN** opendevhub generates a commit message in a new session
- **THEN** that session belongs to a manual task

### Requirement: Adopting sessions created elsewhere

When reconcile lists a top-level session that has no variant row, the system SHALL adopt it into a new manual task whose creation time is the session's creation time. While opendevhub is creating a session in a directory, for a task variant or a manual task, reconcile SHALL NOT adopt unknown sessions in that directory. It SHALL leave them for a later reconcile.

#### Scenario: Session started in opencode directly

- **WHEN** the user creates a session in an environment's opencode outside opendevhub and the environment is reconciled
- **THEN** the session belongs to a new manual task created at the session's creation time

#### Scenario: Task session listed while it is being created

- **WHEN** reconcile lists a new session in a directory where a task variant is creating its session, before the variant has recorded the session id
- **THEN** no manual task is created for it, and once the variant records the session id the session belongs to that variant

### Requirement: Manual task titles follow their session

A manual task's title SHALL be updated to its session's title on each reconcile. The title of a task of kind `task` SHALL NOT change when its sessions are renamed.

#### Scenario: opencode renames a session

- **WHEN** opencode retitles a manual task's session after its first turn
- **THEN** the manual task's title shows the new title after the next reconcile

### Requirement: Manual tasks in the dashboard

The dashboard SHALL show a manual task as its single session, without variant controls such as picking a variant. Manual tasks SHALL share the task lifecycle: they end when their session is removed, and they can be archived.

#### Scenario: Manual task in the task list

- **WHEN** a project has a manual task with a live session
- **THEN** the dashboard shows it as one session that opens the session page, with no variant comparison or pick action

#### Scenario: Ended manual task

- **WHEN** a manual task's session is deleted
- **THEN** the task is listed as ended and can be archived
