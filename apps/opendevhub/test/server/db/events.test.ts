import { describe, expect, it } from "vitest";

import {
  EVENT_RETENTION_MS,
  EventStore,
  SYSTEM,
  USER,
  eventsSince,
  page,
  prune,
  record,
} from "../../../src/server/db/events";
import type { Project } from "../../../src/shared/types";
import { memoryStores } from "../../helpers/stores";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const other: Project = {
  devcontainerPath: "/src/api/.devcontainer/devcontainer.json",
  id: "api-def456",
  name: "api",
  path: "/src/api",
};
const T1 = "tsk_01JA0000000000000000000001";
const T2 = "tsk_01JA0000000000000000000002";

const setup = () => {
  const clock = { now: 1000 };
  const s = memoryStores(() => clock.now);
  s.projects.upsertAll([project, other]);
  // Only this test's events from here on.
  s.db.exec("DELETE FROM events");
  return { ...s, clock };
};

/** Records `n` worktree events in `projectId`, at 1, 2, … ms. */
const fill = (
  db: ReturnType<typeof setup>["db"],
  n: number,
  projectId = project.id
) => {
  for (let i = 1; i <= n; i += 1) {
    record(db, {
      actor: SYSTEM,
      at: i,
      object: { id: String(i), type: "worktree" },
      projectId,
      verb: "worktree.adopted",
    });
  }
};

describe("page", () => {
  it("pages newest first by id, without gaps or duplicates", () => {
    const { db } = setup();
    fill(db, 7);
    const first = page(db, {}, undefined, 3);
    expect(first.events.map((e) => e.object.id)).toStrictEqual(["7", "6", "5"]);
    expect(first.next).toBe(first.events[2].id);
    // An event recorded between pages doesn't shift the next one.
    record(db, {
      actor: USER,
      at: 99,
      object: { id: "99", type: "worktree" },
      projectId: project.id,
      verb: "worktree.created",
    });
    const second = page(db, {}, first.next, 3);
    expect(second.events.map((e) => e.object.id)).toStrictEqual([
      "4",
      "3",
      "2",
    ]);
    const last = page(db, {}, second.next, 3);
    expect(last.events.map((e) => e.object.id)).toStrictEqual(["1"]);
    expect(last.next).toBe(undefined);
  });

  it("labels each event with its project's name and its task's title", () => {
    const { db, tasks } = setup();
    tasks.createTask({
      createdAt: 1000,
      id: T1,
      projectId: project.id,
      prompt: "Add login",
      title: "Add login",
      variants: [{}],
    });
    const [started] = page(db).events;
    expect(started).toMatchObject({
      object: { id: T1, type: "task" },
      projectId: project.id,
      projectName: "demo",
      taskId: T1,
      taskTitle: "Add login",
      verb: "task.started",
    });
  });

  it("filters by project, by task with its variants' records, and by entity", () => {
    const { db, tasks, checkouts } = setup();
    tasks.createTask({
      createdAt: 1000,
      id: T1,
      projectId: project.id,
      prompt: "a",
      title: "A",
      variants: [{}],
    });
    checkouts.recordCreated(
      project.id,
      { branch: "task/a", path: "/w/task-a" },
      { by: "variant", n: 1, task: T1 },
      USER
    );
    tasks.createTask({
      createdAt: 1000,
      id: T2,
      projectId: other.id,
      prompt: "b",
      title: "B",
      variants: [{}],
    });
    const verbs = (filter: Parameters<typeof page>[1]) =>
      page(db, filter).events.map((e) => `${e.verb} ${e.object.type}`);
    expect(verbs({ projectId: other.id })).toStrictEqual(["task.started task"]);
    expect(verbs({ taskId: T1 })).toStrictEqual([
      "worktree.created worktree",
      "branch.created branch",
      "task.started task",
    ]);
    const branch = checkouts.branch(project.id, "task/a");
    expect(
      verbs({ entity: { id: String(branch?.id), type: "branch" } })
    ).toStrictEqual(["branch.created branch"]);
    expect(
      verbs({ entity: { id: T2, type: "task" }, projectId: project.id })
    ).toStrictEqual([]);
  });
});

describe("prune", () => {
  it("deletes events older than the cutoff in batches and keeps newer ones", () => {
    const { db } = setup();
    fill(db, 25);
    expect(prune(db, 21, 4)).toBe(20);
    expect(eventsSince(db).map((e) => e.at)).toStrictEqual([
      21, 22, 23, 24, 25,
    ]);
    expect(prune(db, 21, 4)).toBe(0);
  });

  it("keeps 180 days of events", () => {
    const { db } = setup();
    const now = EVENT_RETENTION_MS + 10;
    fill(db, 15);
    const store = new EventStore(db, () => now);
    expect(store.pruneOld()).toBe(9);
    expect(store.latestId()).toBe(eventsSince(db).at(-1)?.id);
    expect(eventsSince(db).map((e) => e.at)).toStrictEqual([
      10, 11, 12, 13, 14, 15,
    ]);
  });
});
