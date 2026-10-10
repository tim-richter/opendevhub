import type { DatabaseSync } from "node:sqlite";

/**
 * The schema, one SQL script per version: `MIGRATIONS[i]` takes the database from version i to i + 1. Until the
 * first release there is only migration 1, and each change edits it in place; afterwards, append a new one.
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
