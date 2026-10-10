## Context

After `persist-tasks`, a variant stores `branch`, `directory` and `env_id` as plain text. Worktrees come from `git worktree list --porcelain` in the main container (`Worktrees.list`), plus remote ones from `state.json` environments that have a `node`. Branch facts live in git config in the container:

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

**Non-Goals:**

- A `pull_requests` table. `pr_url` stays a URL here, and `link-pull-requests-and-tickets` turns it into a foreign key.
- Moving environments out of `state.json` (`persist-environments`).
- Tracking branch renames done outside opendevhub (a renamed branch shows up as a new branch).
- Listing every git branch in the repo. Only branches opendevhub touched or found in a worktree get rows.

## Decisions

### Schema (migration 2)

```sql
CREATE TABLE branches (
  id                  INTEGER PRIMARY KEY,
  project_id          TEXT NOT NULL,
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
  project_id  TEXT NOT NULL,
  branch_id   INTEGER REFERENCES branches (id),   -- NULL on a detached HEAD
  path        TEXT NOT NULL,                      -- inside the container
  host_path   TEXT,
  node_id     TEXT,                               -- NULL = this machine
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER
);
CREATE UNIQUE INDEX worktrees_live ON worktrees (project_id, COALESCE(node_id, ''), path) WHERE removed_at IS NULL;

ALTER TABLE variants ADD COLUMN branch_id   INTEGER REFERENCES branches (id);
ALTER TABLE variants ADD COLUMN worktree_id INTEGER REFERENCES worktrees (id);
```

Both tables use integer ids because the natural keys (name, path) change or get reused. A path that is reused after removal gets a new worktree row, which keeps history accurate.

### The database decides, except for the base

`opendevhubBase` stays in git config because two readers can't reach the hub's database: the shell script that `specs.ts` runs inside the container, and `nodes/repo.ts` on another machine. The branch row's `base` mirrors it, for display and so that a branch keeps its base after its worktree is gone. The other four keys exist only for opendevhub itself, so they move to the database and stop being written. _Alternative considered:_ keep writing all keys (dual write) for rollback. Rejected: `opendevhubPr` is the only one users see after a rollback, and a stale "View PR" link is a smaller cost than keeping two sources of truth indefinitely.

### Reconcile on every listing

`Checkouts.refreshWorktrees` and the env monitor already list worktrees. After each successful listing of a project's checkouts (main container plus remote environments):

1. A path with a live row whose branch is unchanged → nothing to do.
2. A path with a live row whose branch changed → the worktree's `branch_id` points at the (created or found) new branch. Same worktree, different branch.
3. A path without a live row → insert it. If a variant's `directory` matches and that variant has no `worktree_id`, link them (this backfills tasks). Otherwise `created_by = 'unmanaged'` on a new branch row.
4. A live row whose path is missing → `removed_at`.

A failed listing changes nothing, same as session reconcile.

### Creation paths write before git

`Tasks.runTask`, `Checkouts.createWorktree` (`manual`, or `pull` with `origin_url` when it has a PR) and the remote-node path insert the branch and worktree rows right after `git worktree add` succeeds and before the next listing. Branch rows use `INSERT … ON CONFLICT (project_id, name) DO NOTHING`, so an existing branch keeps its original creator.

### Branch deletion on pick

`pickVariant` currently deletes a branch only when `TaskMeta.branch` equals the worktree's branch. That check becomes "the branch row was created by one of this task's variants", and the branch gets `deleted_at`. The existing message "kept — not created by this task" is unchanged.

### Backfill

On each checkout's first listing after migration 2, `git config --get-regexp '^branch\..*\.opendevhub'` (one call, like `origins` today) fills `base`, `origin_url`, `published_remote`, `agit_topic` and `pr_url` for branches that have no values yet. A `created_by` that can't be determined becomes `unmanaged`, or `pull` when an origin URL is set. A per-project `backfilled_at` in a `meta` table stops it from running twice.

## Risks / Trade-offs

- **A rollback shows stale published/PR info** for branches published after the upgrade → documented. The keys are not deleted, so older values stay readable.
- **A path reused by a different branch** is case 2 (same worktree row, new branch) and not a new worktree → acceptable. git itself treats it as the same worktree, and variants still point at their own branch rows.
- **Branches made outside worktrees** (`git checkout -b` in the main checkout) don't get rows → acceptable for now. Publishing one creates its row on demand.

## Migration Plan

Migration 2 adds the tables. Backfill runs on each project's first listing. Rollback: older builds keep using git config. Only published/PR values written after the upgrade are missing there.

## Open Questions

- Should the main checkout get a worktree row (path = workspace folder) so that sessions there point at a worktree too? This change leaves it out. `persist-environments` adds the main environment, which may be the better anchor.
