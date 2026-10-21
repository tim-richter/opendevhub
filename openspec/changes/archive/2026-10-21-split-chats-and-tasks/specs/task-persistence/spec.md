## MODIFIED Requirements

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

## ADDED Requirements

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
