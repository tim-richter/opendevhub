import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
      "events",
      "projects",
      "tasks",
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
