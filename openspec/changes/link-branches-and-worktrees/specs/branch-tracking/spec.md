## ADDED Requirements

### Requirement: Branch records

The system SHALL keep a branch row for every branch it creates, checks out for a pull request, publishes, or finds checked out in a worktree. Each row SHALL be unique per project and branch name, and SHALL record what created the branch: a task variant, a manual action, a pull request checkout, or `unmanaged` when opendevhub did not create it.

#### Scenario: Task variant creates a branch

- **WHEN** variant 2 of a task creates branch `task/add-login-2`
- **THEN** a branch row for `task/add-login-2` records that variant as its creator, and the variant points at that branch row

#### Scenario: Pull request checkout

- **WHEN** the user creates a worktree from pull request `https://forge.example/o/r/pulls/12`
- **THEN** the branch row records creator `pull` and that URL as its origin

#### Scenario: Existing branch keeps its creator

- **WHEN** a task creates a worktree on a branch that already has a row
- **THEN** the row keeps its original creator

### Requirement: Branch facts live in the database

The system SHALL store a branch's origin URL, published remote, publish time, AGit topic and pull request URL on its branch row. It SHALL read them from there, and SHALL NOT write the `opendevhubOrigin`, `opendevhubPublished`, `opendevhubTopic` or `opendevhubPr` git config keys.

#### Scenario: Publishing records the pull request

- **WHEN** the user publishes a branch and the forge prints a pull request URL
- **THEN** the branch row records the remote, the publish time and the pull request URL, and the publish dialog's "View PR" shows that URL the next time it opens

#### Scenario: AGit publish

- **WHEN** the user publishes with the AGit strategy
- **THEN** the branch row records the topic

### Requirement: Base branch stays in git config

The system SHALL keep writing a branch's base to `branch.<name>.opendevhubBase` in git config, and SHALL mirror it on the branch row. Readers inside containers and on nodes depend on the git config value.

#### Scenario: New worktree records its base

- **WHEN** a worktree is created on new branch `feature/x` from `main`
- **THEN** `branch.feature/x.opendevhubBase` is `main` in git config and the branch row's base is `main`

#### Scenario: OpenSpec base check in the container

- **WHEN** the Spec view checks which changes the base branch already has
- **THEN** it reads the base from git config as before

### Requirement: Branches outlive their worktrees

The system SHALL keep a branch row after its worktree is removed. It SHALL mark the row deleted only when opendevhub deletes the branch.

#### Scenario: Worktree removed, branch kept

- **WHEN** the user removes a worktree without deleting its branch
- **THEN** the branch row stays without a deletion mark and keeps its pull request URL

#### Scenario: Branch deleted

- **WHEN** opendevhub deletes a branch while removing a worktree or picking a variant
- **THEN** the branch row records when it was deleted

### Requirement: Picking deletes only the task's own branches

When a pick removes discarded variants' worktrees, the system SHALL delete a worktree's branch only if the branch row was created by a variant of the same task.

#### Scenario: Branch made by the task

- **WHEN** a discarded variant's worktree is on a branch that variant created
- **THEN** the worktree and the branch are removed

#### Scenario: Branch made elsewhere

- **WHEN** a discarded variant's worktree is on a branch with a different creator
- **THEN** the worktree is removed, the branch is kept, and the result says it was not created by this task

### Requirement: Backfill from git config

On the first worktree listing of each project after the upgrade, the system SHALL read every `branch.*.opendevhub*` git config key once. It SHALL fill in the matching branch rows' base, origin, published remote, topic and pull request URL where those are empty. The backfill SHALL run at most once per project.

#### Scenario: Upgrade with a published branch

- **WHEN** a project has `branch.feature/x.opendevhubPr` set before the upgrade
- **THEN** after its first listing the branch row for `feature/x` has that pull request URL

#### Scenario: Backfill runs once

- **WHEN** the project's worktrees are listed again
- **THEN** git config is not read again for backfill
