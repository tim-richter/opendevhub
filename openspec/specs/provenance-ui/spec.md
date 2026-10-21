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

The task, checkout, pull request and ticket pages SHALL show the entity's provenance trail as a breadcrumb whose steps link to their pages. A session step SHALL link to its task's Conversation tab with its variant selected, because sessions have no page of their own. Removed steps SHALL be shown struck through and SHALL NOT be links.

#### Scenario: Task page

- **WHEN** the user opens variant 2 of a task started from `APP-42`
- **THEN** the breadcrumb shows the ticket, the task, the variant and the branch, each linking to its page

#### Scenario: Session step

- **WHEN** a trail includes the session of variant 1 of task `abc`
- **THEN** that step links to `/p/:project/t/abc?v=1`

### Requirement: Task hub page

The task page SHALL show, across its header and tabs:

- in the header: the task's title, kind, state, ticket, status, pull requests and the reviews of them, or, for a review task, its reviews;
- the selected variant's session (Conversation), worktree changes (Changes), terminal and runtime;
- on Compare: each variant with its model, state, cost, tokens, branch, worktree, environment, session and pull request;
- on Spec: the spec chain, linking to the proposing and implementing tasks;
- the task's activity, from its header's Activity button.

For a task with one variant, it SHALL show the same page with no variant switcher and no Compare tab. For a draft, it SHALL show the brief, links and plan instead of the tabs.

#### Scenario: Multi-variant task

- **WHEN** the user opens a task with three variants, one of them published, and switches to Compare
- **THEN** the tab lists the three variants with their branches and sessions, the published one with its pull request

#### Scenario: Spec chain

- **WHEN** the user opens the Spec tab of a task that implements a change another task proposed
- **THEN** the tab links to the proposing task

#### Scenario: Task made from a chat

- **WHEN** the user opens a task made from a chat, with no extra variants
- **THEN** the page shows its single conversation, changes, terminal and runtime, without a variant switcher or Compare tab

### Requirement: Created-by chips

The task, chat, worktree, branch and environment lists SHALL show what created each entry: the task and variant, a chat, a manual action, a pull request checkout, or "created outside opendevhub". Each SHALL link to its origin. A chat adopted from opencode SHALL read "started in opencode". A task made from a chat SHALL read "from chat".

#### Scenario: Worktree list

- **WHEN** the checkouts list shows a worktree made by variant 1 of task "Add login"
- **THEN** its chip reads "Add login · variant 1" and links to the task page

#### Scenario: Chat from opencode

- **WHEN** the chats list shows a chat whose session was created in opencode
- **THEN** its chip reads "started in opencode"

#### Scenario: Worktree made for a chat

- **WHEN** the checkouts list shows a worktree created from the Chat page
- **THEN** its chip names the chat and links to its chat view

### Requirement: Activity views

The dashboard SHALL show the activity across all projects as an Activity section in Settings, not in the sidebar. The project page, the task page and a worktree's page SHALL each have a small Activity button in their header that opens that project's, task's or worktree's activity in a dialog. Each SHALL load older events on demand, and each event SHALL link to the entity it is about.

#### Scenario: Catching up

- **WHEN** the user opens Settings → Activity after being away
- **THEN** it lists what happened since, newest first, for example tasks started, variants failed, branches published, PRs linked and reviews run, each linking to its entity

#### Scenario: One project's activity

- **WHEN** the user clicks the Activity button in a project page's header
- **THEN** a dialog lists that project's events, newest first, and the page itself shows no activity section

#### Scenario: Load more

- **WHEN** the user scrolls to the end of the feed
- **THEN** older events are loaded
