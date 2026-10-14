import type { DatabaseSync } from "node:sqlite";

/**
 * The schema, one SQL script per version: `MIGRATIONS[i]` takes the database from version i to i + 1. Append a new
 * one for each change; never edit one that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  devcontainer_path TEXT NOT NULL,
  first_seen_at     INTEGER NOT NULL,
  missing_since     INTEGER
);

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
  forge       TEXT NOT NULL,
  owner       TEXT,
  repo        TEXT,
  number      INTEGER,
  title       TEXT,
  state       TEXT,
  head_branch TEXT,
  base_branch TEXT,
  fetched_at  INTEGER
);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects (id),
  kind            TEXT NOT NULL CHECK (kind IN ('task', 'manual', 'review')),
  title           TEXT NOT NULL,
  prompt          TEXT,
  jira            TEXT,
  ticket_id       INTEGER REFERENCES tickets (id),
  pull_request_id INTEGER REFERENCES pull_requests (id),
  spec_first     INTEGER NOT NULL DEFAULT 0,
  proposed_in    TEXT REFERENCES tasks (id),
  implemented_in TEXT REFERENCES tasks (id),
  created_at     INTEGER NOT NULL,
  archived_at    INTEGER
);
CREATE INDEX tasks_project ON tasks (project_id, archived_at);
CREATE INDEX tasks_ticket ON tasks (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX tasks_pull ON tasks (pull_request_id) WHERE pull_request_id IS NOT NULL;

CREATE TABLE branches (
  id                 INTEGER PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects (id),
  name               TEXT NOT NULL,
  base               TEXT,
  created_by         TEXT NOT NULL CHECK (created_by IN ('variant', 'manual', 'pull', 'unmanaged')),
  created_by_task    TEXT,
  created_by_variant INTEGER,
  published_remote   TEXT,
  published_at       INTEGER,
  agit_topic         TEXT,
  pull_request_id    INTEGER REFERENCES pull_requests (id),
  pr_role            TEXT CHECK (pr_role IN ('head', 'checkout')),
  created_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  UNIQUE (project_id, name),
  FOREIGN KEY (created_by_task, created_by_variant) REFERENCES variants (task_id, n),
  CHECK ((pull_request_id IS NULL) = (pr_role IS NULL))
);
CREATE INDEX branches_pull ON branches (pull_request_id) WHERE pull_request_id IS NOT NULL;

CREATE TABLE worktrees (
  id         INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  branch_id  INTEGER REFERENCES branches (id),
  path       TEXT NOT NULL,
  host_path  TEXT,
  node_id    TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('variant', 'manual', 'pull', 'unmanaged')),
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE UNIQUE INDEX worktrees_live ON worktrees (project_id, COALESCE(node_id, ''), path) WHERE removed_at IS NULL;

CREATE TABLE environments (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (id),
  kind             TEXT NOT NULL CHECK (kind IN ('main', 'task')),
  worktree_id      INTEGER REFERENCES worktrees (id),
  node_id          TEXT,
  container_id     TEXT,
  workspace_folder TEXT,
  remote_user      TEXT,
  image_key        TEXT,
  image_ref        TEXT,
  password         TEXT,
  relay_token      TEXT,
  created_at       INTEGER NOT NULL,
  removed_at       INTEGER,
  CHECK ((kind = 'main') = (worktree_id IS NULL))
);
CREATE INDEX environments_project ON environments (project_id, removed_at);

CREATE TABLE variants (
  task_id            TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  n                  INTEGER NOT NULL,
  model              TEXT,
  agent              TEXT,
  node_id            TEXT,
  env_id             TEXT REFERENCES environments (id),
  branch             TEXT,
  directory          TEXT,
  branch_id          INTEGER REFERENCES branches (id),
  worktree_id        INTEGER REFERENCES worktrees (id),
  step               TEXT NOT NULL,
  error              TEXT,
  session_id         TEXT,
  session_removed_at INTEGER,
  picked_at          INTEGER,
  discarded_at       INTEGER,
  spec_phase         TEXT CHECK (spec_phase IN ('propose', 'implement', 'archived')),
  spec_change        TEXT,
  spec_archived      TEXT,
  PRIMARY KEY (task_id, n)
);
CREATE UNIQUE INDEX variants_session ON variants (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE reviews (
  id              INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests (id),
  task_id         TEXT REFERENCES tasks (id),
  session_id      TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('session', 'quick')),
  head_sha        TEXT NOT NULL,
  summary         TEXT,
  findings        TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX reviews_pull ON reviews (pull_request_id, created_at);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  project_id  TEXT REFERENCES projects (id),
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'variant', 'system')),
  actor_id    TEXT,
  verb        TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  task_id     TEXT,
  data        TEXT
);
CREATE INDEX events_project ON events (project_id, id);
CREATE INDEX events_object  ON events (object_type, object_id, id);
CREATE INDEX events_task    ON events (task_id, id) WHERE task_id IS NOT NULL;

CREATE TABLE forgejo_filter_presets (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  filters    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  `
CREATE TABLE chats (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects (id),
  session_id         TEXT,
  env_id             TEXT REFERENCES environments (id),
  directory          TEXT,
  branch             TEXT,
  branch_id          INTEGER REFERENCES branches (id),
  worktree_id        INTEGER REFERENCES worktrees (id),
  origin             TEXT NOT NULL CHECK (origin IN ('hub', 'opencode', 'internal')),
  title              TEXT NOT NULL,
  step               TEXT NOT NULL,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  session_removed_at INTEGER,
  archived_at        INTEGER,
  adopted_task       TEXT,
  adopted_variant    INTEGER,
  FOREIGN KEY (adopted_task, adopted_variant) REFERENCES variants (task_id, n)
);
CREATE INDEX chats_project ON chats (project_id, archived_at);
CREATE UNIQUE INDEX chats_session ON chats (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX chats_worktree ON chats (worktree_id) WHERE worktree_id IS NOT NULL;

ALTER TABLE tasks ADD COLUMN plan TEXT;

INSERT INTO chats (id, project_id, session_id, env_id, directory, branch, branch_id, worktree_id, origin, title, step,
                   error, created_at, session_removed_at, archived_at)
SELECT 'c_' || t.id, t.project_id, v.session_id, v.env_id, v.directory, v.branch,
  COALESCE(v.branch_id, (SELECT b.id FROM branches b WHERE b.project_id = t.project_id AND b.name = v.branch)),
  COALESCE(v.worktree_id, (SELECT w.id FROM worktrees w WHERE w.project_id = t.project_id AND w.path = v.directory
                           AND w.removed_at IS NULL ORDER BY w.id DESC LIMIT 1)),
  CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.object_type = 'session' AND e.object_id = v.session_id
                    AND e.verb = 'session.adopted') THEN 'opencode' ELSE 'hub' END,
  t.title, v.step, v.error, t.created_at, v.session_removed_at, t.archived_at
FROM tasks t JOIN variants v ON v.task_id = t.id
WHERE t.kind = 'manual';

UPDATE branches SET created_by_task = NULL, created_by_variant = NULL
WHERE created_by_task IN (SELECT id FROM tasks WHERE kind = 'manual');
UPDATE tasks SET proposed_in = NULL WHERE proposed_in IN (SELECT id FROM tasks WHERE kind = 'manual');
UPDATE tasks SET implemented_in = NULL WHERE implemented_in IN (SELECT id FROM tasks WHERE kind = 'manual');
UPDATE reviews SET task_id = NULL WHERE task_id IN (SELECT id FROM tasks WHERE kind = 'manual');
DELETE FROM variants WHERE task_id IN (SELECT id FROM tasks WHERE kind = 'manual');
DELETE FROM tasks WHERE kind = 'manual';
`,
  `
CREATE TABLE jira_filter_presets (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  filters    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  `
CREATE TABLE reviews_new (
  id              INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES pull_requests (id),
  task_id         TEXT REFERENCES tasks (id),
  session_id      TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('session', 'quick', 'ocr')),
  head_sha        TEXT NOT NULL,
  summary         TEXT,
  findings        TEXT NOT NULL,
  stats           TEXT,
  created_at      INTEGER NOT NULL
);
INSERT INTO reviews_new (id, pull_request_id, task_id, session_id, mode, head_sha, summary, findings, created_at)
SELECT id, pull_request_id, task_id, session_id, mode, head_sha, summary, findings, created_at FROM reviews;
DROP TABLE reviews;
ALTER TABLE reviews_new RENAME TO reviews;
CREATE INDEX reviews_pull ON reviews (pull_request_id, created_at);
`,
  `
CREATE TABLE project_todos (
  id         INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  text       TEXT NOT NULL,
  done_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX project_todos_project ON project_todos (project_id, id);
`,
  `
CREATE TABLE task_sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  FOREIGN KEY (task_id, n) REFERENCES variants (task_id, n) ON DELETE CASCADE
);
INSERT INTO task_sessions SELECT session_id, task_id, n FROM variants WHERE session_id IS NOT NULL;
`,
  `
ALTER TABLE task_sessions ADD COLUMN archived_at INTEGER;
`,
  `
ALTER TABLE environments ADD COLUMN personalization TEXT;
`,
];

export class NewerDatabaseError extends Error {
  constructor(version: number, known: number) {
    super(
      `the database was written by a newer opendevhub (schema ${version}, this one knows up to ${known}); upgrade opendevhub`
    );
    this.name = "NewerDatabaseError";
  }
}

export const schemaVersion = (db: DatabaseSync): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;

/** Applies the migrations the database lacks, each in its own transaction. */
export const migrate = (
  db: DatabaseSync,
  migrations: readonly string[] = MIGRATIONS
): void => {
  const version = schemaVersion(db);
  if (version > migrations.length) {
    throw new NewerDatabaseError(version, migrations.length);
  }
  for (const [i, sql] of migrations.entries()) {
    if (i < version) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
};
