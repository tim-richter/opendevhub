import { describe, expect, it, vi } from "vitest";

import { USER, eventsSince, variantActor } from "../../../src/server/db/events";
import type { NewTask } from "../../../src/server/db/tasks";
import {
  DraftStartedError,
  RESTART_ERROR,
  TaskStore,
} from "../../../src/server/db/tasks";
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

describe("TaskStore.archiveSession", () => {
  it("keeps a prior conversation owned by its task while hiding it", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.attach(T1, 1, "ses_old");
    s.attach(T1, 1, "ses_new");

    expect(s.tasks.archiveSession("ses_old")).toBe(true);
    expect(s.tasks.isSessionArchived("ses_old")).toBe(true);
    expect(s.tasks.bySession("ses_old")?.task.id).toBe(T1);
    expect(s.tasks.sessionRef("ses_old")?.id).toBe(T1);
    expect(s.tasks.bySession("ses_new")?.task.id).toBe(T1);
    expect(s.tasks.archiveSession("ses_old")).toBe(false);
  });

  it("hides a variant's first conversation too, which has no row of its own yet", () => {
    const s = setup();
    const id = s.tasks.startReview({
      createdAt: 1,
      directory: "/w",
      envId: project.id,
      projectId: project.id,
      reviewOf: s.links.ensurePull("https://forge.example/o/r/pulls/1").id,
      sessionId: "ses_review",
      title: "Review #1",
    });
    expect(s.tasks.archiveSession("ses_review")).toBe(true);
    expect(s.tasks.isSessionArchived("ses_review")).toBe(true);
    expect(s.tasks.get(id)?.variants[0].sessionId).toBe("ses_review");
  });

  it("gives the variant its newest open conversation when its own is closed", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.attach(T1, 1, "ses_a");
    s.attach(T1, 1, "ses_b");
    s.attach(T1, 1, "ses_c");
    expect(s.tasks.archiveSession("ses_c")).toBe(true);
    expect(s.tasks.get(T1)?.variants[0].sessionId).toBe("ses_b");
    expect(s.tasks.bySession("ses_c")?.task.id).toBe(T1);
  });
});

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

  it("takes over a session reconcile adopted as a chat before the variant attached it", () => {
    const s = setup();
    s.tasks.createTask(s.task());
    const stray = s.chats.insert({
      createdAt: 900,
      directory: "/w/ses_1",
      envId: project.id,
      origin: "opencode",
      projectId: project.id,
      sessionId: "ses_1",
      step: "session",
      title: "stray",
    });
    s.attach(T1, 1, "ses_1");
    expect(s.chats.get(stray.id)).toBeUndefined();
    expect(s.chats.hasSession("ses_1")).toBeFalsy();
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

describe("TaskStore review tasks", () => {
  it("starts a review task with one running variant, once per session", () => {
    const s = setup();
    const session = {
      createdAt: 500,
      directory: "/w/feat",
      envId: project.id,
      projectId: project.id,
      reviewOf: s.links.ensurePull("https://forge.example/a/b/pulls/1").id,
      sessionId: "ses_r",
      title: "AI review",
    };
    s.events();
    const id = s.tasks.startReview(session);
    expect(s.tasks.startReview(session)).toBe(id);
    expect(s.tasks.get(id)).toMatchObject({
      createdAt: 500,
      kind: "review",
      state: "running",
      variants: [{ n: 1, sessionId: "ses_r", step: "session" }],
    });
    expect(s.events()).toStrictEqual([
      `task.started ${id} user`,
      "session.started ses_r user",
    ]);
  });
});

describe("TaskStore drafts", () => {
  const plan = {
    variants: [{ agent: "plan" }, {}],
    where: "worktree" as const,
  };

  it("records a draft with its plan and no variants, and starts it by adding variants to the same task", () => {
    const s = setup();
    s.tasks.createTask(s.task({ jira, plan, variants: [] }));
    expect(s.tasks.get(T1)).toMatchObject({
      plan,
      prompt: "Fix the login",
      state: "draft",
      variants: [],
    });
    expect(s.events()).toStrictEqual([
      `task.drafted ${T1} user`,
      "ticket.linked 1 user",
    ]);
    expect(s.tasks.updateDraft(T1, { title: "Login" })).toBeTruthy();
    expect(s.tasks.get(T1)?.title).toBe("Login");
    expect(s.tasks.addVariants(T1, [{ agent: "plan" }, {}])).toStrictEqual([
      1, 2,
    ]);
    const started = s.tasks.get(T1);
    expect(started?.state).toBe("starting");
    expect(started?.plan).toBeUndefined();
    expect(started?.variants.map((v) => [v.n, v.step])).toStrictEqual([
      [1, "queued"],
      [2, "queued"],
    ]);
    expect(s.events()).toStrictEqual([
      `task.started ${T1} user`,
      `variant.added ${T1}/1 user`,
      `variant.added ${T1}/2 user`,
    ]);
    // A started task is no longer a draft to edit.
    expect(s.tasks.updateDraft(T1, { title: "x" })).toBeFalsy();
  });

  it("keeps only the latest pick", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}, {}] }));
    s.tasks.pick(T1, 1);
    s.tasks.addVariants(T1, [{}]);
    s.tasks.pick(T1, 3);
    expect(
      s.tasks.get(T1)?.variants.map((v) => [v.n, !!v.picked, !!v.discarded])
    ).toStrictEqual([
      [1, false, true],
      [2, false, true],
      [3, true, false],
    ]);
  });

  it("starts a draft only once", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [] }));
    expect(s.tasks.addVariants(T1, [{}], USER, { draft: true })).toStrictEqual([
      1,
    ]);
    expect(() => s.tasks.addVariants(T1, [{}], USER, { draft: true })).toThrow(
      DraftStartedError
    );
    expect(s.tasks.get(T1)?.variants).toHaveLength(1);
  });

  it("numbers variants added to a running task after its last", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.attach(T1, 1, "ses_1");
    s.events();
    expect(s.tasks.addVariants(T1, [{}, {}])).toStrictEqual([2, 3]);
    expect(s.events()).toStrictEqual([
      `variant.added ${T1}/2 user`,
      `variant.added ${T1}/3 user`,
    ]);
  });
});

