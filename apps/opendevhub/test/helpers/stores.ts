import { CheckoutStore } from "../../src/server/db/checkouts";
import { openDatabase } from "../../src/server/db/database";
import { ProjectStore } from "../../src/server/db/projects";
import { TaskStore } from "../../src/server/db/tasks";

/** A fresh in-memory database with its stores. */
export const memoryStores = (now?: () => number) => {
  const db = openDatabase(":memory:");
  return {
    checkouts: new CheckoutStore(db, now),
    db,
    projects: new ProjectStore(db, now),
    tasks: new TaskStore(db, now),
  };
};
