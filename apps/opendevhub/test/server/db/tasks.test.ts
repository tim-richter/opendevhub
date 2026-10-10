import { describe, expect, it, vi } from "vitest";

import { eventsSince, variantActor } from "../../../src/server/db/events";
import type { NewTask } from "../../../src/server/db/tasks";
import { RESTART_ERROR } from "../../../src/server/db/tasks";
import type { Project } from "../../../src/shared/types";
import { memoryStores, taskEnvironment } from "../../helpers/stores";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const T1 = "tsk_01JA0000000000000000000001";
const T2 = "tsk_01JA0000000000000000000002";
const jira = {
  description: "Users can't log in",
  instanceUrl: "https://jira.example.com",
  key: "AUTH-1",
  title: "Login fails",
};

const setup = () => {
  const clock = { now: 1000 };
  const s = memoryStores(() => clock.now);
  s.projects.upsertAll([project]);
  const since = { id: 0 };
  /** The events written since the last call, as `<verb> <object> <actor>`. */
  const events = () => {
    const list = eventsSince(s.db, since.id);
    since.id = list.at(-1)?.id ?? since.id;
    return list.map(
      (e) =>
        `${e.verb} ${e.object.id} ${e.actor.type === "variant" ? e.actor.id : e.actor.type}`
    );
  };
  events();
  const task = (over: Partial<NewTask> = {}): NewTask => ({
    createdAt: clock.now,
    id: T1,
    projectId: project.id,
    prompt: "Fix the login",
    title: "Fix the login",
    variants: [
      { model: { id: "opus", providerID: "anthropic" } },
      { agent: "plan" },
      {},
    ],
    ...over,
  });
  const attach = (
    taskId: string,
    n: number,
    sessionId: string,
    envId = project.id
  ) =>
    s.tasks.attachSession(
      taskId,
      n,
      { directory: `/w/${sessionId}`, envId, sessionId },
      variantActor(taskId, n)
    );
  return { ...s, attach, clock, events, task };
};

describe("TaskStore.createTask", () => {
  it("records the task and its queued variants, and a task.started event", () => {
    const s = setup();
    s.tasks.createTask(s.task({ jira }));
    expect(s.tasks.get(T1)).toStrictEqual({
      createdAt: 1000,
      id: T1,
      jira,
      kind: "task",
      projectId: project.id,
      prompt: "Fix the login",
      state: "starting",
      title: "Fix the login",
      variants: [
        {
          model: { id: "opus", providerID: "anthropic" },
          n: 1,
          step: "queued",
        },
        { agent: "plan", n: 2, step: "queued" },
        { n: 3, step: "queued" },
      ],
    });
    expect(s.events()).toStrictEqual([
      `task.started ${T1} user`,
      "ticket.linked 1 user",
    ]);
  });

  it("records a spec-first task and links an implementing task both ways", () => {
    const s = setup();
    s.tasks.createTask(s.task({ spec: { phase: "propose" }, variants: [{}] }));
    s.tasks.createTask(
      s.task({
        id: T2,
        spec: { change: "add-login", phase: "implement", proposedIn: T1 },
        variants: [{}, {}],
      })
    );
    expect(s.tasks.get(T1)?.spec).toStrictEqual({
      first: true,
      implementedIn: T2,
    });
    expect(s.tasks.get(T1)?.variants[0].spec).toStrictEqual({
      phase: "propose",
    });
    const implementing = s.tasks.get(T2);
    expect(implementing?.spec).toStrictEqual({ first: false, proposedIn: T1 });
    expect(implementing?.variants.map((v) => v.spec)).toStrictEqual([
      { change: "add-login", phase: "implement" },
      { change: "add-login", phase: "implement" },
    ]);
  });

  it("leaves out a proposing task that doesn't exist", () => {
    const s = setup();
    s.tasks.createTask(
      s.task({
        spec: { change: "x", phase: "implement", proposedIn: T2 },
        variants: [{}],
      })
    );
    expect(s.tasks.get(T1)?.spec).toBeUndefined();
  });
});

