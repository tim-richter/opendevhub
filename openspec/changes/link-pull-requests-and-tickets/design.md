## Context

- **Jira**: a task can start from a ticket (`TaskRequest.jira`: key, instanceUrl, title, description). `persist-tasks` stores that as JSON in `tasks.jira`. The Jira page finds linked tasks by scanning `snapshot.projects[].sessions[].task.jira`.
- **Forgejo**:
  - The PR page can check a PR out into a worktree (`POST …/worktree`), which `link-branches-and-worktrees` records as `branches.created_by = 'pull'` with `origin_url`.
  - The PR page can start an AI review session in a checkout (`POST …/ai-review/session` → `Sessions.startSession` with `aiReviewTitle`), or ask for findings (`POST …/ai-review` → `generateIn`, in that session or in a quick diff-only session).
  - Findings are returned to the dialog and lost afterwards.
- **Publish**: any forge (GitHub, GitLab, Forgejo, …) can print a PR URL on push, which is stored as `branches.pr_url`. Only Forgejo has an API client.

## Goals / Non-Goals

**Goals:**

- PRs and tickets are rows with stable external keys, linked with foreign keys.
- Every way opendevhub touches a PR or ticket records the link: starting a task from a ticket, publishing, checking out a PR, and an AI review.
- Both directions can be looked up cheaply, without scanning sessions.
- AI review findings are kept and can be listed again.

**Non-Goals:**

- Syncing PR or ticket state in the background. Snapshots are refreshed only when the hub fetches them anyway (opening the PR or ticket, listing).
- Linking PRs that opendevhub never touched (pushed by hand) by matching head branch names. See Open Questions.
- API clients for GitHub or GitLab. Their PRs get rows from publish output, keyed by URL, with no snapshot.
- Posting stored findings back to the forge (that's already the review dialog's job).

## Decisions

### Schema (migration 4)

```sql
CREATE TABLE tickets (
  id           INTEGER PRIMARY KEY,
  instance_url TEXT NOT NULL,
  key          TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT,
  status       TEXT,
  fetched_at   INTEGER,
  UNIQUE (instance_url, key)
);

CREATE TABLE pull_requests (
  id          INTEGER PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  forge       TEXT NOT NULL,           -- ForgeKind
  owner       TEXT, repo TEXT, number INTEGER,
  title       TEXT,
  state       TEXT,                    -- open / closed / merged, when known
  head_branch TEXT, base_branch TEXT,
  fetched_at  INTEGER
);

CREATE TABLE reviews (
  id              INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests (id),
  task_id         TEXT REFERENCES tasks (id),     -- the review task, when it ran in one
  session_id      TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('session', 'quick')),
  head_sha        TEXT NOT NULL,
  summary         TEXT,
  findings        TEXT NOT NULL,                  -- JSON AiFinding[]
  created_at      INTEGER NOT NULL
);
CREATE INDEX reviews_pull ON reviews (pull_request_id, created_at);
```

`tasks` is rebuilt to add `ticket_id` and `pull_request_id` (foreign keys) and to widen `kind` to `('task', 'manual', 'review')`. `tasks.jira` stays as the immutable snapshot taken when the task started, because the prompt was built from it. `branches` gets `pull_request_id` and `pr_role CHECK (pr_role IN ('head', 'checkout'))`, and loses `pr_url` and `origin_url` once their values are copied over.

### PR identity is the web URL

Every forge prints a web URL, and Forgejo's API returns one too, so the URL (normalised: no trailing slash, no fragment) is the key. `owner`/`repo`/`number` are filled when the URL can be parsed (`/pulls/<n>`, `/pull/<n>`, `/-/merge_requests/<n>`) or when Forgejo returns them. Without an API client, `state` and `title` stay NULL.

### Ticket identity is (instance, key)

It's the same key the Jira page already uses. The ticket title and status are refreshed whenever the Jira integration fetches the ticket (listing or detail).

### Review tasks

`POST …/ai-review/session` creates a `review` task with `pull_request_id` and one variant whose session is the review session, instead of the manual task `startSession` would make. `POST …/ai-review`:

- with a `sessionId` → the review runs in that session's task;
- quick (no session) → `generateIn` creates a new session, which also becomes a `review` task.

Both paths insert a `reviews` row from `parseAiReview`'s result together with `head_sha` = the `commitId` the request was checked against. A parse failure stores nothing and returns the existing 502.

Commit-message sessions (`generateIn` from publish) stay `manual`. This resolves the open question in `persist-tasks`.

### Lookups

`links.ts` has `forPull(url)` and `forTicket(instance, key)`, each a handful of joins:

- **PR** → branches (`pull_request_id`), their worktrees (live and removed), the variants on those branches and their tasks, reviews, and review tasks.
- **Ticket** → tasks (`ticket_id`) → variants → branches → pull requests.

`TaskView` gets `ticket` and `pullRequests` from the same joins when the snapshot is built. The tables are small, and the snapshot is already rebuilt on each change.

### Backfill (once, after migration 4)

- `tasks.jira` → ticket rows and `ticket_id`.
- `branches.pr_url` → pull request rows, `pr_role = 'head'`. `branches.origin_url` → pull request rows, `pr_role = 'checkout'`.
- A manual task becomes a `review` task when its title matches `AI review: PR #<n> …` **and** one of its variants' worktree is on a branch with `pr_role = 'checkout'` whose PR has number `n`. Quick reviews before this change had no checkout and left no findings, so they stay manual.

## Risks / Trade-offs

- **Findings hold model output about private code** → they're stored in the same 0600 database as everything else and never leave the machine. Findings for a PR that no longer exists are cleared by the cleanup plan in `show-provenance`, not by this change.
- **The PR URL as key breaks if a forge changes URL shape** (for example, a host rename) → a duplicate row instead of a wrong link. Acceptable.
- **Snapshots go stale** (a PR merged while nobody looked) → the UI shows `fetched_at` next to the state, and opening the PR refreshes it.
- **Title-based backfill can misfire** → it requires the checkout branch link too, so a session merely titled like a review isn't converted.

## Migration Plan

Migration 4, then a one-time backfill marked in `meta`. Rollback: older builds ignore the new tables. Review tasks look like manual tasks to them (they read `TaskMeta`, which review sessions don't have), which matches today's behaviour.

## Open Questions

- Should opendevhub link Forgejo PRs it didn't publish, by matching their head branch to a known branch of a project whose remote is that repo? It needs a reliable remote URL → forge repo mapping, which `Publish.forge` partly has. Deferred.
- Should a ticket's status be shown on the task page live (fetch on open) or from the snapshot? This design uses the snapshot plus `fetched_at`.
