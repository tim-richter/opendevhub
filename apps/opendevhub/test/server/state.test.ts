import { describe, expect, it, vi } from "vitest";
import type { PersistedState } from "../../src/server/config";
import { StateStore } from "../../src/server/state";
import type { Project, SessionSummary } from "../../src/shared/types";

const p = (id: string): Project => ({ id, name: id, path: `/src/${id}`, devcontainerPath: `/src/${id}/.devcontainer.json` });
const session: SessionSummary = { id: "s1", projectId: "a", title: "t", directory: "/w", updatedAt: 1, status: "idle" };

function make(persisted: PersistedState = { projects: {} }) {
  const saved: PersistedState[] = [];
  const store = new StateStore({ port: 7777, persisted, persist: (s) => saved.push(structuredClone(s)) });
  return { store, saved };
}

describe("StateStore", () => {
  it("gives new projects a stopped runtime and restores persisted fields", () => {
    const { store } = make({ projects: { b: { containerId: "c9", password: "pw", workspaceFolder: "/w" } } });
    store.setProjects([p("a"), p("b")]);
    expect(store.runtime("a")).toEqual({ projectId: "a", containerState: "stopped", opencode: "absent" });
    expect(store.runtime("b")).toMatchObject({ containerId: "c9", password: "pw", workspaceFolder: "/w" });
  });

  it("persists only durable fields, and only when they change", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.updateRuntime("a", { containerState: "starting" });
    expect(saved).toHaveLength(0);
    store.updateRuntime("a", { containerId: "c1", password: "pw" });
    expect(saved.at(-1)).toEqual({ projects: { a: { containerId: "c1", password: "pw", workspaceFolder: undefined } } });
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
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.updateRuntime("a", { containerState: "running" });
    expect(fn).toHaveBeenCalledTimes(1);
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
      projects: [{ project: { id: "a" }, openUrl: "http://a.localhost:7777/", sessions: [] }],
    });
  });

  it("lists no task environments for a project that has none", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    expect(store.snapshot().projects[0].environments).toEqual([]);
  });

  it("drops projects that disappear from a rescan", () => {
    const { store } = make();
    store.setProjects([p("a"), p("b")]);
    store.setProjects([p("b")]);
    expect(store.snapshot().projects.map((v) => v.project.id)).toEqual(["b"]);
  });
  it("persists relayToken and never exposes it in snapshots", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.updateRuntime("a", { relayToken: "relay-secret", relay: "active" });
    expect(saved.at(-1)?.projects.a).toMatchObject({ relayToken: "relay-secret" });
    const snap = JSON.stringify(store.snapshot());
    expect(snap).not.toContain("relay-secret");
    expect(store.snapshot().projects[0].runtime.relay).toBe("active");
  });

  it("lists the containers of running main and task environments", () => {
    const { store } = make();
    store.setProjects([p("a"), p("b")]);
    store.putEnvironment({ id: "env-1", projectId: "a", worktree: { path: "/w/x", hostPath: "/h/x", branch: "x" } });
    store.updateRuntime("a", { containerState: "running", containerId: "ca" });
    store.updateRuntime("b", { containerState: "stopped", containerId: "cb" });
    store.updateRuntime("env-1", { containerState: "running", containerId: "ce" });
    expect(store.runningContainers()).toEqual([
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
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.snapshot().resources).toEqual(stats);
    store.setResources({});
    expect(store.snapshot().resources).toBeUndefined();
  });

  it("drops a removed environment's resources", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    store.putEnvironment({ id: "env-1", projectId: "a", worktree: { path: "/w/x", hostPath: "/h/x", branch: "x" } });
    store.setResources({ "env-1": { cpu: 1, memory: 0, memoryLimit: 1 } });
    store.removeEnvironment("env-1");
    expect(store.snapshot().resources).toBeUndefined();
  });
});

describe("task environments", () => {
  const rec = { id: "a-feat-0a1b", projectId: "a", worktree: { path: "/w/a.worktrees/feat", hostPath: "/src/a.worktrees/feat", branch: "feat" } };

  it("records an environment, persists it with its durable runtime, and restores it", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    store.updateRuntime(rec.id, { containerId: "c2", password: "pw2", containerState: "running" });
    expect(saved.at(-1)?.environments?.[rec.id]).toMatchObject({ projectId: "a", worktree: rec.worktree, containerId: "c2", password: "pw2" });
    expect(saved.at(-1)?.projects).not.toHaveProperty(rec.id);
    const restored = make(saved.at(-1)).store;
    restored.setProjects([p("a")]);
    expect(restored.environment(rec.id)).toEqual(rec);
    expect(restored.runtime(rec.id)).toMatchObject({ projectId: "a", containerId: "c2", containerState: "stopped" });
  });

  it("shows environments in the snapshot without secrets, with their own URL", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    store.putEnvironment({ ...rec, image: { key: "k", ref: "r" } });
    store.updateRuntime(rec.id, { password: "secret2", containerState: "running" });
    store.setIsolation("a", { default: "isolated" });
    const view = store.snapshot().projects[0];
    expect(JSON.stringify(view)).not.toContain("secret2");
    expect(view.environments).toEqual([
      expect.objectContaining({ id: rec.id, worktree: rec.worktree, image: { key: "k", ref: "r" }, openUrl: `http://${rec.id}.localhost:7777/` }),
    ]);
    expect(view.environments[0].runtime.containerState).toBe("running");
    expect(view.isolation).toEqual({ default: "isolated" });
  });

  it("lists a project's sessions from all its environments, newest first", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    const s = (id: string, updatedAt: number, envId?: string) => ({ id, projectId: "a", title: id, directory: "/w", updatedAt, status: "idle" as const, ...(envId ? { envId } : {}) });
    store.setSessions("a", [s("main", 1)]);
    store.setSessions(rec.id, [s("task", 2, rec.id)]);
    expect(store.sessionsOf("a").map((x) => x.id)).toEqual(["task", "main"]);
  });

  it("forgets an environment, its runtime and its sessions", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    store.setSessions(rec.id, [{ id: "t", projectId: "a", title: "t", directory: "/w", updatedAt: 1, status: "idle" }]);
    store.removeEnvironment(rec.id);
    expect(store.environments("a")).toEqual([]);
    expect(store.sessionsOf("a")).toEqual([]);
    expect(saved.at(-1)).not.toHaveProperty("environments");
  });
});

describe("usage", () => {
  const totals = { today: { cost: 1, tokens: 10 }, projects: {}, tasks: {} };

  it("puts usage in the snapshot only once set", () => {
    const { store } = make();
    expect(store.snapshot()).not.toHaveProperty("usage");
    store.setUsage(totals);
    expect(store.snapshot().usage).toEqual(totals);
  });

  it("notifies only when the totals change", () => {
    const { store } = make();
    const fn = vi.fn();
    store.subscribe(fn);
    store.setUsage(totals);
    store.setUsage(structuredClone(totals));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
