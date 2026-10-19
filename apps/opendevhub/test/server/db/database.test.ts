import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  openDatabase,
  openStateDatabase,
} from "../../../src/server/db/database";
import {
  MIGRATIONS,
  NewerDatabaseError,
  migrate,
  schemaVersion,
} from "../../../src/server/db/migrations";

const tables = (db: ReturnType<typeof openDatabase>) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendevhub-db-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("openDatabase", () => {
  it("creates every table in a fresh in-memory database", () => {
    const db = openDatabase(":memory:");
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toStrictEqual([
      "branches",
      "chats",
      "config_approvals",
      "environments",
      "events",
      "forgejo_filter_presets",
      "jira_filter_presets",
      "project_todos",
      "projects",
      "pull_requests",
      "reviews",
      "task_sessions",
      "tasks",
      "tickets",
      "variants",
      "worktrees",
    ]);
    expect(
      (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys
    ).toBe(1);
  });

  it("creates the state file owner-only, in WAL mode, and reopens it as is", () => {
    const dir = path.join(tempDir(), "state");
    const db = openStateDatabase(dir);
    const file = path.join(dir, "opendevhub.db");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode
    ).toBe("wal");
    db.prepare(
      "INSERT INTO projects (id, path, name, devcontainer_path, first_seen_at) VALUES ('p', '/p', 'p', '/p/d.json', 1)"
    ).run();
    db.close();

    const again = openStateDatabase(dir);
    expect(schemaVersion(again)).toBe(MIGRATIONS.length);
    expect(again.prepare("SELECT id FROM projects").all()).toEqual([
      { id: "p" },
    ]);
    again.close();
  });
});

describe("migrate", () => {
  it("applies only the pending migrations, in order", () => {
    const db = openDatabase(":memory:");
    const more = [
      ...MIGRATIONS,
      "CREATE TABLE extra (id INTEGER PRIMARY KEY)",
      "ALTER TABLE extra ADD COLUMN name TEXT",
    ];
    migrate(db, more);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length + 2);
    expect(tables(db)).toContain("extra");
    // Nothing left to apply: a second run is a no-op.
    migrate(db, more);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length + 2);
  });

  it("rolls back a failing migration and keeps the previous version", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      migrate(db, [
        ...MIGRATIONS,
        "CREATE TABLE half (id INTEGER); SELECT * FROM missing_table",
      ])
    ).toThrow(/missing_table/u);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).not.toContain("half");
  });

  it("refuses a database written by a newer opendevhub", () => {
    const dir = tempDir();
    const db = openStateDatabase(dir);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    expect(() => openStateDatabase(dir)).toThrow(NewerDatabaseError);
    expect(() => openStateDatabase(dir)).toThrow(/newer opendevhub/u);
  });
});

describe("migration 4: reviews may be OCR reviews", () => {
  it("keeps existing reviews and accepts the ocr mode", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 3));
    db.exec(`
      INSERT INTO pull_requests (id, url, forge) VALUES (1, 'https://f.example/o/r/pulls/1', 'forgejo');
      INSERT INTO reviews (id, pull_request_id, session_id, mode, head_sha, summary, findings, created_at)
        VALUES (5, 1, 'ses_1', 'session', 'abc', 'ok', '[]', 10), (6, 1, NULL, 'quick', 'abc', '', '[]', 20);
    `);
    expect(() =>
      db.exec(
        "INSERT INTO reviews (pull_request_id, mode, head_sha, findings, created_at) VALUES (1, 'ocr', 'abc', '[]', 1)"
      )
    ).toThrow(/CHECK/u);
    migrate(db);
    expect(
      db
        .prepare(
          "SELECT id, session_id, mode, summary, stats, created_at FROM reviews ORDER BY id"
        )
        .all()
    ).toEqual([
      {
        created_at: 10,
        id: 5,
        mode: "session",
        session_id: "ses_1",
        stats: null,
        summary: "ok",
      },
      {
        created_at: 20,
        id: 6,
        mode: "quick",
        session_id: null,
        stats: null,
        summary: "",
      },
    ]);
    db.exec(
      "INSERT INTO reviews (pull_request_id, mode, head_sha, findings, stats, created_at) VALUES (1, 'ocr', 'abc', '[]', '{}', 30)"
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reviews'"
        )
        .all()
    ).toEqual([{ name: "reviews_pull" }]);
  });
});

