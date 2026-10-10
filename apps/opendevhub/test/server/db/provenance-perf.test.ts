import { describe, expect, it } from "vitest";

import { page } from "../../../src/server/db/events";
import { ProvenanceStore } from "../../../src/server/db/provenance";
import { memoryStores } from "../../helpers/stores";

const TASKS = 10_000;
/** Generous: a walk is a handful of indexed lookups and takes well under a millisecond. */
const BUDGET_MS = 50;

/** The median of `runs` timings of `fn`, in ms. */
const median = (fn: () => unknown, runs = 21): number => {
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times.toSorted((a, b) => a - b)[Math.floor(runs / 2)];
};

describe("with 10k tasks", () => {
  it("walks provenance and reads the first feed page within budget", () => {
    const { db, projects } = memoryStores();
    projects.upsertAll([
      {
        devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
        id: "demo",
        name: "demo",
        path: "/src/demo",
      },
    ]);
    db.exec("BEGIN");
    const ticket = db.prepare(
      "INSERT INTO tickets (instance_url, key, url) VALUES ('https://jira', ?, ?)"
    );
    const task = db.prepare(
      "INSERT INTO tasks (id, project_id, kind, title, ticket_id, created_at) VALUES (?, 'demo', 'task', ?, ?, ?)"
    );
    const branch = db.prepare(
      `INSERT INTO branches (project_id, name, created_by, created_by_task, created_by_variant, created_at)
       VALUES ('demo', ?, 'variant', ?, 1, ?)`
    );
    const worktree = db.prepare(
      "INSERT INTO worktrees (project_id, branch_id, path, created_by, created_at) VALUES ('demo', ?, ?, 'variant', ?)"
    );
    const variant = db.prepare(
      "INSERT INTO variants (task_id, n, step, session_id) VALUES (?, 1, 'session', ?)"
    );
    const link = db.prepare(
      "UPDATE variants SET branch_id = ?, worktree_id = ? WHERE task_id = ? AND n = 1"
    );
    const event = db.prepare(
      `INSERT INTO events (at, project_id, actor_type, verb, object_type, object_id, task_id)
       VALUES (?, 'demo', 'user', 'task.started', 'task', ?, ?)`
    );
    for (let i = 0; i < TASKS; i += 1) {
      const id = `tsk_${i}`;
      const ticketId = Number(
        ticket.run(`APP-${i}`, `https://jira/browse/APP-${i}`).lastInsertRowid
      );
      task.run(id, `Task ${i}`, ticketId, i);
      variant.run(id, `ses_${i}`);
      const branchId = Number(branch.run(`task/${i}`, id, i).lastInsertRowid);
      const worktreeId = Number(
        worktree.run(branchId, `/w/task-${i}`, i).lastInsertRowid
      );
      link.run(branchId, worktreeId, id);
      event.run(i, id, id);
    }
    db.exec("COMMIT");

    const provenance = new ProvenanceStore(db);
    expect(provenance.of("session", "ses_5000").trail).toHaveLength(6);
    expect(
      median(() => provenance.of("session", `ses_${TASKS - 1}`))
    ).toBeLessThan(BUDGET_MS);
    expect(median(() => provenance.of("worktree", "5000"))).toBeLessThan(
      BUDGET_MS
    );
    expect(median(() => page(db, {}))).toBeLessThan(BUDGET_MS);
    expect(median(() => page(db, { projectId: "demo" }))).toBeLessThan(
      BUDGET_MS
    );
    expect(median(() => page(db, { taskId: "tsk_42" }))).toBeLessThan(
      BUDGET_MS
    );
  });
});
