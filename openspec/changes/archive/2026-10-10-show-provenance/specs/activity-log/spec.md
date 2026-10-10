## ADDED Requirements

### Requirement: Every recorded verb is rendered

The activity views SHALL render every event verb the system records, with a label for its actor and object. Adopted entities SHALL be shown as tracked since their `adopted` event, without earlier history.

#### Scenario: Worktree adopted

- **WHEN** the feed contains a `worktree.adopted` event
- **THEN** it reads as the worktree being found outside opendevhub, by opendevhub, at that time

#### Scenario: New verb without a renderer

- **WHEN** a verb is added to the recorded verbs without a renderer
- **THEN** the test suite fails

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
