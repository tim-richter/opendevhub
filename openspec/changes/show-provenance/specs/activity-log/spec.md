## ADDED Requirements

### Requirement: Events are recorded with each change

The system SHALL record an event, in the same transaction, whenever it changes a task, variant, branch, worktree, environment, session record, pull request link, ticket link or review. Each event SHALL have its time, project, actor (`user`, a task variant, or `system`), verb, object type and id, and related task. Runtime-only changes (container state, opencode health, ports) SHALL NOT be recorded.

#### Scenario: Task started

- **WHEN** the user starts a task with two variants
- **THEN** a `task.started` event with actor `user` and one `variant.queued` event per variant are recorded

#### Scenario: Variant fails

- **WHEN** variant 2's worktree cannot be created
- **THEN** a `variant.failed` event is recorded with the error, actor variant 2, and the task id

#### Scenario: Reconcile finds a removed worktree

- **WHEN** reconcile marks a worktree removed
- **THEN** a `worktree.removed` event with actor `system` is recorded

#### Scenario: Failed change leaves no event

- **WHEN** a repository change fails and its transaction rolls back
- **THEN** no event for it is recorded

#### Scenario: Steady state

- **WHEN** reconcile runs and nothing changed
- **THEN** no event is recorded

### Requirement: Adopted entities are not given a made-up history

When the system adopts or backfills an entity, it SHALL record a single `adopted` event dated at the time of adoption, and SHALL NOT invent earlier events.

#### Scenario: Unmanaged worktree adopted

- **WHEN** reconcile adopts a worktree created outside opendevhub
- **THEN** one `worktree.adopted` event with actor `system` is recorded

### Requirement: Activity feed

The system SHALL serve events newest first, 50 per page by default, paginated by event id. They SHALL be filterable by project, by task, or by one entity, where the entity filter matches events about that entity. Every page SHALL include the labels needed to render each event without extra requests.

#### Scenario: Project feed

- **WHEN** the client requests a project's activity
- **THEN** it gets that project's 50 newest events and a cursor for the next page

#### Scenario: Task feed

- **WHEN** the client requests a task's activity
- **THEN** it gets every event of the task, its variants, and its variants' branches, worktrees, environments and sessions

#### Scenario: Next page

- **WHEN** the client requests the page before a cursor
- **THEN** it gets the events older than the cursor, without duplicates

### Requirement: Live updates

The dashboard snapshot SHALL carry the id of the latest event, and SHALL change it whenever an event is recorded.

#### Scenario: Activity view open

- **WHEN** an event is recorded while the activity view is open
- **THEN** the view shows the new event without a reload

### Requirement: Retention

At startup, the system SHALL delete events older than 180 days. Cleanup SHALL offer, unchecked, to delete the stored reviews of pull requests that are closed or merged and whose newest review is older than the session idle cutoff.

#### Scenario: Old events

- **WHEN** opendevhub starts and events older than 180 days exist
- **THEN** they are deleted, and newer events are kept

#### Scenario: Reviews of a merged PR

- **WHEN** the cleanup plan is built and a merged pull request's newest review is older than the idle cutoff
- **THEN** its reviews are offered for deletion, unchecked
