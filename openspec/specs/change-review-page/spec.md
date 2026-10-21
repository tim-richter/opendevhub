# change-review-page Specification

## Purpose

The standalone Review page of a task variant's checkout: its URL, how it is reached, and what it holds.

## Requirements

### Requirement: Review page

The task page SHALL have a Review page at `/p/:project/t/:task/review` for the variant selected by `v`, using the same default as the task page. It SHALL show the full review of the variant's checkout:

- every changed file's diff, with the Working, Branch and Turn modes
- line comments
- the AI review and Open Code Review
- publishing (commit, push, pull request) and merging into base

The page SHALL have a header with:

- a link back to the task (keeping `v`)
- the task title
- the variant, when two or more variants are active
- the branch and the branch it compares against

It SHALL NOT show the task's sidebar, tabs or status rail.

#### Scenario: Opening review from the task

- **WHEN** the user clicks Review changes on the Changes tab of `/p/x/t/abc/changes?v=2`
- **THEN** the browser opens `/p/x/t/abc/review?v=2`, showing variant 2's full review with publishing

#### Scenario: Back to the task

- **WHEN** the user clicks the back link on `/p/x/t/abc/review?v=2`
- **THEN** the browser opens `/p/x/t/abc/changes?v=2`

#### Scenario: Worktree removed

- **WHEN** the selected variant's worktree was removed
- **THEN** the Review page says the worktree is gone and links back to the task

### Requirement: Ways into the Review page

These SHALL link to the Review page of the selected variant:

- the Changes tab's Review changes button
- the status rail's Changes section
- the status strip's Review link
- the stepper's Review & checks step when it is current

The task page of an AI review task (a review of a pull request) SHALL link to the Review page of its checkout under the label "Review changes".

#### Scenario: From the stepper

- **WHEN** Review & checks is the current step and the user clicks it
- **THEN** the Review page of the selected variant opens

#### Scenario: From a PR review task

- **WHEN** the user opens the task of an AI review of PR #38 and clicks Review changes
- **THEN** the Review page of that task's checkout opens with the review's findings
