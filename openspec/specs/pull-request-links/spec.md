# pull-request-links Specification

## Purpose

How opendevhub records the pull requests it publishes, checks out or reviews: rows keyed by their web URL, snapshots refreshed from the forge, links from branches with a head or checkout role, lookups from a pull request, the pages that show them, and the events for new links.

## Requirements

### Requirement: Pull request records

The system SHALL keep a pull request row for every pull request opendevhub publishes, checks out or reviews, keyed by its normalised web URL. The row SHALL record the forge kind and, when the URL or the forge's API provides them, the owner, repository and number. The system SHALL refresh the title, state, head branch and base branch whenever it fetches the pull request from the forge.

#### Scenario: Published to GitHub

- **WHEN** a push to a GitHub remote prints `https://github.com/o/r/pull/7`
- **THEN** a pull request row for that URL has forge `github`, owner `o`, repo `r`, number 7 and no state

#### Scenario: Forgejo details refresh the snapshot

- **WHEN** the user opens a Forgejo pull request that already has a row
- **THEN** its title, state, head branch and base branch are updated along with the time they were fetched

#### Scenario: Same URL twice

- **WHEN** the same pull request URL is recorded from two branches
- **THEN** both branches reference one pull request row

### Requirement: Branches link to pull requests

The system SHALL link a branch to a pull request with the role `head` when the forge prints a pull request URL as opendevhub publishes that branch, and with the role `checkout` when opendevhub creates the branch to check out that pull request.

#### Scenario: Publish prints a PR

- **WHEN** the user publishes branch `task/add-login-2` and the forge prints a pull request URL
- **THEN** that branch references the pull request with role `head`

#### Scenario: Pull request checked out

- **WHEN** the user creates a worktree from Forgejo pull request #12
- **THEN** the new branch references pull request #12 with role `checkout`

#### Scenario: View PR

- **WHEN** the publish dialog opens for a branch linked to a pull request with role `head`
- **THEN** "View PR" links to that pull request's URL

### Requirement: Lookups from a pull request

The system SHALL return, for a pull request URL: the branches linked to it with their roles, those branches' worktrees (live and removed), the tasks and variants that created those branches, and the pull request's review tasks and reviews.

#### Scenario: PR made by a task

- **WHEN** the client looks up a pull request that a task variant's branch was published to
- **THEN** the result has that task and variant, its branch with role `head`, and the branch's worktree

#### Scenario: Unknown PR

- **WHEN** the client looks up a pull request URL with no row
- **THEN** the result is empty, not an error

### Requirement: Pull request page shows its links

The Forgejo pull request page SHALL show the task that made the pull request, the worktrees it is checked out in, and its earlier AI reviews, each linking to its page.

#### Scenario: PR page of a task's PR

- **WHEN** the user opens a pull request that opendevhub published from a task variant
- **THEN** the page shows "Made by task <title>" linking to the task page

#### Scenario: PR checked out locally

- **WHEN** the pull request has a live checkout worktree
- **THEN** the page shows that worktree and links to its checkout

### Requirement: Tasks show their pull requests

Each task in the snapshot SHALL list the pull requests linked to its variants' branches with role `head`, with URL, number, title and state where known.

#### Scenario: Task page

- **WHEN** a task's variant 2 was published as a pull request
- **THEN** the task page shows that pull request next to variant 2

### Requirement: Pull request links are recorded as events

The system SHALL append a `pull_request.linked` event when a branch is linked to a pull request, in the same transaction as the link. The event SHALL record the role and, when a task variant created the branch, that task. Refreshing a pull request's title, state or branches SHALL NOT be recorded as an event.

#### Scenario: Task branch published as a PR

- **WHEN** a task variant's branch is published and linked to a pull request with role `head`
- **THEN** a `pull_request.linked` event with role `head` and that task's id is recorded

#### Scenario: PR snapshot refreshed

- **WHEN** opening a pull request updates its title and state
- **THEN** no event is recorded
