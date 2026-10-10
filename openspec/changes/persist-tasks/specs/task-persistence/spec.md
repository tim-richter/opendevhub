## ADDED Requirements

### Requirement: Local task database

The system SHALL keep tasks and their variants in a SQLite database at `opendevhub.db` in the opendevhub state directory, created with owner-only permissions. Schema changes SHALL be applied through numbered migrations that are tracked in the database.

#### Scenario: First start creates the database

- **WHEN** opendevhub starts and `opendevhub.db` does not exist in the state directory
- **THEN** it creates the file with mode 0600 and applies every migration

#### Scenario: Pending migrations are applied

- **WHEN** opendevhub starts with a database whose schema version is lower than the latest migration
- **THEN** it applies each missing migration in order, each in its own transaction, and records the new version

#### Scenario: Database newer than the code

- **WHEN** opendevhub starts with a database whose schema version is higher than the latest migration it knows
- **THEN** it refuses to start and reports that the database was written by a newer opendevhub

### Requirement: Tasks are recorded when they start

The system SHALL create a task row and one variant row per requested variant before it sets up any variant. The task row holds the task id, project, kind `task`, title, prompt, Jira source and creation time. The variant row holds its number, model, agent, node and step `queued`. The system SHALL keep writing `TaskMeta` to each variant's session as before.

#### Scenario: A task with three variants

- **WHEN** the user starts a task with three variants
- **THEN** the database holds one task of kind `task` and variants 1 to 3 with step `queued`, and the response's task id equals the task row's id

#### Scenario: Variant progress is recorded

- **WHEN** a variant moves through its setup steps and its session is created
- **THEN** its row records each step, its branch, directory, environment and session id, and the session's metadata still carries `TaskMeta` with the same task id and variant number

#### Scenario: Variant fails to start

- **WHEN** creating a variant's worktree fails
- **THEN** its row has step `failed` and the error message, and the other variants continue

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

The system SHALL mark a variant's session as removed when a successful session listing of the variant's environment no longer includes it. It SHALL NOT delete the task or variant. A task SHALL be `ended` when no variant has a live session and none is still starting. If a listing fails or the environment is unreachable, the system SHALL NOT mark any session removed.

#### Scenario: Session deleted

- **WHEN** the only session of a task is deleted and its environment's sessions are listed again
- **THEN** the variant records when its session was removed, and the task is listed with state `ended`

#### Scenario: Environment unreachable

- **WHEN** a task environment's container is stopped and its sessions cannot be listed
- **THEN** its variants' sessions are not marked removed and their tasks keep their state

#### Scenario: Session reappears

- **WHEN** a session that was marked removed is listed again
- **THEN** the removal mark is cleared

### Requirement: Picks are recorded on variants

The system SHALL record the time a variant was picked on that variant, and the time of the discard on each other variant of the task. It SHALL keep setting `discarded` in the discarded sessions' metadata.

#### Scenario: Picking a variant

- **WHEN** the user keeps variant 2 of a three-variant task
- **THEN** variant 2 records when it was picked, variants 1 and 3 record when they were discarded, and their sessions' metadata has `discarded` set

#### Scenario: Discard made by an older build

- **WHEN** a session's metadata has `discarded` set and its variant has neither a pick nor a discard recorded
- **THEN** the next reconcile records the variant as discarded

### Requirement: Archiving tasks

The system SHALL let the user archive a task. Archived tasks SHALL be left out of the dashboard snapshot and their rows SHALL be kept. Cleanup SHALL offer to archive ended tasks whose last session activity is older than its idle cutoff.

#### Scenario: Archive an ended task

- **WHEN** the user archives an ended task
- **THEN** the task no longer appears in the project's tasks, and its row records when it was archived

#### Scenario: Archive does not touch sessions

- **WHEN** the user archives a task that still has a live session
- **THEN** the task is hidden, and its session and worktree are left as they are

### Requirement: Backfill from session metadata

The system SHALL bring existing tasks into the database from the sessions each environment lists. A session with `TaskMeta` SHALL create or update its task and variant: the task's creation time is the oldest of its sessions' creation times, and the variant gets its number, branch, model and discard state. Backfill SHALL be idempotent and SHALL run whenever an environment's sessions are reconciled.

#### Scenario: Upgrade with existing tasks

- **WHEN** opendevhub starts for the first time with the database while an environment has two sessions sharing one `TaskMeta.task`
- **THEN** after that environment's first reconcile the database holds one task of kind `task` with variants matching the sessions' variant numbers

#### Scenario: Environment offline at upgrade

- **WHEN** a task environment is unreachable during the first start and comes back later
- **THEN** its sessions are backfilled on its first successful reconcile

#### Scenario: Repeated reconcile

- **WHEN** the same sessions are reconciled again
- **THEN** no duplicate tasks or variants are created

### Requirement: Tasks in the dashboard snapshot

Each project in the dashboard snapshot SHALL list its tasks that are not archived. Each task SHALL have its id, kind, title, Jira source, creation time and state (`starting`, `running` or `ended`). Each variant SHALL have its number, model, agent, node, branch, directory, environment, step, error, session id, and its session-removed, picked and discarded flags.

#### Scenario: Task page reads tasks from the snapshot

- **WHEN** the dashboard shows a task's page
- **THEN** it lists the task's variants from the snapshot's `tasks`, including variants whose session was removed

#### Scenario: Discarded variants

- **WHEN** a task has a discarded variant
- **THEN** the snapshot lists the variant with its discarded flag set, and the session list still hides its session
