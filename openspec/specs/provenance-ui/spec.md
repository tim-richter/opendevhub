# provenance-ui Specification

## Purpose

How opendevhub shows where each entity came from and what it led to: provenance trails computed from the stored links, breadcrumbs on entity pages, the task page as the hub for a piece of work, created-by chips in lists, and the activity views.

## Requirements

### Requirement: Provenance trail

For any task, variant, branch, worktree, environment, session, pull request, ticket or review, the system SHALL return its trail of origins, ordered from the outermost origin to the entity itself. It SHALL also return the entities it led to: pull requests and reviews. Each step SHALL have a type, id, label and link, and SHALL be flagged when the entity was removed. The trail SHALL be computed from the stored links, not stored separately.

#### Scenario: Session of a ticket task

- **WHEN** the client asks for the trail of a session of variant 2 of a task started from `APP-42`, running in its own container
- **THEN** the trail is ticket `APP-42`, the task, variant 2, its branch, its worktree, its environment, then the session, and the pull request it led to is listed

#### Scenario: Removed worktree

- **WHEN** a variant's worktree was removed
- **THEN** the trail still includes the worktree, flagged as removed

#### Scenario: Unmanaged worktree

- **WHEN** the client asks for the trail of a worktree created outside opendevhub
- **THEN** the trail has only the project and the worktree, and the worktree is marked as created outside opendevhub

### Requirement: Breadcrumb on entity pages

The session, task, checkout, pull request and ticket pages SHALL show the entity's provenance trail as a breadcrumb whose steps link to their pages. Removed steps SHALL be shown struck through and SHALL NOT be links.

#### Scenario: Session page

- **WHEN** the user opens a session of a task variant
- **THEN** the breadcrumb shows the ticket (if any), the task, the variant and the branch, each linking to its page

### Requirement: Task hub page

The task page SHALL show, in one place:

- the task's title, kind, state, ticket and status;
- each variant with its model, state, cost, tokens, branch, worktree, environment, session and pull request;
- the reviews of the task's pull requests, or, for a review task, its reviews;
- the spec chain, linking to the proposing and implementing tasks;
- the task's activity.

For a manual task, it SHALL show the same page with its single variant and no variant comparison.

#### Scenario: Multi-variant task

- **WHEN** the user opens a task with three variants, one of them published
- **THEN** the page lists the three variants with their branches and sessions, the published one with its pull request, and the task's activity

#### Scenario: Spec chain

- **WHEN** the user opens a task that implements a change another task proposed
- **THEN** the page links to the proposing task

#### Scenario: Manual task

- **WHEN** the user opens a manual task
- **THEN** the page shows its single session, branch and worktree, without the comparison tab

### Requirement: Created-by chips

The session, worktree, branch and environment lists SHALL show what created each entry: the task and variant, a manual action, a pull request checkout, or "created outside opendevhub". Each SHALL link to its origin.

#### Scenario: Worktree list

- **WHEN** the checkouts list shows a worktree made by variant 1 of task "Add login"
- **THEN** its chip reads "Add login · variant 1" and links to the task page

### Requirement: Activity views

The dashboard SHALL have an activity page across all projects, an activity section on each project page, and the task's activity on the task page. Each SHALL load older events on demand, and each event SHALL link to the entity it is about.

#### Scenario: Catching up

- **WHEN** the user opens the activity page after being away
- **THEN** it lists what happened since, newest first, for example tasks started, variants failed, branches published, PRs linked and reviews run, each linking to its entity

#### Scenario: Load more

- **WHEN** the user scrolls to the end of the feed
- **THEN** older events are loaded