describe("migration 2: manual tasks become chats", () => {
  it("turns each manual task into a chat, keeps other tasks and events, and frees its branch", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 1));
    db.exec(`
      INSERT INTO projects (id, path, name, devcontainer_path, first_seen_at) VALUES ('p', '/src/p', 'p', '/d', 1);
      INSERT INTO tasks (id, project_id, kind, title, created_at) VALUES
        ('tsk_A', 'p', 'manual', 'Found in opencode', 10),
        ('tsk_B', 'p', 'manual', 'Started here', 20),
        ('tsk_C', 'p', 'manual', 'In a worktree', 30),
        ('tsk_T', 'p', 'task', 'A real task', 40);
      UPDATE tasks SET archived_at = 25 WHERE id = 'tsk_B';
      INSERT INTO variants (task_id, n, env_id, directory, branch, step, session_id) VALUES
        ('tsk_A', 1, NULL, '/w', NULL, 'session', 'ses_a'),
        ('tsk_B', 1, NULL, '/w', NULL, 'session', 'ses_b'),
        ('tsk_C', 1, NULL, '/w/x', 'x', 'session', 'ses_c'),
        ('tsk_T', 1, NULL, '/w/t', 't', 'session', 'ses_t');
      UPDATE variants SET session_removed_at = 15 WHERE task_id = 'tsk_A';
      INSERT INTO branches (id, project_id, name, created_by, created_by_task, created_by_variant, created_at)
        VALUES (1, 'p', 'x', 'manual', 'tsk_C', 1, 30);
      INSERT INTO worktrees (id, project_id, branch_id, path, created_by, created_at) VALUES (1, 'p', 1, '/w/x', 'manual', 30);
      INSERT INTO events (at, project_id, actor_type, verb, object_type, object_id, task_id) VALUES
        (10, 'p', 'system', 'session.adopted', 'session', 'ses_a', 'tsk_A'),
        (20, 'p', 'user', 'session.started', 'session', 'ses_b', 'tsk_B');
    `);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(
      db
        .prepare(
          `SELECT id, session_id, origin, title, directory, branch, branch_id, worktree_id, created_at,
           session_removed_at, archived_at FROM chats ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        archived_at: null,
        branch: null,
        branch_id: null,
        created_at: 10,
        directory: "/w",
        id: "c_tsk_A",
        origin: "opencode",
        session_id: "ses_a",
        session_removed_at: 15,
        title: "Found in opencode",
        worktree_id: null,
      },
      {
        archived_at: 25,
        branch: null,
        branch_id: null,
        created_at: 20,
        directory: "/w",
        id: "c_tsk_B",
        origin: "hub",
        session_id: "ses_b",
        session_removed_at: null,
        title: "Started here",
        worktree_id: null,
      },
      {
        archived_at: null,
        branch: "x",
        branch_id: 1,
        created_at: 30,
        directory: "/w/x",
        id: "c_tsk_C",
        origin: "hub",
        session_id: "ses_c",
        session_removed_at: null,
        title: "In a worktree",
        worktree_id: 1,
      },
    ]);
    expect(db.prepare("SELECT id, kind FROM tasks ORDER BY id").all()).toEqual([
      { id: "tsk_T", kind: "task" },
    ]);
    expect(
      db.prepare("SELECT task_id FROM variants ORDER BY task_id").all()
    ).toEqual([{ task_id: "tsk_T" }]);
    expect(
      db
        .prepare(
          "SELECT created_by, created_by_task, created_by_variant FROM branches"
        )
        .get()
    ).toEqual({
      created_by: "manual",
      created_by_task: null,
      created_by_variant: null,
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n
    ).toBe(2);
  });
});
