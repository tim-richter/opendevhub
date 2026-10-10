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

The system SHALL store a branch's origin URL, published remote, publish time, AGit topic and pull request URL on its branch row. It SHALL read them only from there, and SHALL neither write nor read the `opendevhubOrigin`, `opendevhubPublished`, `opendevhubTopic` or `opendevhubPr` git config keys.

#### Scenario: Publishing records the pull request

- **WHEN** the user publishes a branch and the forge prints a pull request URL
- **THEN** the branch row records the remote, the publish time and the pull request URL, and the publish dialog's "View PR" shows that URL the next time it opens

#### Scenario: AGit publish

- **WHEN** the user publishes with the AGit strategy
- **THEN** the branch row records the topic

#### Scenario: Leftover git config keys

- **WHEN** a checkout has a `branch.feature/x.opendevhubPr` key and no branch row for `feature/x` has a pull request URL
- **THEN** the publish dialog shows no pull request for `feature/x`

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

### Requirement: Branch changes are recorded as events

The system SHALL append an event when a branch row is created, published or deleted, in the same transaction as the change. The event SHALL name the branch, its project and who caused it: the task variant that created it, the user, or opendevhub itself.

#### Scenario: Task creates and user publishes a branch

- **WHEN** variant 2 of a task creates branch `task/add-login-2` and the user later publishes it
- **THEN** the events table holds `branch.created` with actor variant 2 of that task and `branch.published` with actor `user`

#### Scenario: Existing branch is not recreated

- **WHEN** a task creates a worktree on a branch that already has a row
- **THEN** no `branch.created` event is recorded
