import { describe, expect, it, vi } from "vitest";

import type { PersistedState } from "../../../src/server/config";
import { StateStore } from "../../../src/server/projects/state";
import type { Project, SessionSummary } from "../../../src/shared/types";

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

function make(persisted: PersistedState = { projects: {} }) {
  const saved: PersistedState[] = [];
  const store = new StateStore({
    port: 7777,
    persisted,
    persist: (s) => saved.push(structuredClone(s)),
  });
  return { store, saved };
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

  it("persists only durable fields, and only when they change", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.updateRuntime("a", { containerState: "starting" });
    expect(saved).toHaveLength(0);
    store.updateRuntime("a", { containerId: "c1", password: "pw" });
    expect(saved.at(-1)).toEqual({
      projects: {
        a: { containerId: "c1", password: "pw", workspaceFolder: undefined },
      },
    });
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

  it("persists relayToken and never exposes it in snapshots", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.updateRuntime("a", { relayToken: "relay-secret", relay: "active" });
    expect(saved.at(-1)?.projects.a).toMatchObject({
      relayToken: "relay-secret",
    });
    const snap = JSON.stringify(store.snapshot());
    expect(snap).not.toContain("relay-secret");
    expect(store.snapshot().projects[0].runtime.relay).toBe("active");
  });

  it("lists the containers of running main and task environments", () => {
    const { store } = make();
    store.setProjects([p("a"), p("b")]);
    store.putEnvironment({
      id: "env-1",
      projectId: "a",
      worktree: { path: "/w/x", hostPath: "/h/x", branch: "x" },
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
    const { store } = make();
    store.setProjects([p("a")]);
    store.putEnvironment({
      id: "env-1",
      projectId: "a",
      worktree: { path: "/w/x", hostPath: "/h/x", branch: "x" },
    });
    store.setResources({ "env-1": { cpu: 1, memory: 0, memoryLimit: 1 } });
    store.removeEnvironment("env-1");
    expect(store.snapshot().resources).toBeUndefined();
  });
});

describe("task environments", () => {
  const rec = {
    id: "a-feat-0a1b",
    projectId: "a",
    worktree: {
      path: "/w/a.worktrees/feat",
      hostPath: "/src/a.worktrees/feat",
      branch: "feat",
    },
  };

  it("records an environment, persists it with its durable runtime, and restores it", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    store.updateRuntime(rec.id, {
      containerId: "c2",
      password: "pw2",
      containerState: "running",
    });
    expect(saved.at(-1)?.environments?.[rec.id]).toMatchObject({
      projectId: "a",
      worktree: rec.worktree,
      containerId: "c2",
      password: "pw2",
    });
    expect(saved.at(-1)?.projects).not.toHaveProperty(rec.id);
    const restored = make(saved.at(-1)).store;
    restored.setProjects([p("a")]);
    expect(restored.environment(rec.id)).toStrictEqual(rec);
    expect(restored.runtime(rec.id)).toMatchObject({
      projectId: "a",
      containerId: "c2",
      containerState: "stopped",
    });
  });

  it("shows environments in the snapshot without secrets, with their own URL", () => {
    const { store } = make();
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
        image: { key: "k", ref: "r" },
        openUrl: `http://${rec.id}.localhost:7777/`,
      }),
    ]);
    expect(view.environments[0].runtime.containerState).toBe("running");
    expect(view.isolation).toStrictEqual({ default: "isolated" });
  });

  it("lists a project's sessions from all its environments, newest first", () => {
    const { store } = make();
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

  it("forgets an environment, its runtime and its sessions", () => {
    const { store, saved } = make();
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
    expect(saved.at(-1)).not.toHaveProperty("environments");
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
    const store = new StateStore({
      port: 7777,
      persisted: { projects: {} },
      persist: () => {},
    });
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
    const saved: PersistedState[] = [];
    const store = new StateStore({
      port: 7777,
      persisted: { projects: {} },
      persist: (s) => saved.push(structuredClone(s)),
    });
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
      node: "box",
    });
    store.updateRuntime("demo-abc123-fix-1a2b", { containerId: "r1" });
    expect(saved.at(-1)?.environments?.["demo-abc123-fix-1a2b"]).toMatchObject({
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

    const again = new StateStore({
      port: 7777,
      persisted: saved.at(-1)!,
      persist: () => {},
    });
    expect(again.environment("demo-abc123-fix-1a2b")?.node).toBe("box");
  });

  describe("starting tasks", () => {
    const project = {
      id: "demo-abc123",
      name: "demo",
      path: "/src/demo",
      devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
    };
    const setupStore = () => {
      const store = new StateStore({
        port: 7777,
        persisted: { projects: {} },
        persist: () => {},
      });
      store.setProjects([project]);
      store.putStarting(project.id, {
        task: "tsk_1",
        title: "Fix login",
        of: 2,
        createdAt: 5,
        variants: [
          { variant: 1, step: "queued", log: [] },
          { variant: 2, node: "box", step: "queued", log: [] },
        ],
      });
      return store;
    };
    const session = (id: string): SessionSummary => ({
      id,
      projectId: project.id,
      title: "Fix login",
      directory: "/workspaces/demo.worktrees/fix-login",
      status: "running",
      updatedAt: 1,
      pending: { permissions: [], forms: [] },
    });

    it("shows a starting task's variants until their sessions appear", () => {
      const store = setupStore();
      store.updateStarting(project.id, "tsk_1", 1, {
        step: "worktree",
        branch: "fix-login",
      });
      expect(
        store.snapshot().projects[0].starting?.[0].variants[0]
      ).toMatchObject({ step: "worktree", branch: "fix-login" });
      store.updateStarting(project.id, "tsk_1", 1, {
        step: "session",
        sessionId: "ses_1",
      });
      expect(store.snapshot().projects[0].starting?.[0].variants).toHaveLength(
        2
      );
      store.setSessions(project.id, [session("ses_1")]);
      expect(
        store
          .snapshot()
          .projects[0].starting?.[0].variants.map((v) => v.variant)
      ).toStrictEqual([2]);
      store.updateStarting(project.id, "tsk_1", 2, {
        step: "session",
        sessionId: "ses_2",
      });
      store.setSessions(project.id, [session("ses_1"), session("ses_2")]);
      expect(store.snapshot().projects[0].starting).toBeUndefined();
    });

    it("keeps the last 30 log lines of each variant", () => {
      const store = setupStore();
      for (let i = 0; i < 35; i++) {
        store.appendStartingLog(project.id, "tsk_1", 2, `line ${i}`);
      }
      const { log } = store.snapshot().projects[0].starting![0].variants[1];
      expect(log).toHaveLength(30);
      expect(log[0]).toBe("line 5");
      expect(log.at(-1)).toBe("line 34");
    });

    it("dismisses the variants that are done, and the task once none is left", () => {
      const store = setupStore();
      store.updateStarting(project.id, "tsk_1", 1, {
        step: "failed",
        error: "boom",
      });
      expect(store.dismissStarting(project.id, "tsk_1")).toBeTruthy();
      expect(
        store
          .snapshot()
          .projects[0].starting?.[0].variants.map((v) => v.variant)
      ).toStrictEqual([2]);
      store.updateStarting(project.id, "tsk_1", 2, {
        step: "failed",
        error: "unreachable",
      });
      store.dismissStarting(project.id, "tsk_1");
      expect(store.snapshot().projects[0].starting).toBeUndefined();
      expect(store.dismissStarting(project.id, "tsk_1")).toBeFalsy();
    });
  });
});
