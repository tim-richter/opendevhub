import { describe, expect, it, vi } from "vitest";
import type { PersistedState } from "../../src/server/config";
import { CommandError, type ContainerInfo } from "../../src/server/containers";
import type { MonitorOptions } from "../../src/server/monitor";
import type { OpencodeClient } from "../../src/server/opencode/client";
import { BusyError, NotFoundError, Orchestrator } from "../../src/server/orchestrator";
import { StateStore } from "../../src/server/state";
import type { PortSpec } from "../../src/server/ports";
import type { ForwardedPort } from "../../src/shared/types";
import type { Project } from "../../src/shared/types";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};
const running: ContainerInfo = { id: "c1", running: true, ip: "172.17.0.9", projectId: project.id };

function setup(persisted: PersistedState = { projects: {} }) {
  const store = new StateStore({ port: 7777, persisted, persist: () => {} });
  const monitors: Array<{ opts: MonitorOptions; started: boolean; stopped: boolean }> = [];
  const containers = {
    up: vi.fn(async (_p: Project, o: { rebuild: boolean; onLine: (l: string) => void }) => {
      o.onLine("building image");
      return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo" };
    }),
    inspect: vi.fn(async (_id?: string): Promise<ContainerInfo | undefined> => running),
    listManaged: vi.fn(async (): Promise<ContainerInfo[]> => []),
    stop: vi.fn(async () => {}),
    readConfiguration: vi.fn(async (_p?: Project) => ({
      forwardPorts: [3000, "db:5432"] as unknown[],
      portsAttributes: { "3000": { label: "web" } } as Record<string, unknown>,
    })),
  };
  const runtime = {
    endpoint: (ip: string, password: string) => ({ baseUrl: `http://${ip}:4096`, password }),
    ensureRunning: vi.fn(async (_p: Project, _a: { password?: string }) => ({ password: "pw", version: "2.0.20" })),
    stopServer: vi.fn(async () => {}),
    isHealthy: vi.fn(async () => true),
  };
  const forwarder = {
    open: vi.fn(async (_id: string, _host: string, ports: PortSpec[], _onLog?: (l: string) => void) =>
      ports.map((p): ForwardedPort => ({ status: "forwarded", containerPort: p.containerPort, label: p.label, hostPort: p.containerPort })),
    ),
    close: vi.fn(async (_id: string) => {}),
    closeAll: vi.fn(async () => {}),
  };
  const orch = new Orchestrator({
    store,
    containers,
    runtime,
    forwarder,
    clientFor: () => ({}) as OpencodeClient,
    roots: () => ["/src"],
    scan: async () => [project],
    monitorFactory: (opts) => {
      const m = { opts, started: false, stopped: false, start() { m.started = true; }, stop() { m.stopped = true; } };
      monitors.push(m);
      return m;
    },
  });
  return { store, containers, runtime, orch, monitors, forwarder };
}

