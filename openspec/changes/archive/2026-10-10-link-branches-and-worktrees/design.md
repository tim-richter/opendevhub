## Context

After `persist-tasks`, a variant stores `branch`, `directory` and `env_id` as plain text. Worktrees come from `git worktree list --porcelain` in the main container (`Worktrees.list`), plus remote ones from environments that have a `node` (in `state.json` until `persist-environments`). Branch facts live in git config in the container:

| Key | Written by | Read by |
| --- | --- | --- |
| `opendevhubBase` | `Worktrees.recordBase`, `nodes/repo.ts` | `GitOps` (review base), `specs.ts` shell script in the container |
| `opendevhubOrigin` | `Worktrees.add` (PR URL) | `Worktrees.origins` → `Worktree.origin` |
| `opendevhubPublished` | `Publish.publish`, `GitOps` | `GitOps` |
| `opendevhubTopic` | `Publish.publish` (AGit) | — |
| `opendevhubPr` | `Publish.publish` | `Publish.info` → "View PR" |

## Goals / Non-Goals

**Goals:**

- Branches outlive worktrees, and each records what created it and what it was published as.
- Every worktree, managed or not, has a row, and variants point at theirs.
- No behaviour regressions for review base, publish, "View PR" or the in-container spec check.
- Branch and worktree changes are recorded as events.

**Non-Goals:**

- A `pull_requests` table. `pr_url` stays a URL here, and `link-pull-requests-and-tickets` turns it into a foreign key.
- Moving environments out of `state.json` (`persist-environments`).
- Tracking branch renames done outside opendevhub (a renamed branch shows up as a new branch).
- Listing every git branch in the repo. Only branches opendevhub touched or found in a worktree get rows.
- Importing the `branch.*.opendevhub*` keys of existing checkouts. opendevhub has no users yet.

## Decisions

### Schema (added to migration 1)

```sql
CREATE TABLE branches (
  id                  INTEGER PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id),
  name                TEXT NOT NULL,
  base                TEXT,                 -- mirror of opendevhubBase
  created_by          TEXT NOT NULL CHECK (created_by IN ('variant', 'manual', 'pull', 'unmanaged')),
  created_by_task     TEXT,                 -- with created_by_variant: (task_id, n) of variants
  created_by_variant  INTEGER,
  origin_url          TEXT,                 -- PR or ticket URL it was made for
  published_remote    TEXT,
  published_at        INTEGER,
  agit_topic          TEXT,
  pr_url              TEXT,
  created_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  UNIQUE (project_id, name),
  FOREIGN KEY (created_by_task, created_by_variant) REFERENCES variants (task_id, n)
);

CREATE TABLE worktrees (
  id          INTEGER PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id),
  branch_id   INTEGER REFERENCES branches (id),   -- NULL on a detached HEAD
  path        TEXT NOT NULL,                      -- inside the container
  host_path   TEXT,
  node_id     TEXT,                               -- NULL = this machine
  created_by  TEXT NOT NULL CHECK (created_by IN ('variant', 'manual', 'pull', 'unmanaged')),
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER
);
CREATE UNIQUE INDEX worktrees_live ON worktrees (project_id, COALESCE(node_id, ''), path) WHERE removed_at IS NULL;

-- in CREATE TABLE variants:
--   branch_id   INTEGER REFERENCES branches (id),
--   worktree_id INTEGER REFERENCES worktrees (id),
```

`branches` and `worktrees` are created before `variants` in migration 1, and `branches` references `variants` through `created_by_task`/`created_by_variant`. SQLite resolves foreign keys when rows are written, not when tables are created, so the circular reference is fine.

A worktree has its own `created_by` because it can differ from its branch's: `git worktree add` on a branch a task made gives an unmanaged worktree on a variant's branch. The variant that made a worktree is the one whose `worktree_id` points at it.

Both tables use integer ids because the natural keys (name, path) change or get reused. A path that is reused after removal gets a new worktree row, which keeps history accurate.

### The database decides, except for the base

`opendevhubBase` stays in git config because two readers can't reach the hub's database: the shell script that `specs.ts` runs inside the container, and `nodes/repo.ts` on another machine. The branch row's `base` mirrors it, for display and so that a branch keeps its base after its worktree is gone. The other four keys exist only for opendevhub itself, so they move to the database and are neither written nor read. Keys left over in existing checkouts are ignored.

### Reconcile on every listing

`Checkouts.refreshWorktrees` and the env monitor already list worktrees. After each successful listing of a project's checkouts (main container plus remote environments):

1. A path with a live row whose branch is unchanged → nothing to do.
2. A path with a live row whose branch changed → the worktree's `branch_id` points at the (created or found) new branch. Same worktree, different branch.
3. A path without a live row → insert it as unmanaged, with `created_by = 'unmanaged'` on its branch row if the branch has none yet. Worktrees opendevhub creates already have rows by now (see below), so this only happens for worktrees made outside it.
4. A live row whose path is missing → `removed_at`.

A failed listing changes nothing, same as session reconcile.

Reconcile covers one node at a time. This machine's `git worktree list` doesn't show worktrees on nodes, so it only reconciles rows with no `node_id`. A node's worktree row gets `removed_at`, and its branch `deleted_at`, when its environment is destroyed, because that is the only way opendevhub removes one.

A worktree that reconcile adopted just before its creator recorded it (a listing that ran between `git worktree add` and the insert) is claimed by the creator rather than duplicated. Its branch row keeps the creator it already has.

### Events

The checkout repository writes its events in the same transaction as the change, as `persist-tasks` set up: `branch.created`, `branch.published`, `branch.deleted`, `worktree.created`, `worktree.adopted` (unmanaged, found by reconcile), `worktree.switched` (branch changed) and `worktree.removed`. Creation by a task's setup job has actor `variant`, the checkouts page and publish have `user`, and reconcile has `system`.

### Creation paths write before git

`Tasks.runTask`, `Checkouts.createWorktree` (`manual`, or `pull` with `origin_url` when it has a PR) and the remote-node path insert the branch and worktree rows right after `git worktree add` succeeds and before the next listing. Branch rows use `INSERT … ON CONFLICT (project_id, name) DO NOTHING`, so an existing branch keeps its original creator.

### Branch deletion on pick

`pickVariant` currently deletes a branch only when the variant's recorded branch name equals the worktree's branch. That check becomes "the branch row was created by one of this task's variants", and the branch gets `deleted_at`. The existing message "kept — not created by this task" is unchanged.

## Risks / Trade-offs

- **A path reused by a different branch** is case 2 (same worktree row, new branch) and not a new worktree → acceptable. git itself treats it as the same worktree, and variants still point at their own branch rows.
- **Branches made outside worktrees** (`git checkout -b` in the main checkout) don't get rows → acceptable for now. Publishing one creates its row on demand.

## Open Questions

- Should the main checkout get a worktree row (path = workspace folder) so that sessions there point at a worktree too? This change leaves it out. `persist-environments` adds the main environment, which may be the better anchor.
