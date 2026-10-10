## ADDED Requirements

### Requirement: Worktree records

The system SHALL keep a worktree row for each linked worktree of a project, on this machine or on a node. The row SHALL have its container path, host path, node, branch, creation time and removal time. A path that is reused after its worktree was removed SHALL get a new row.

#### Scenario: Task creates a worktree

- **WHEN** a task variant creates a worktree
- **THEN** a worktree row exists for its path and branch, and the variant points at it

#### Scenario: Worktree on a node

- **WHEN** a task variant runs on node `builder` in its own worktree
- **THEN** the worktree row records node `builder`

#### Scenario: Path reused

- **WHEN** a worktree is removed and a new worktree is later created at the same path
- **THEN** the old row keeps its removal time and the new worktree gets a new row

### Requirement: Worktrees are reconciled with git

After every successful worktree listing, the system SHALL:

- add a row for each path that has no live row, linking it to a variant whose directory matches and that has no worktree yet, or else marking it unmanaged;
- mark rows whose path is gone as removed;
- point a worktree at its new branch when its checkout switched branches.

A failed listing SHALL change nothing.

#### Scenario: Worktree made outside opendevhub

- **WHEN** the user runs `git worktree add` in the container and the worktrees are listed
- **THEN** the worktree gets a row whose creator is unmanaged

#### Scenario: Worktree removed outside opendevhub

- **WHEN** a worktree's folder is removed and pruned outside opendevhub and the worktrees are listed
- **THEN** its row records when it was removed

#### Scenario: Branch switched in a worktree

- **WHEN** the user checks out another branch in a worktree
- **THEN** after the next listing the worktree row points at that branch's row, and the variant that created the worktree still points at its original branch

#### Scenario: Listing fails

- **WHEN** the container is stopped and the worktree listing fails
- **THEN** no worktree row is added or marked removed

### Requirement: Backfilled tasks link to their worktrees

When reconcile finds a worktree whose path equals the directory of a variant without a worktree, the system SHALL link that variant to the worktree and its branch.

#### Scenario: Task from before the upgrade

- **WHEN** a task created before this change has a variant whose session runs in `/workspaces/.worktrees/add-login-1`
- **THEN** after the first listing that variant points at the worktree row for that path and its branch row

### Requirement: Worktree creators in the dashboard

The snapshot SHALL give each worktree its branch row id and its creator: the task and variant, a manual action, a pull request, or unmanaged. The API SHALL list a project's branches with their base, creator, published remote and pull request URL.

#### Scenario: Checkouts list shows the creator

- **WHEN** the checkouts page lists a worktree a task variant created
- **THEN** it shows the task's title and variant, linking to the task page

#### Scenario: Unmanaged worktree

- **WHEN** the checkouts page lists a worktree created outside opendevhub
- **THEN** it says the worktree was created outside opendevhub

#### Scenario: Branches after their worktree is gone

- **WHEN** the client requests a project's branches
- **THEN** branches whose worktrees were removed are included with their pull request URL