describe("TaskStore.adoptChat", () => {
  const chatIn = (s: ReturnType<typeof setup>) => {
    const wt = s.checkouts.recordCreated(
      project.id,
      { branch: "dark-mode", path: "/w/dark-mode" },
      { by: "manual" },
      variantActor(T1, 1)
    );
    return s.chats.insert({
      branch: "dark-mode",
      branchId: wt.branch.id,
      createdAt: 900,
      directory: "/w/dark-mode",
      envId: project.id,
      origin: "hub",
      projectId: project.id,
      sessionId: "ses_c",
      step: "session",
      title: "Dark mode chat",
      worktreeId: wt.worktree.id,
    });
  };

  it("makes the chat variant 1 of a new task, links the ticket and pull request, and records it once", () => {
    const s = setup();
    const chat = chatIn(s);
    s.events();
    s.tasks.adoptChat({
      chat,
      task: {
        createdAt: 1000,
        id: T2,
        jira,
        model: { id: "opus", providerID: "anthropic" },
        prompt: "Add dark mode",
        pullUrl: "https://forge.example/a/b/pulls/7",
        specFirst: true,
        title: "Dark mode",
      },
    });
    expect(s.tasks.get(T2)).toMatchObject({
      fromChat: chat.id,
      kind: "task",
      prompt: "Add dark mode",
      spec: { first: true },
      state: "running",
      variants: [
        {
          branch: "dark-mode",
          directory: "/w/dark-mode",
          model: { id: "opus", providerID: "anthropic" },
          n: 1,
          sessionId: "ses_c",
          spec: { phase: "propose" },
          step: "session",
        },
      ],
    });
    expect(s.tasks.sessionRef("ses_c")).toMatchObject({ id: T2, n: 1 });
    expect(s.chats.get(chat.id)?.adoptedBy).toStrictEqual({ n: 1, task: T2 });
    expect(s.chats.listForProject(project.id)).toStrictEqual([]);
    expect(s.links.taskLinks(project.id).get(T2)?.pullRequests).toMatchObject([
      { url: "https://forge.example/a/b/pulls/7", variant: 1 },
    ]);
    expect(s.events()).toStrictEqual([
      `task.started ${T2} user`,
      `chat.adopted ${chat.id} user`,
      "ticket.linked 1 user",
      "pull_request.linked 1 user",
    ]);
    expect(() =>
      s.tasks.adoptChat({
        chat,
        task: {
          createdAt: 1000,
          id: "tsk_01JA0000000000000000000003",
          prompt: "",
          specFirst: false,
          title: "Again",
        },
      })
    ).toThrow(/already belongs/u);
    expect(s.tasks.get("tsk_01JA0000000000000000000003")).toBeUndefined();
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

  it("lists archived tasks and restores one to the live list", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.tasks.archive(T1);
    expect(s.tasks.listArchivedForProject(project.id)).toEqual([
      {
        archivedAt: 1000,
        id: T1,
        kind: "task",
        title: "Fix the login",
        variants: 1,
      },
    ]);
    expect(s.tasks.listArchivedForProject("other")).toStrictEqual([]);
    s.events();
    expect(s.tasks.restore(T1)).toBe(true);
    expect(s.tasks.get(T1)?.archivedAt).toBeUndefined();
    expect(
      s.tasks.listForProject(project.id).map((task) => task.id)
    ).toStrictEqual([T1]);
    expect(s.tasks.listArchivedForProject(project.id)).toStrictEqual([]);
    expect(s.events()).toStrictEqual([`task.restored ${T1} user`]);
    expect(s.tasks.restore(T1)).toBe(false);
  });

  it("deletes only an archived task and detaches records that refer to it", () => {
    const s = setup();
    s.tasks.createTask(s.task({ variants: [{}] }));
    s.attach(T1, 1, "ses_1");
    s.tasks.createTask(s.task({ id: T2, variants: [] }));
    s.db.prepare("UPDATE tasks SET proposed_in = ? WHERE id = ?").run(T1, T2);
    s.db
      .prepare(
        "INSERT INTO branches (project_id, name, created_by, created_by_task, created_by_variant, created_at) VALUES (?, ?, 'variant', ?, 1, ?)"
      )
      .run(project.id, "feature", T1, 1000);
    s.db
      .prepare(
        "INSERT INTO chats (id, project_id, origin, title, step, created_at, adopted_task, adopted_variant) VALUES (?, ?, 'hub', ?, 'session', ?, ?, 1)"
      )
      .run("chat_1", project.id, "Old chat", 1000, T1);
    expect(s.tasks.deleteArchived(T1)).toBe(false);
    s.tasks.archive(T1);
    s.events();
    expect(s.tasks.deleteArchived(T1)).toBe(true);
    expect(s.tasks.get(T1)).toBeUndefined();
    expect(s.tasks.sessionRef("ses_1")).toBeUndefined();
    expect(
      s.db.prepare("SELECT proposed_in FROM tasks WHERE id = ?").get(T2)
    ).toEqual({ proposed_in: null });
    expect(
      s.db
        .prepare("SELECT created_by_task FROM branches WHERE name = 'feature'")
        .get()
    ).toEqual({ created_by_task: null });
    expect(
      s.db
        .prepare(
          "SELECT adopted_task, archived_at FROM chats WHERE id = 'chat_1'"
        )
        .get()
    ).toEqual({ adopted_task: null, archived_at: 1000 });
    expect(s.events()).toStrictEqual([`task.deleted ${T1} user`]);
    expect(s.tasks.deleteArchived(T1)).toBe(false);
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
    s.tasks.updateDraft("nope", { title: "x" });
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

describe("task conversation history", () => {
  it("keeps earlier conversations owned by the variant after switching", () => {
    const s = setup();
    s.tasks.createTask(s.task());
    s.attach(T1, 1, "old");
    expect(s.tasks.sessionRef("old")?.id).toBe(T1);
    s.attach(T1, 1, "fresh");
    expect(s.tasks.get(T1)?.variants[0].sessionId).toBe("fresh");
    expect(s.tasks.sessionRef("old")).toEqual(s.tasks.sessionRef("fresh"));
    expect(s.tasks.bySession("old")?.task.id).toBe(T1);
    expect(s.tasks.bySession("fresh")?.variant.n).toBe(1);
    const reopened = new TaskStore(s.db);
    expect(reopened.bySession("old")?.task.id).toBe(T1);
    expect(reopened.sessionRef("old")).toEqual(reopened.sessionRef("fresh"));
  });
});
