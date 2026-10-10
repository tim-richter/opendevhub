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

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects (id),
  kind           TEXT NOT NULL CHECK (kind IN ('task', 'manual')),
  title          TEXT NOT NULL,
  prompt         TEXT,
  jira           TEXT,
  spec_first     INTEGER NOT NULL DEFAULT 0,
  proposed_in    TEXT REFERENCES tasks (id),
  implemented_in TEXT REFERENCES tasks (id),
  created_at     INTEGER NOT NULL,
  archived_at    INTEGER
);
CREATE INDEX tasks_project ON tasks (project_id, archived_at);

CREATE TABLE variants (
  task_id            TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  n                  INTEGER NOT NULL,
  model              TEXT,
  agent              TEXT,
  node_id            TEXT,
  env_id             TEXT,
  branch             TEXT,
  directory          TEXT,
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