describe("TaskStore variants", () => {
  it("records each step, and a failure once with its error", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}, {}] }));
    taskEnvironment(s, project.id, "env-1");
    s.events();
    const actor = variantActor(T1, 1);
    s.tasks.updateVariant(
      T1,
      1,
      { branch: "fix-login", step: "worktree" },
      actor
    );
    s.tasks.updateVariant(
      T1,
      1,
      { directory: "/w/fix-login", envId: "env-1" },
      actor
    );
    s.tasks.updateVariant(
      T1,
      2,
      { error: "boom", step: "failed" },
      variantActor(T1, 2)
    );
    s.tasks.updateVariant(
      T1,
      2,
      { error: "boom", step: "failed" },
      variantActor(T1, 2)
    );
    expect(s.tasks.get(T1)?.variants).toStrictEqual([
      {
        branch: "fix-login",
        directory: "/w/fix-login",
        envId: "env-1",
        n: 1,
        step: "worktree",
      },
      { error: "boom", n: 2, step: "failed" },
    ]);
    expect(s.events()).toStrictEqual([`variant.failed ${T1}/2 ${T1}/2`]);
  });

  it("attaches a session, and the session then refers to its task", () => {
    const s = setup();
    s.tasks.createTask(s.task());
    s.events();
    s.tasks.updateVariant(T1, 2, { step: "session" }, variantActor(T1, 2));
    expect(s.tasks.get(T1)?.state).toBe("starting");
    expect(s.tasks.sessionRef("ses_2")).toBeUndefined();
    s.attach(T1, 2, "ses_2");
    expect(s.tasks.sessionRef("ses_2")).toStrictEqual({
      discarded: false,
      id: T1,
      kind: "task",
      n: 2,
    });
    expect(s.tasks.bySession("ses_2")?.variant).toStrictEqual({
      agent: "plan",
      directory: "/w/ses_2",
      envId: project.id,
      n: 2,
      sessionId: "ses_2",
      step: "session",
    });
    expect(s.events()).toStrictEqual([`session.started ses_2 ${T1}/2`]);
  });

  it("keeps one task per session: the unique index refuses a second variant", () => {
    const s = setup();
    s.tasks.createTask(s.task());
    s.attach(T1, 1, "ses_1");
    expect(() => s.attach(T1, 2, "ses_1")).toThrow(/UNIQUE/u);
    expect(s.tasks.bySession("ses_1")?.variant.n).toBe(1);
  });

  it("takes over a session reconcile adopted before the variant attached it", () => {
    const s = setup();
    s.tasks.createTask(s.task());
    const manual = s.tasks.adoptSession({
      createdAt: 900,
      directory: "/w/ses_1",
      envId: project.id,
      projectId: project.id,
      sessionId: "ses_1",
      title: "stray",
    });
    s.attach(T1, 1, "ses_1");
    expect(s.tasks.get(manual)).toBeUndefined();
    expect(s.tasks.sessionRef("ses_1")?.id).toBe(T1);
  });

  it("records spec phases, changes and archive folders", () => {
    const s = setup();
    s.tasks.createTask(s.task({ spec: { phase: "propose" }, variants: [{}] }));
    s.tasks.setSpec(T1, 1, { change: "add-login" });
    s.tasks.setSpec(T1, 1, { phase: "implement" });
    expect(s.tasks.get(T1)?.variants[0].spec).toStrictEqual({
      change: "add-login",
      phase: "implement",
    });
    s.tasks.setSpec(T1, 1, {
      archived: "2026-10-10-add-login",
      phase: "archived",
    });
    expect(s.tasks.get(T1)?.variants[0].spec).toStrictEqual({
      archived: "2026-10-10-add-login",
      change: "add-login",
      phase: "archived",
    });
  });
});

