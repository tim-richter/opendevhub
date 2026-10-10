## ADDED Requirements

### Requirement: Review tasks

A session the system creates to review a pull request SHALL belong to a task of kind `review` that references the pull request. It SHALL NOT be a manual task. This applies to a review session in a checkout and to a quick review from the diff.

#### Scenario: Review session in a checkout

- **WHEN** the user starts an AI review session for pull request #12 in its checkout
- **THEN** the session belongs to a task of kind `review` that references pull request #12

#### Scenario: Quick review

- **WHEN** the user asks for a quick AI review of pull request #12 without a checkout
- **THEN** the new session belongs to a task of kind `review` that references pull request #12

#### Scenario: Commit message session

- **WHEN** opendevhub generates a commit message in a new session
- **THEN** that session belongs to a manual task

### Requirement: Review runs are stored

Each time AI review findings are generated, the system SHALL store a review with the pull request, the head commit the request was checked against, the session, the review task, the mode (`session` or `quick`), the summary, the findings and the creation time. When the findings cannot be parsed, it SHALL store nothing.

#### Scenario: Findings generated

- **WHEN** the AI review of pull request #12 at commit `abc123` returns a summary and three findings
- **THEN** a review row for #12 at `abc123` holds that summary and those three findings

#### Scenario: Unparseable reply

- **WHEN** the model's reply has no valid findings JSON
- **THEN** the request fails as before and no review is stored

### Requirement: Earlier reviews are listed

The system SHALL list a pull request's stored reviews, newest first. The pull request page SHALL show them with their commit, time, summary and finding count, mark those made against an older head commit as outdated, and let the user open a review's findings in the diff.

#### Scenario: Reopening a PR

- **WHEN** the user opens pull request #12 after an AI review was run on it yesterday
- **THEN** the page lists that review with its summary and finding count

#### Scenario: PR updated since

- **WHEN** pull request #12 has new commits after a review
- **THEN** that review is marked outdated

### Requirement: Review runs are recorded as events

The system SHALL append a `review.run` event, with the review task's id and the pull request, in the same transaction as each stored review.

#### Scenario: Review stored

- **WHEN** a review of pull request #12 is stored
- **THEN** a `review.run` event for that review, with the review task's id, is recorded