describe("Orchestrator", () => {
  it("start brings up the container, launches opencode and starts a monitor", async () => {
    const { store, containers, runtime, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBe(false);
    expect(runtime.ensureRunning.mock.calls[0][1]).toMatchObject({ ip: "172.17.0.9", workspaceFolder: "/workspaces/demo" });
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "c1",
      password: "pw",
      opencodeVersion: "2.0.20",
      error: undefined,
    });
    expect(monitors[0]).toMatchObject({ started: true });
    expect(monitors[0].opts.directory).toBe("/workspaces/demo");
    expect(orch.logLines(project.id)).toContain("building image");
  });

  it("throws synchronously for unknown projects and concurrent actions", async () => {
    const { orch } = setup();
    await orch.rescan();
    expect(() => orch.start("nope")).toThrow(NotFoundError);
    const first = orch.start(project.id);
    expect(() => orch.stop(project.id)).toThrow(BusyError);
    await first;
    await expect(orch.stop(project.id)).resolves.toBeUndefined();
  });

  it("records devcontainer failures as error state with log tail", async () => {
    const { store, containers, orch } = setup();
    containers.up.mockRejectedValueOnce(new CommandError("devcontainer up failed: boom", ["tail line"]));
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({ containerState: "error", error: "devcontainer up failed: boom" });
    expect(orch.logLines(project.id)).toContain("tail line");
  });

  it("rejects containers without a bridge IP but still records the container id so Stop can clean it up", async () => {
    const { store, containers, orch } = setup();
    containers.inspect.mockResolvedValueOnce({ id: "c1", running: true, projectId: project.id });
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({ containerState: "error", containerId: "c1" });
    expect(store.runtime(project.id).error).toMatch(/host networking/);

    await orch.stop(project.id);
    expect(containers.stop).toHaveBeenCalledWith("c1");
  });

  it("keeps the container running but marks opencode unhealthy when launch fails", async () => {
    const { store, runtime, orch } = setup();
    runtime.ensureRunning.mockRejectedValueOnce(new CommandError("opencode 1.18.31 found, but opendevhub requires opencode v2"));
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({ containerState: "running", opencode: "unhealthy" });
    expect(store.runtime(project.id).error).toMatch(/requires opencode v2/);
  });

  it("rebuild forces a new container and a new password", async () => {
    const { containers, runtime, orch } = setup({ projects: { [project.id]: { password: "old" } } });
    await orch.rescan();
    await orch.rebuild(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBe(true);
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBeUndefined();
  });

  it("start reuses a persisted password", async () => {
    const { runtime, orch } = setup({ projects: { [project.id]: { password: "old" } } });
    await orch.rescan();
    await orch.start(project.id);
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBe("old");
  });

  it("stop stops monitor, opencode and container and clears sessions", async () => {
    const { store, containers, runtime, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    store.setSessions(project.id, [{ id: "s", projectId: project.id, title: "t", directory: "/w", updatedAt: 1, status: "idle" }]);
    await orch.stop(project.id);
    expect(monitors[0].stopped).toBe(true);
    expect(runtime.stopServer).toHaveBeenCalled();
    expect(containers.stop).toHaveBeenCalledWith("c1");
    expect(store.runtime(project.id)).toMatchObject({ containerState: "stopped", opencode: "absent" });
    expect(store.snapshot().projects[0].sessions).toEqual([]);
  });

  it("restartOpencode relaunches with a fresh password", async () => {
    const { runtime, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.restartOpencode(project.id);
    expect(runtime.ensureRunning).toHaveBeenCalledTimes(2);
    expect(runtime.ensureRunning.mock.calls[1][1].password).toBeUndefined();
  });

  it("adopts running containers with a working persisted password", async () => {
    const { store, containers, orch, monitors } = setup({
      projects: { [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({ containerState: "running", opencode: "healthy", containerId: "c1" });
    expect(monitors).toHaveLength(1);
  });

  it("adopts a running container whose opencode is gone as unhealthy", async () => {
    const { store, containers, runtime, orch, monitors } = setup({ projects: { [project.id]: { password: "pw" } } });
    containers.listManaged.mockResolvedValueOnce([running]);
    runtime.isHealthy.mockResolvedValueOnce(false);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({ containerState: "running", opencode: "unhealthy" });
    expect(store.runtime(project.id).error).toMatch(/Restart opencode/);
    expect(monitors).toHaveLength(0);
  });

  it("adopts stopped containers as stopped and ignores unknown labels", async () => {
    const { store, containers, orch } = setup();
    containers.listManaged.mockResolvedValueOnce([
      { ...running, running: false },
      { id: "x", running: true, ip: "1.2.3.4", projectId: "other-000000" },
    ]);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({ containerState: "stopped", containerId: "c1" });
  });

  it("refreshContainers notices containers stopped outside opendevhub", async () => {
    const { store, containers, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    containers.inspect.mockResolvedValueOnce({ ...running, running: false });
    await orch.refreshContainers();
    expect(store.runtime(project.id)).toMatchObject({ containerState: "stopped", opencode: "absent" });
    expect(monitors[0].stopped).toBe(true);
  });

  it("refreshContainers keeps checking other projects when inspect rejects for one", async () => {
    const project2: Project = { ...project, id: "demo2-def456" };
    const { store, containers, orch } = setup();
    containers.up.mockImplementation(async (p: Project) => ({
      containerId: p.id === project.id ? "c1" : "c2",
      remoteWorkspaceFolder: "/workspaces/demo",
    }));
    await orch.rescan();
    store.setProjects([project, project2]);
    await orch.start(project.id);
    await orch.start(project2.id);

    containers.inspect.mockImplementation(async (id?: string) => {
      if (id === "c1") throw new Error("docker inspect failed");
      return { ...running, id: "c2", running: false };
    });

    await expect(orch.refreshContainers()).resolves.toBeUndefined();
    expect(store.runtime(project.id).containerState).toBe("running");
    expect(store.runtime(project2.id).containerState).toBe("stopped");
  });

  it("refreshContainers does not overwrite state set by a lifecycle action started while inspect is in flight", async () => {
    const { store, containers, runtime, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);

    let resolveInspect!: (v: ContainerInfo | undefined) => void;
    containers.inspect.mockImplementationOnce(() => new Promise((resolve) => (resolveInspect = resolve)));
    let resolveEnsure!: (v: { password: string; version: string }) => void;
    runtime.ensureRunning.mockImplementationOnce(() => new Promise((resolve) => (resolveEnsure = resolve)));

    const refreshP = orch.refreshContainers();
    const restartP = orch.restartOpencode(project.id); // marks the project busy synchronously

    resolveInspect({ ...running, running: false });
    await refreshP;
    expect(store.runtime(project.id).containerState).toBe("running");

    resolveEnsure({ password: "pw", version: "2.0.20" });
    await restartP;
    expect(store.runtime(project.id)).toMatchObject({ containerState: "running", opencode: "healthy" });
  });

  it("monitor health updates opencode state; sessions flow into the store", async () => {
    const { store, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    monitors[0].opts.onHealth(false);
    expect(store.runtime(project.id).opencode).toBe("unhealthy");
    monitors[0].opts.onSessions([{ id: "s", projectId: project.id, title: "t", directory: "/w", updatedAt: 1, status: "running" }]);
    expect(store.snapshot().projects[0].sessions).toHaveLength(1);
  });

  it("notifies log listeners and caps the log buffer at 500 lines", async () => {
    const { containers, orch } = setup();
    containers.up.mockImplementationOnce(async (_p, o) => {
      for (let i = 0; i < 600; i++) o.onLine(`line ${i}`);
      return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo" };
    });
    const seen: string[] = [];
    orch.onLog((_id, line) => seen.push(line));
    await orch.rescan();
    await orch.start(project.id);
    expect(seen).toContain("line 599");
    expect(orch.logLines(project.id)).toHaveLength(500);
    expect(orch.logLines(project.id)[0]).not.toBe("line 0");
  });
  it("forwards configured ports on start, including skipped entries in runtime.ports", async () => {
    const { store, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open).toHaveBeenCalledWith(project.id, "172.17.0.9", [{ containerPort: 3000, label: "web" }], expect.any(Function));
    expect(store.runtime(project.id).ports).toEqual([
      { status: "forwarded", containerPort: 3000, label: "web", hostPort: 3000 },
      { status: "skipped", entry: "db:5432", reason: "service hosts are not supported yet" },
    ]);
    expect(orch.logLines(project.id)).toContain("ports: 3000 → localhost:3000");
    expect(orch.logLines(project.id)).toContain("ports: skipped db:5432 (service hosts are not supported yet)");
  });

  it("forwards ports before launching opencode, so they survive an opencode failure", async () => {
    const { store, runtime, orch, forwarder } = setup();
    runtime.ensureRunning.mockRejectedValueOnce(new CommandError("opencode 1.18.31 found, but opendevhub requires opencode v2"));
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open).toHaveBeenCalled();
    expect(store.runtime(project.id).ports).toHaveLength(2);
    expect(store.runtime(project.id).opencode).toBe("unhealthy");
  });

  it("still starts when the devcontainer config cannot be read", async () => {
    const { store, containers, orch, forwarder } = setup();
    containers.readConfiguration.mockRejectedValueOnce(new CommandError("devcontainer read-configuration failed (exit 1)"));
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open).not.toHaveBeenCalled();
    expect(store.runtime(project.id)).toMatchObject({ containerState: "running", opencode: "healthy", ports: [], error: undefined });
    expect(orch.logLines(project.id)).toContain(
      "ports: could not read devcontainer configuration: devcontainer read-configuration failed (exit 1)",
    );
  });

  it("logs failed forwards without touching the project error", async () => {
    const { store, orch, forwarder } = setup();
    forwarder.open.mockResolvedValueOnce([{ status: "failed", containerPort: 3000, label: "web", reason: "no free host port in 3000–3100" }]);
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id).error).toBeUndefined();
    expect(orch.logLines(project.id)).toContain("ports: 3000 not forwarded (no free host port in 3000–3100)");
  });

  it("stop closes the forwards and clears runtime.ports", async () => {
    const { store, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.stop(project.id);
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(store.runtime(project.id).ports).toBeUndefined();
  });

  it("rebuild closes old forwards and reopens against the new container IP", async () => {
    const { containers, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    containers.inspect.mockResolvedValue({ ...running, ip: "172.17.0.42" });
    await orch.rebuild(project.id);
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(forwarder.close.mock.invocationCallOrder[0]).toBeLessThan(forwarder.open.mock.invocationCallOrder[1]);
    expect(forwarder.open.mock.calls[1][1]).toBe("172.17.0.42");
  });

  it("adopt forwards ports of running containers only", async () => {
    const { store, containers, orch, forwarder } = setup({ projects: { [project.id]: { password: "pw" } } });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(forwarder.open).toHaveBeenCalledWith(project.id, "172.17.0.9", [{ containerPort: 3000, label: "web" }], expect.any(Function));
    expect(store.runtime(project.id).ports).toHaveLength(2);

    const stopped = setup();
    stopped.containers.listManaged.mockResolvedValueOnce([{ ...running, running: false }]);
    await stopped.orch.rescan();
    await stopped.orch.adopt();
    expect(stopped.forwarder.open).not.toHaveBeenCalled();
  });

  it("refreshContainers closes forwards of containers that went away", async () => {
    const { store, containers, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    containers.inspect.mockResolvedValueOnce({ ...running, running: false });
    await orch.refreshContainers();
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(store.runtime(project.id).ports).toBeUndefined();
  });

  it("shutdown closes all forwards", async () => {
    const { orch, forwarder } = setup();
    await orch.shutdown();
    expect(forwarder.closeAll).toHaveBeenCalled();
  });
});