describe("TaskStore manual tasks", () => {
  const session = {
    branch: "feat",
    createdAt: 500,
    directory: "/w/feat",
    envId: project.id,
    projectId: project.id,
    sessionId: "ses_m",
    title: "New session",
  };

  it("starts a manual task with one running variant", () => {
    const s = setup();
    const id = s.tasks.startManual(session);
    expect(s.tasks.get(id)).toMatchObject({
      createdAt: 500,
      kind: "manual",
      state: "running",
      title: "New session",
      variants: [
        {
          branch: "feat",
          directory: "/w/feat",
          envId: project.id,
          n: 1,
          sessionId: "ses_m",
          step: "session",
        },
      ],
    });
    expect(id).toMatch(/^tsk_/u);
    expect(s.events()).toStrictEqual([
      `task.started ${id} user`,
      "session.started ses_m user",
    ]);
  });

  it("adopts a session once, however often it is asked", () => {
    const s = setup();
    const id = s.tasks.adoptSession(session);
    expect(s.tasks.adoptSession(session)).toBe(id);
    expect(s.tasks.startManual(session)).toBe(id);
    expect(s.tasks.listForProject(project.id)).toHaveLength(1);
    expect(s.events()).toStrictEqual([
      `task.started ${id} system`,
      "session.adopted ses_m system",
    ]);
  });

  it("lets only a manual task's title follow its session", () => {
    const s = setup();
    const id = s.tasks.startManual(session);
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.attach(T1, 1, "ses_t");
    s.tasks.setManualTitle("ses_m", "Fix the flaky test");
    s.tasks.setManualTitle("ses_t", "Renamed by opencode");
    expect(s.tasks.get(id)?.title).toBe("Fix the flaky test");
    expect(s.tasks.get(T1)?.title).toBe("Fix the login");
  });
});

describe("TaskStore.markSessionsGone", () => {
  it("marks sessions the listing lacks, ends the task, and is quiet in a steady state", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}, {}] }));
    s.attach(T1, 1, "ses_1");
    taskEnvironment(s, project.id, "env-2");
    s.attach(T1, 2, "ses_2", "env-2");
    s.events();
    s.tasks.markSessionsGone(project.id, new Set(["other"]));
    expect(s.tasks.get(T1)?.variants[0].sessionRemoved).toBeTruthy();
    expect(s.tasks.get(T1)?.state).toBe("running");
    // Another environment's listing leaves this one's variants alone.
    s.tasks.markSessionsGone("env-3", new Set());
    s.tasks.markSessionsGone("env-2", new Set());
    expect(s.tasks.get(T1)?.state).toBe("ended");
    expect(s.events()).toStrictEqual([
      "session.removed ses_1 system",
      "session.removed ses_2 system",
      `task.ended ${T1} system`,
    ]);
    s.tasks.markSessionsGone(project.id, new Set());
    s.tasks.markSessionsGone("env-2", new Set());
    expect(s.events()).toStrictEqual([]);
  });

  it("clears the mark when the session is listed again", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.attach(T1, 1, "ses_1");
    s.tasks.markSessionsGone(project.id, new Set());
    s.tasks.markSessionsGone(project.id, new Set(["ses_1"]));
    expect(s.tasks.get(T1)?.variants[0].sessionRemoved).toBeUndefined();
    expect(s.tasks.get(T1)?.state).toBe("running");
    expect(s.tasks.liveSessionsIn(project.id)).toStrictEqual(["ses_1"]);
  });
});

