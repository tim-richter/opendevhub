## MODIFIED Requirements

### Requirement: Task page tabs

The task page at `/p/:project/t/:task` SHALL be where the user works on a task. It SHALL have these tabs:

- Conversation (the default, at the task's path)
- Changes (`/changes`), labelled with the number of changed files: a simple diff, while the full review is the task's Review page (`/review`)
- Terminal (`/terminal`)
- Runtime (`/runtime`)
- Spec (`/spec`), for a spec-first task
- Checks (`/checks`), listed only below 768px wide; it holds the status rail's content

Compare (`/compare`) SHALL be a view of a task with two or more active variants, opened from the header's Compare variants button rather than from the tab bar. Every tab, Compare excepted, SHALL show the selected variant's worktree or session. Conversations SHALL be listed in the sidebar, not in the tab bar. The task's header (breadcrumb, title, attention pill, actions) SHALL stay visible above the tabs.

#### Scenario: Single-variant task

- **WHEN** the user opens a task with one variant
- **THEN** the page shows the tabs Conversation, Changes, Terminal and Runtime, with no Compare variants button and no variant cards

#### Scenario: Changes of the task

- **WHEN** the user opens the Changes tab of a task whose variant works in worktree `add-login-v1`
- **THEN** the tab lists the files `add-login-v1` changed, shows one file's diff once the user picks it, and links to the task's Review page for publishing

#### Scenario: Spec-first task

- **WHEN** the user opens a task that started with `opsx-propose`
- **THEN** a Spec tab shows the variant's OpenSpec change

#### Scenario: Opening Compare

- **WHEN** the user clicks Compare variants on a two-variant task
- **THEN** the browser opens `/p/:project/t/:task/compare`, and the tab bar has no Compare tab

#### Scenario: Checks tab off phones

- **WHEN** the user opens `/p/x/t/abc/checks` in a 1280px window
- **THEN** the page shows the checks view, though the tab bar lists no Checks tab

### Requirement: Variant switcher

When a task has two or more active variants, which are variants not discarded, the task page SHALL let the user switch between them:

- as variant cards in the sidebar, from 768px wide
- as a segmented control below 768px

Each SHALL name the variant by number and model. The selected variant SHALL be held in the `v` search parameter. Without `v`, the page SHALL select the picked variant, or else the first variant that was not discarded. Switching variants SHALL keep the current tab and clear `thread`. A task with fewer than two active variants SHALL NOT show the switcher.

#### Scenario: Switching variants on Changes

- **WHEN** the user is on `/p/x/t/abc/changes?v=1` and selects variant 2
- **THEN** the URL becomes `/p/x/t/abc/changes?v=2` and the tab shows variant 2's worktree changes

#### Scenario: Default variant

- **WHEN** the user opens a three-variant task where variant 3 was picked, without `v`
- **THEN** variant 3 is selected

#### Scenario: Picked task

- **WHEN** a task had two variants and variant 1 was picked, discarding variant 2
- **THEN** the page shows no switcher
