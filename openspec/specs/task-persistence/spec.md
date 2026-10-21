# task-persistence Specification

## Purpose

How opendevhub records projects, tasks and their variants in its local database: their lifecycle from starting to archived, the spec chain, reconciliation with opencode, and the events that record what happened.

## Requirements

### Requirement: Local task database

The system SHALL keep its records in a SQLite database at `opendevhub.db` in the opendevhub state directory, created with owner-only permissions. Schema changes SHALL be applied through numbered migrations that are tracked in the database.

#### Scenario: First start creates the database

- **WHEN** opendevhub starts and `opendevhub.db` does not exist in the state directory
- **THEN** it creates the file with mode 0600 and applies every migration

#### Scenario: Pending migrations are applied

- **WHEN** opendevhub starts with a database whose schema version is lower than the latest migration
- **THEN** it applies each missing migration in order, each in its own transaction, and records the new version

#### Scenario: Database newer than the code

- **WHEN** opendevhub starts with a database whose schema version is higher than the latest migration it knows
- **THEN** it refuses to start and reports that the database was written by a newer opendevhub

### Requirement: Projects are registered

The system SHALL keep one row per discovered project with its id, path, name, devcontainer path and the time it was first seen. Discovery SHALL insert new projects and update known ones. A project that discovery no longer finds SHALL be marked missing, with the time, and SHALL NOT be deleted. Tasks and other records SHALL reference their project's row.

#### Scenario: New project discovered

- **WHEN** discovery finds a project that has no row
- **THEN** a project row is created with its path, name, devcontainer path and first-seen time

#### Scenario: Project disappears

- **WHEN** a project's folder is removed and discovery runs again
- **THEN** its row records when it went missing, the project leaves the snapshot, and its tasks remain in the database

#### Scenario: Project comes back

- **WHEN** a missing project's folder reappears at the same path
- **THEN** its row is no longer marked missing and its existing tasks belong to it again

### Requirement: Tasks are recorded when they start

The system SHALL create a task row and one variant row per requested variant before it sets up any variant. The task row holds the task id, project, kind (`task` or `review`), title, prompt (shown as the brief), Jira source, pull request, whether the task is spec-first, the draft plan when it is a draft, and creation time. The variant row holds its number, model, agent, node and step `queued`. Sessions SHALL NOT carry task metadata; the variant row is the only link between a session and its task.

#### Scenario: A task with three variants

- **WHEN** the user starts a task with three variants
- **THEN** the database holds one task of kind `task` and variants 1 to 3 with step `queued`, and the response's task id equals the task row's id

#### Scenario: Variant progress is recorded

- **WHEN** a variant moves through its setup steps and its session is created
- **THEN** its row records each step, its branch, directory, environment and session id, and the session itself has no `opendevhub` metadata

#### Scenario: Variant fails to start

- **WHEN** creating a variant's worktree fails
- **THEN** its row has step `failed` and the error message, and the other variants continue

### Requirement: Sessions show their task

Each top-level session in the dashboard snapshot that a variant owns SHALL carry its task's id and kind, its variant number, and whether that variant is discarded, all read from the database. A session that is a chat SHALL carry no task.

#### Scenario: Task session in the snapshot

- **WHEN** variant 2 of a task has a live session
- **THEN** that session in the snapshot carries the task's id, kind `task` and variant number 2

#### Scenario: Chat session in the snapshot

- **WHEN** a chat's session is listed
- **THEN** it carries no task

#### Scenario: Cost attributed to a task

- **WHEN** a task's sessions spend money
- **THEN** the usage totals attribute that spend to the task found through the sessions' variant rows, and a chat's spend to no task

### Requirement: Spec chain on tasks and variants

The system SHALL record a spec-first task's chain in the database: on the task, whether it is spec-first, the task that proposed its change and the task implementing its change; on each variant, the spec phase, the OpenSpec change it works on and the change's archive folder.

#### Scenario: Spec view finds the change

- **WHEN** the Spec view finds the OpenSpec change a spec-first variant created
- **THEN** that variant records the change name, and the task page shows it

#### Scenario: Implementing in new worktrees

- **WHEN** the user implements a proposed change in new worktrees, which starts a new task
- **THEN** the new task records the proposing task, and the proposing task records the new task as implementing its change

#### Scenario: Change archived

- **WHEN** a variant's change is archived
- **THEN** the variant records phase `archived` and the archive folder

### Requirement: Starting progress survives a restart

The system SHALL derive the dashboard's starting tasks from the database. On start, every variant that is still in a setup step and has no session SHALL be marked failed because of the restart. A failed variant SHALL stay listed until the user dismisses it.

#### Scenario: Restart during setup

- **WHEN** opendevhub restarts while a variant is at step `container` without a session
- **THEN** after the restart that variant shows step `failed` with an error saying opendevhub restarted

#### Scenario: Failed start is still visible after restart

- **WHEN** a variant failed to start and opendevhub restarts before the user dismisses it
- **THEN** the dashboard still lists the failed variant with its error

#### Scenario: Dismissing a failed start

- **WHEN** the user dismisses a starting task
- **THEN** its failed variants are no longer listed as starting, and the task row is kept

### Requirement: Tasks outlive their sessions