describe("TaskStore picks, dismissals and archiving", () => {
  it("records the pick on the kept variant and the discard on the others", () => {
    const s = setup();
    s.tasks.createTask(s.task());
    s.attach(T1, 1, "ses_1");
    s.attach(T1, 2, "ses_2");
    s.attach(T1, 3, "ses_3");
    s.events();
    s.tasks.pick(T1, 2);
    expect(
      s.tasks.get(T1)?.variants.map((v) => [v.n, v.picked, v.discarded])
    ).toStrictEqual([
      [1, undefined, true],
      [2, true, undefined],
      [3, undefined, true],
    ]);
    expect(s.tasks.sessionRef("ses_1")?.discarded).toBeTruthy();
    expect(s.events()).toStrictEqual([
      `variant.discarded ${T1}/1 user`,
      `variant.picked ${T1}/2 user`,
      `variant.discarded ${T1}/3 user`,
    ]);
  });

  it("dismisses failed starts by discarding them, keeping the task", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}, {}] }));
    s.attach(T1, 1, "ses_1");
    s.tasks.updateVariant(
      T1,
      2,
      { error: "no", step: "failed" },
      variantActor(T1, 2)
    );
    expect(s.tasks.get(T1)?.state).toBe("starting");
    s.events();
    expect(s.tasks.dismissStarting(T1)).toBeTruthy();
    expect(s.tasks.get(T1)?.state).toBe("running");
    expect(s.tasks.get(T1)?.variants[1].discarded).toBeTruthy();
    expect(s.events()).toStrictEqual([`variant.discarded ${T1}/2 user`]);
    expect(s.tasks.dismissStarting(T2)).toBeFalsy();
  });

  it("ends a task once its only failed start is dismissed", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.tasks.updateVariant(
      T1,
      1,
      { error: "no", step: "failed" },
      variantActor(T1, 1)
    );
    s.events();
    s.tasks.dismissStarting(T1);
    expect(s.tasks.get(T1)?.state).toBe("ended");
    expect(s.events()).toStrictEqual([
      `variant.discarded ${T1}/1 user`,
      `task.ended ${T1} user`,
    ]);
  });

  it("archives a task: gone from the list, kept as a row", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.attach(T1, 1, "ses_1");
    s.clock.now = 5000;
    s.events();
    expect(s.tasks.archive(T1)).toBeTruthy();
    expect(s.tasks.archive(T1)).toBeTruthy();
    expect(s.tasks.listForProject(project.id)).toStrictEqual([]);
    expect(s.tasks.get(T1)?.archivedAt).toBe(5000);
    expect(s.tasks.lastActivity(T1)).toBe(5000);
    expect(s.events()).toStrictEqual([`task.archived ${T1} user`]);
    expect(s.tasks.archive(T2)).toBeFalsy();
  });
});

describe("TaskStore lifecycle", () => {
  it("fails the variants a restart interrupted, and only those", () => {
    const s = setup();
    s.tasks.createTask(s.task());
    s.tasks.updateVariant(T1, 1, { step: "container" }, variantActor(T1, 1));
    s.tasks.updateVariant(T1, 2, { step: "session" }, variantActor(T1, 2));
    s.attach(T1, 3, "ses_3");
    s.events();
    expect(s.tasks.failInterrupted()).toBe(2);
    expect(
      s.tasks.get(T1)?.variants.map((v) => [v.step, v.error])
    ).toStrictEqual([
      ["failed", RESTART_ERROR],
      ["failed", RESTART_ERROR],
      ["session", undefined],
    ]);
    expect(s.events()).toStrictEqual([
      `variant.failed ${T1}/1 system`,
      `variant.failed ${T1}/2 system`,
    ]);
    expect(s.tasks.failInterrupted()).toBe(0);
  });

  it("lists a project's tasks oldest first with their state", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.clock.now = 2000;
    s.tasks.createTask(s.task({ createdAt: 2000, id: T2, variants: [{}] }));
    s.attach(T2, 1, "ses_2");
    expect(
      s.tasks.listForProject(project.id).map((t) => [t.id, t.state])
    ).toStrictEqual([
      [T1, "starting"],
      [T2, "running"],
    ]);
    expect(s.tasks.listForProject("other")).toStrictEqual([]);
  });

  it("tells subscribers about changes, not about no-ops", () => {
    const s = setup();
    const heard = vi.fn();
    s.tasks.subscribe(heard);
    s.tasks.createTask(s.task({ variants: [{}] }));
    expect(heard).toHaveBeenCalledTimes(1);
    s.tasks.updateVariant(T1, 1, {}, variantActor(T1, 1));
    s.tasks.setManualTitle("nope", "x");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("TaskStore claims", () => {
  it("claims a directory per environment until every claim is released", () => {
    const s = setup();
    const a = s.tasks.claim("env-1", "/w/a");
    const b = s.tasks.claim("env-1", "/w/a");
    expect(s.tasks.isClaimed("env-1", "/w/a")).toBeTruthy();
    expect(s.tasks.isClaimed("env-2", "/w/a")).toBeFalsy();
    a();
    a();
    expect(s.tasks.isClaimed("env-1", "/w/a")).toBeTruthy();
    b();
    expect(s.tasks.isClaimed("env-1", "/w/a")).toBeFalsy();
  });
});
