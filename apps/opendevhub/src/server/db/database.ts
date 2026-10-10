import fs from "node:fs";
import path from "node:path";
import type * as NodeSqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrations";

export type Db = DatabaseSync;

const DB_FILE = "opendevhub.db";

let quiet = false;

/**
 * Drops the one-time ExperimentalWarning that loading `node:sqlite` prints, and only that one. Call it before
 * anything imports `node:sqlite`: the warning is emitted when the module first loads.
 */
export const suppressSqliteWarning = (): void => {
  if (quiet) {
    return;
  }
  quiet = true;
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    const type =
      typeof rest[0] === "string"
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type;
    const name = typeof warning === "string" ? type : warning.name;
    if (name === "ExperimentalWarning" && /SQLite/iu.test(text)) {
      return;
    }
    (emit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
};

/** Loaded on first use, so that `suppressSqliteWarning` can run before `node:sqlite` loads. */
const sqlite = (): typeof NodeSqlite => {
  suppressSqliteWarning();
  return process.getBuiltinModule("node:sqlite");
};

/**
 * Opens a database (`:memory:` for tests) with foreign keys on and every migration applied. Throws when the
 * database was written by a newer opendevhub.
 */
export const openDatabase = (file: string): Db => {
  const { DatabaseSync: Database } = sqlite();
  const db = new Database(file);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (file !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
    }
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

/** `opendevhub.db` in the state folder, created owner-only. */
export const openStateDatabase = (stateDir: string): Db => {
  fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
  const file = path.join(stateDir, DB_FILE);
  if (!fs.existsSync(file)) {
    fs.closeSync(fs.openSync(file, "a", 0o600));
  }
  fs.chmodSync(file, 0o600);
  return openDatabase(file);
};

/** Runs `fn` in a transaction: committed when it returns, rolled back when it throws. Not reentrant. */
export const transaction = <T>(db: Db, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