The system SHALL mark a variant's session as removed when a successful session listing of the variant's environment no longer includes it. It SHALL NOT delete the task or variant. A task SHALL be `draft` while it has no variants, and `ended` when it has variants, none has a live session and none is still starting. If a listing fails or the environment is unreachable, the system SHALL NOT mark any session removed.

#### Scenario: Session deleted

- **WHEN** the only session of a task is deleted and its environment's sessions are listed again
- **THEN** the variant records when its session was removed, and the task is listed with state `ended`

#### Scenario: Draft is not ended

- **WHEN** a task has no variants
- **THEN** its state is `draft`

#### Scenario: Environment unreachable

- **WHEN** a task environment's container is stopped and its sessions cannot be listed
- **THEN** its variants' sessions are not marked removed and their tasks keep their state

#### Scenario: Session reappears

- **WHEN** a session that was marked removed is listed again
- **THEN** the removal mark is cleared

### Requirement: Picks are recorded on variants

The system SHALL record the time a variant was picked on that variant, and the time of the discard on each other variant of the task. The discard SHALL be read from the variant row wherever a session's discarded state is needed, such as hiding it from the session list or cleanup.

#### Scenario: Picking a variant

- **WHEN** the user keeps variant 2 of a three-variant task
- **THEN** variant 2 records when it was picked, and variants 1 and 3 record when they were discarded

#### Scenario: Cleanup sees discards

- **WHEN** cleanup plans which sessions to offer for removal
- **THEN** it treats sessions of discarded variants as discarded, based on the variant rows

### Requirement: Archiving tasks

The system SHALL let the user archive a task. Archived tasks SHALL be left out of the dashboard snapshot and their rows SHALL be kept. Cleanup SHALL offer to archive ended tasks whose last session activity is older than its idle cutoff.

#### Scenario: Archive an ended task

- **WHEN** the user archives an ended task
- **THEN** the task no longer appears in the project's tasks, and its row records when it was archived

#### Scenario: Archive does not touch sessions

- **WHEN** the user archives a task that still has a live session
- **THEN** the task is hidden, and its session and worktree are left as they are

### Requirement: Task changes are recorded as events

The system SHALL append an event for each change to a project, task, variant, chat or session: project discovered or missing; task drafted, started, ended or archived; variant added, failed, picked or discarded; chat started, adopted from opencode, adopted by a task, or removed. Each event SHALL record when it happened, the project, who caused it (the user, a task variant, or opendevhub itself), the verb, the object and, where there is one, the task. An event SHALL be written in the same transaction as the change it records, and a reconcile that changes nothing SHALL write no events.

#### Scenario: Picking writes events

- **WHEN** the user picks variant 2 of a three-variant task
- **THEN** the events table holds a `variant.picked` event for variant 2 and `variant.discarded` events for variants 1 and 3, each with actor `user` and the task's id

#### Scenario: Adoption is attributed to the system

- **WHEN** reconcile adopts a session created directly in opencode
- **THEN** a `chat.discovered` event with actor `system` is recorded for it

#### Scenario: Steady state is quiet

- **WHEN** an environment is reconciled twice with the same sessions
- **THEN** the second reconcile records no events

### Requirement: Tasks in the dashboard snapshot

Each project in the dashboard snapshot SHALL list its tasks that are not archived. Each task SHALL have its id, kind, title, brief, Jira source, pull request, spec chain, creation time, state (`draft`, `starting`, `running` or `ended`), and its plan when it is a draft. Each variant SHALL have its number, model, agent, node, branch, directory, environment, step, error, session id, spec phase, change and archive folder, and its session-removed, picked and discarded flags.

#### Scenario: Task page reads tasks from the snapshot

- **WHEN** the dashboard shows a task's page
- **THEN** it lists the task's variants from the snapshot's `tasks`, including variants whose session was removed

#### Scenario: Discarded variants

- **WHEN** a task has a discarded variant
- **THEN** the snapshot lists the variant with its discarded flag set, and the session list still hides its session

### Requirement: Variants added to an existing task

The system SHALL let variants be added to an existing task of kind `task`: when a draft starts, and when Make task asks for extra variants. Added variants SHALL be numbered after the task's highest variant, recorded before they are set up, and set up as a starting task's variants are. Each SHALL record a `variant.added` event.

#### Scenario: Starting a draft

- **WHEN** a draft with no variants is started with two variants
- **THEN** the task gets variants 1 and 2 with step `queued`, and its state becomes `starting`

#### Scenario: Extra variants after adoption

- **WHEN** a task made from a chat has variant 1 and gets two extra variants
- **THEN** they are numbered 2 and 3

### Requirement: Manual tasks are migrated to chats

A migration SHALL turn every task of kind `manual` into a chat row for its variant's session, carrying the session id, project, environment, directory, branch, worktree, title, creation time and archive time, with origin `opencode` when the task was adopted and `hub` otherwise. It SHALL clear branch and worktree references to their variants, then delete those tasks and their variants. No task of kind `manual` SHALL be created afterwards. Events SHALL be kept.

#### Scenario: Database with manual tasks

- **WHEN** opendevhub starts with a database holding two manual tasks and one task of kind `task`
- **THEN** after the migration the database holds two chats and the one task, and no task of kind `manual`
