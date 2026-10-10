import { describe, expect, it, vi } from "vitest";

import { EventStore, eventsSince } from "../../../src/server/db/events";
import { StateStore } from "../../../src/server/projects/state";
import type { Project, SessionSummary } from "../../../src/shared/types";
import {
  memoryStores,
  seed,
  stateStores,
  worktreeRow,
} from "../../helpers/stores";
import type { Seed } from "../../helpers/stores";

const p = (id: string): Project => ({
  id,
  name: id,
  path: `/src/${id}`,
  devcontainerPath: `/src/${id}/.devcontainer.json`,
});
const session: SessionSummary = {
  id: "s1",
  projectId: "a",
  title: "t",
  directory: "/w",
  updatedAt: 1,
  status: "idle",
};

/** A store on a fresh database that knows projects `a` and `b`; `restart` opens another store on the same one. */
function make(data: Seed = {}) {
  const dbs = memoryStores();
  dbs.projects.upsertAll([p("a"), p("b")]);
  seed(dbs, data);
  const open = () => new StateStore({ ...stateStores(dbs), port: 7777 });
  const row = (id: string) => dbs.environments.get(id);
  return { store: open(), restart: open, row, dbs };
}

describe(StateStore, () => {
  it("gives new projects a stopped runtime and restores persisted fields", () => {
    const { store } = make({
      projects: {
        b: { containerId: "c9", password: "pw", workspaceFolder: "/w" },
      },
    });
    store.setProjects([p("a"), p("b")]);
    expect(store.runtime("a")).toStrictEqual({
      projectId: "a",
      containerState: "stopped",
      opencode: "absent",
    });
    expect(store.runtime("b")).toMatchObject({
      containerId: "c9",
      password: "pw",
      workspaceFolder: "/w",
    });
  });

  it("stores only durable fields, and only when they change", () => {
    const { store, row, dbs } = make();
    store.setProjects([p("a")]);
    const write = vi.spyOn(dbs.environments, "updateDurable");
    store.updateRuntime("a", {
      containerState: "starting",
      ports: [],
      opencode: "starting",
    });
    expect(write).not.toHaveBeenCalled();
    store.updateRuntime("a", { containerId: "c1", password: "pw" });
    expect(write).toHaveBeenCalledOnce();
    expect(row("a")?.runtime).toStrictEqual({
      containerId: "c1",
      password: "pw",
    });
    store.updateRuntime("a", { containerId: "c1" });
    expect(write).toHaveBeenCalledOnce();
  });

  it("notifies subscribers on change but not on no-op updates", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.updateRuntime("a", { containerState: "stopped" });
    store.setSessions("a", []);
    expect(fn).not.toHaveBeenCalled();
    store.setSessions("a", [session]);
    store.setSessions("a", [{ ...session }]);
    expect(fn).toHaveBeenCalledOnce();
    off();
    store.updateRuntime("a", { containerState: "running" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("snapshot omits passwords and includes open urls, roots and preflight", () => {
    const { store } = make();
    store.setRoots(["/src"]);
    store.setPreflight({ errors: ["no docker"] });
    store.setProjects([p("a")]);
    store.updateRuntime("a", { password: "secret" });
    const snap = store.snapshot();
    expect(JSON.stringify(snap)).not.toContain("secret");
    expect(snap).toMatchObject({
      roots: ["/src"],
      preflight: { errors: ["no docker"] },
      projects: [
        {
          project: { id: "a" },
          openUrl: "http://a.localhost:7777/",
          sessions: [],
        },
      ],
    });
  });

  it("lists no task environments for a project that has none", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    expect(store.snapshot().projects[0].environments).toStrictEqual([]);
  });

  it("drops projects that disappear from a rescan", () => {
    const { store } = make();
    store.setProjects([p("a"), p("b")]);
    store.setProjects([p("b")]);
    expect(store.snapshot().projects.map((v) => v.project.id)).toStrictEqual([
      "b",
    ]);
  });

  it("stores relayToken and never exposes it in snapshots", () => {
    const { store, row } = make();
    store.setProjects([p("a")]);
    store.updateRuntime("a", { relayToken: "relay-secret", relay: "active" });
    expect(row("a")?.runtime).toMatchObject({
      relayToken: "relay-secret",
    });
    const snap = JSON.stringify(store.snapshot());
    expect(snap).not.toContain("relay-secret");
    expect(store.snapshot().projects[0].runtime.relay).toBe("active");
  });

  it("lists the containers of running main and task environments", () => {
    const { store, dbs } = make();
    store.setProjects([p("a"), p("b")]);
    const worktree = { path: "/w/x", hostPath: "/h/x", branch: "x" };
    store.putEnvironment({
      id: "env-1",
      projectId: "a",
      worktree,
      worktreeId: worktreeRow(dbs, "a", worktree),
    });
    store.updateRuntime("a", { containerState: "running", containerId: "ca" });
    store.updateRuntime("b", { containerState: "stopped", containerId: "cb" });
    store.updateRuntime("env-1", {
      containerState: "running",
      containerId: "ce",
    });
    expect(store.runningContainers()).toStrictEqual([
      { envId: "a", containerId: "ca" },
      { envId: "env-1", containerId: "ce" },
    ]);
  });

  it("puts resources in the snapshot and emits only when they change", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    expect(store.snapshot().resources).toBeUndefined();
    const fn = vi.fn();
    store.subscribe(fn);
    const stats = { a: { cpu: 3, memory: 1024 ** 2, memoryLimit: 1024 ** 3 } };
    store.setResources(stats);
    store.setResources(structuredClone(stats));
    expect(fn).toHaveBeenCalledOnce();
    expect(store.snapshot().resources).toStrictEqual(stats);
    store.setResources({});
    expect(store.snapshot().resources).toBeUndefined();
  });

  it("drops a removed environment's resources", () => {
    const { store, dbs } = make();
    store.setProjects([p("a")]);
    const worktree = { path: "/w/x", hostPath: "/h/x", branch: "x" };
    store.putEnvironment({
      id: "env-1",
      projectId: "a",
      worktree,
      worktreeId: worktreeRow(dbs, "a", worktree),
    });
    store.setResources({ "env-1": { cpu: 1, memory: 0, memoryLimit: 1 } });
    store.removeEnvironment("env-1");
    expect(store.snapshot().resources).toBeUndefined();
  });
});

describe("task environments", () => {
  const worktree = {
    path: "/w/a.worktrees/feat",
    hostPath: "/src/a.worktrees/feat",
    branch: "feat",
  };
  const made = () => {
    const m = make();
    const rec = {
      id: "a-feat-0a1b",
      projectId: "a",
      worktree,
      worktreeId: worktreeRow(m.dbs, "a", worktree),
    };
    return { ...m, rec };
  };

  it("records an environment on its worktree row with its durable runtime, and restores it", () => {
    const { store, row, rec, restart } = made();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    store.updateRuntime(rec.id, {
      containerId: "c2",
      password: "pw2",
      containerState: "running",
    });
    expect(row(rec.id)).toMatchObject({
      kind: "task",
      projectId: "a",
      worktreeId: rec.worktreeId,
      worktree,
      runtime: { containerId: "c2", password: "pw2" },
    });
    const restored = restart();
    restored.setProjects([p("a")]);
    expect(restored.environment(rec.id)).toStrictEqual(rec);
    expect(restored.runtime(rec.id)).toMatchObject({
      projectId: "a",
      containerId: "c2",
      containerState: "stopped",
    });
  });

  it("shows environments in the snapshot without secrets, with their own URL", () => {
    const { store, rec } = made();
    store.setProjects([p("a")]);
    store.putEnvironment({ ...rec, image: { key: "k", ref: "r" } });
    store.updateRuntime(rec.id, {
      password: "secret2",
      containerState: "running",
    });
    store.setIsolation("a", { default: "isolated" });
    const view = store.snapshot().projects[0];
    expect(JSON.stringify(view)).not.toContain("secret2");
    expect(view.environments).toStrictEqual([
      expect.objectContaining({
        id: rec.id,
        worktree: rec.worktree,
        worktreeId: rec.worktreeId,
        image: { key: "k", ref: "r" },
        openUrl: `http://${rec.id}.localhost:7777/`,
      }),
    ]);
    expect(view.environments[0].runtime.containerState).toBe("running");
    expect(view.isolation).toStrictEqual({ default: "isolated" });
  });

  it("lists a project's sessions from all its environments, newest first", () => {
    const { store, rec } = made();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    const s = (id: string, updatedAt: number, envId?: string) => ({
      id,
      projectId: "a",
      title: id,
      directory: "/w",
      updatedAt,
      status: "idle" as const,
      ...(envId ? { envId } : {}),
    });
    store.setSessions("a", [s("main", 1)]);
    store.setSessions(rec.id, [s("task", 2, rec.id)]);
    expect(store.sessionsOf("a").map((x) => x.id)).toStrictEqual([
      "task",
      "main",
    ]);
  });

  it("forgets an environment, its runtime and its sessions, and marks its row removed", () => {
    const { store, row, rec, dbs } = made();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    store.setSessions(rec.id, [
      {
        id: "t",
        projectId: "a",
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    store.removeEnvironment(rec.id);
    expect(store.environments("a")).toStrictEqual([]);
    expect(store.sessionsOf("a")).toStrictEqual([]);
    expect(row(rec.id)?.removedAt).toBeDefined();
    expect(dbs.environments.listLive().map((e) => e.id)).toStrictEqual([
      "a",
      "b",
    ]);
    expect(
      eventsSince(dbs.db)
        .filter((e) => e.object.type === "environment")
        .map((e) => `${e.verb} ${e.object.id}`)
    ).toStrictEqual([
      "environment.created a",
      "environment.created b",
      "environment.created a-feat-0a1b",
      "environment.removed a-feat-0a1b",
    ]);
  });
});

describe("activity", () => {
  it("carries the newest event id, and tells listeners when a task records one", () => {
    const { dbs } = make();
    const store = new StateStore({
      ...stateStores(dbs),
      events: new EventStore(dbs.db),
      port: 7777,
    });
    store.setProjects([p("a")]);
    const before = store.snapshot().activity?.latestId ?? 0;
    expect(before).toBe(eventsSince(dbs.db).at(-1)?.id);
    const heard = vi.fn();
    store.subscribe(heard);
    dbs.tasks.createTask({
      createdAt: 1,
      id: "tsk_1",
      projectId: "a",
      prompt: "x",
      title: "x",
      variants: [{}],
    });
    expect(heard).toHaveBeenCalled();
    expect(store.snapshot().activity?.latestId).toBeGreaterThan(before);
    expect(make().store.snapshot().activity).toBe(undefined);
  });
});

describe("usage", () => {
  const totals = { today: { cost: 1, tokens: 10 }, projects: {}, tasks: {} };

  it("puts usage in the snapshot only once set", () => {
    const { store } = make();
    expect(store.snapshot()).not.toHaveProperty("usage");
    store.setUsage(totals);
    expect(store.snapshot().usage).toStrictEqual(totals);
  });

  it("notifies only when the totals change", () => {
    const { store } = make();
    const fn = vi.fn();
    store.subscribe(fn);
    store.setUsage(totals);
    store.setUsage(structuredClone(totals));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("publishes nodes in the snapshot and skips no-op updates", () => {
    const store = new StateStore({ ...stateStores(), port: 7777 });
    const changes = vi.fn();
    store.subscribe(changes);
    expect(store.snapshot().nodes).toBeUndefined();
    const nodes = [
      { id: "local", label: "This machine", state: "online" as const },
    ];
    store.setNodes(nodes);
    store.setNodes([...nodes]);
    expect(store.snapshot().nodes).toStrictEqual(nodes);
    expect(changes).toHaveBeenCalledOnce();
  });

  it("keeps an environment's node across restarts and lists its worktree as remote", () => {
    const project = {
      id: "demo-abc123",
      name: "demo",
      path: "/src/demo",
      devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
    };
    const dbs = memoryStores();
    dbs.projects.upsertAll([project]);
    const store = new StateStore({ ...stateStores(dbs), port: 7777 });
    store.setProjects([project]);
    store.updateRuntime(project.id, {
      worktrees: [
        {
          path: "/workspaces/demo.worktrees/a",
          hostPath: "/src/demo.worktrees/a",
          branch: "a",
        },
      ],
    });
    const worktree = {
      path: "/workspaces/demo.worktrees/fix",
      hostPath: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees/fix",
      branch: "fix",
    };
    store.putEnvironment({
      id: "demo-abc123-fix-1a2b",
      projectId: project.id,
      worktree,
      worktreeId: worktreeRow(dbs, project.id, worktree, "box"),
      node: "box",
    });
    store.updateRuntime("demo-abc123-fix-1a2b", { containerId: "r1" });
    expect(dbs.environments.get("demo-abc123-fix-1a2b")).toMatchObject({
      node: "box",
      worktree,
    });

    const view = store.snapshot().projects[0];
    expect(view.environments[0].node).toBe("box");
    expect(view.runtime.worktrees).toStrictEqual([
      {
        path: "/workspaces/demo.worktrees/a",
        hostPath: "/src/demo.worktrees/a",
        branch: "a",
      },
      { path: "/workspaces/demo.worktrees/fix", branch: "fix", node: "box" },
    ]);

    const again = new StateStore({ ...stateStores(dbs), port: 7777 });
    expect(again.environment("demo-abc123-fix-1a2b")?.node).toBe("box");
  });

  describe("tasks", () => {
    const project = {
      id: "demo-abc123",
      name: "demo",
      path: "/src/demo",
      devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
    };
    const T1 = "tsk_01JA0000000000000000000001";
    const setupStore = () => {
      const dbs = memoryStores(() => 5);
      dbs.projects.upsertAll([project]);
      const store = new StateStore({ ...stateStores(dbs), port: 7777 });
      store.setProjects([project]);
      dbs.tasks.createTask({
        createdAt: 5,
        id: T1,
        projectId: project.id,
        prompt: "Fix login",
        title: "Fix login",
        variants: [{}, { node: "box" }],
      });
      return { store, tasks: dbs.tasks };
    };
    const session = (id: string): SessionSummary => ({
      id,
      projectId: project.id,
      title: "Fix login",
      directory: "/workspaces/demo.worktrees/fix-login",
      status: "running",
      updatedAt: 1,
    });

    it("lists the project's tasks from the database, and emits when they change", () => {
      const { store, tasks } = setupStore();
      const heard = vi.fn();
      store.subscribe(heard);
      tasks.updateVariant(
        T1,
        1,
        { branch: "fix-login", step: "worktree" },
        { id: `${T1}/1`, type: "variant" }
      );
      expect(heard).toHaveBeenCalledTimes(1);
      const [task] = store.snapshot().projects[0].tasks;
      expect(task).toStrictEqual({
        createdAt: 5,
        id: T1,
        kind: "task",
        state: "starting",
        title: "Fix login",
        variants: [
          { branch: "fix-login", n: 1, step: "worktree" },
          { n: 2, node: "box", step: "queued" },
        ],
      });
    });

    it("gives each session its task and hides discarded variants' sessions", () => {
      const { store, tasks } = setupStore();
      for (const n of [1, 2]) {
        tasks.attachSession(
          T1,
          n,
          { directory: "/w", envId: project.id, sessionId: `ses_${n}` },
          { id: `${T1}/${n}`, type: "variant" }
        );
      }
      store.setSessions(project.id, [session("ses_1"), session("ses_2")]);
      expect(store.sessionsOf(project.id).map((s) => s.task)).toStrictEqual([
        { discarded: false, id: T1, kind: "task", n: 1 },
        { discarded: false, id: T1, kind: "task", n: 2 },
      ]);
      expect(store.taskOf("ses_2")).toBe(T1);
      tasks.pick(T1, 2);
      expect(store.sessionsOf(project.id).map((s) => s.id)).toStrictEqual([
        "ses_2",
      ]);
      expect(
        store.snapshot().projects[0].tasks[0].variants[0].discarded
      ).toBeTruthy();
    });

    it("shows the last 30 setup lines of a variant while it starts", () => {
      const { store, tasks } = setupStore();
      for (let i = 0; i < 35; i++) {
        store.appendStartingLog(T1, 2, `line ${i}`);
      }
      const log = store.snapshot().projects[0].tasks[0].variants[1].log ?? [];
      expect(log).toHaveLength(30);
      expect(log[0]).toBe("line 5");
      expect(log.at(-1)).toBe("line 34");
      tasks.attachSession(
        T1,
        2,
        { directory: "/w", envId: project.id, sessionId: "ses_2" },
        { id: `${T1}/2`, type: "variant" }
      );
      expect(
        store.snapshot().projects[0].tasks[0].variants[1].log
      ).toBeUndefined();
    });

    it("leaves archived tasks out of the snapshot", () => {
      const { store, tasks } = setupStore();
      tasks.archive(T1);
      expect(store.snapshot().projects[0].tasks).toStrictEqual([]);
    });
  });
});
