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
});
