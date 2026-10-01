import { describe, expect, it, vi } from "vitest";
import type { PersistedState } from "../../src/server/config";
import { CommandError, type ContainerInfo } from "../../src/server/containers";
import type { MonitorOptions } from "../../src/server/monitor";
import type { OpencodeClient } from "../../src/server/opencode/client";
import { BusyError, NotFoundError, Orchestrator, UnavailableError } from "../../src/server/orchestrator";
import { StateStore } from "../../src/server/state";
import type { PortSpec } from "../../src/server/ports";
import type { ForwardTarget } from "../../src/server/port-forwarder";
import type { RelayStatus } from "../../src/server/relay/runtime";
import type { OpenTarget } from "../../src/server/editors";
import { type AddWorktreeArgs, InvalidRequestError } from "../../src/server/worktrees";
import type { ForwardedPort, Worktree, WorktreeRoot } from "../../src/shared/types";
import type { Project } from "../../src/shared/types";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};
const running: ContainerInfo = {
  id: "c1",
  name: "demo_c1",
  running: true,
  ip: "172.17.0.9",
  projectId: project.id,
  binds: { "/workspaces/demo": "/src/demo", "/workspaces/demo.worktrees": "/src/demo.worktrees" },
};

function setup(persisted: PersistedState = { projects: {} }) {
  const store = new StateStore({ port: 7777, persisted, persist: () => {} });
  const monitors: Array<{ opts: MonitorOptions; started: boolean; stopped: boolean }> = [];
  const containers = {
    up: vi.fn(
      async (
        _p: Project,
        o: { rebuild: boolean; onLine: (l: string) => void; mounts?: string[] },
      ): Promise<{ containerId: string; remoteWorkspaceFolder: string; remoteUser?: string }> => {
        o.onLine("building image");
        return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo", remoteUser: "node" };
      },
    ),
    workspaceFolder: vi.fn(async (_p?: Project): Promise<string | undefined> => "/workspaces/demo"),
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
    resolveBinary: vi.fn(async (_p?: Project): Promise<string | undefined> => "/usr/local/bin/opencode"),
  };
  const forwarder = {
    open: vi.fn(async (_id: string, _target: ForwardTarget, ports: PortSpec[], _onLog?: (l: string) => void, _events?: { onRelayUnreachable?: () => void }) =>
      ports.map((p): ForwardedPort => ({ status: "forwarded", containerPort: p.containerPort, label: p.label, hostPort: p.containerPort })),
    ),
    close: vi.fn(async (_id: string) => {}),
    closeAll: vi.fn(async () => {}),
  };
  const relay = {
    ensureRunning: vi.fn(
      async (_p: Project, _a: { ip: string; token: string; binary?: string }): Promise<RelayStatus> => ({
        status: "active",
        via: "bun",
      }),
    ),
    stop: vi.fn(async (_p?: Project) => {}),
  };
  const worktrees = {
    list: vi.fn(async (_p: Project, _ws: string, _root?: WorktreeRoot): Promise<Worktree[]> => []),
    add: vi.fn(async (_p: Project, a: AddWorktreeArgs): Promise<Worktree> => ({
      path: `${a.root.container}/${a.branch.replace(/\//g, "-")}`,
      hostPath: `${a.root.host}/${a.branch.replace(/\//g, "-")}`,
      branch: a.branch,
    })),
    remove: vi.fn(async (_p: Project, _ws: string, _path: string, _force: boolean) => {}),
  };
  const editors = { open: vi.fn(async (_id: string, _t: OpenTarget) => {}) };
  const client = { createSession: vi.fn(async (directory: string) => ({ id: "ses_new", location: { directory } })) };
  const mkdir = vi.fn(async (_dir: string) => {});
  const orch = new Orchestrator({
    store,
    containers,
    runtime,
    forwarder,
    relay,
    worktrees,
    editors,
    mkdir,
    clientFor: () => client as unknown as OpencodeClient,
    roots: () => ["/src"],
    scan: async () => [project],
    monitorFactory: (opts) => {
      const m = { opts, started: false, stopped: false, start() { m.started = true; }, stop() { m.stopped = true; } };
      monitors.push(m);
      return m;
    },
  });
  return { store, containers, runtime, orch, monitors, forwarder, relay, worktrees, editors, client, mkdir };
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

    // restartOpencode ensures the relay before launching opencode, so wait for the launch call.
    await vi.waitFor(() => expect(runtime.ensureRunning).toHaveBeenCalledTimes(2));
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
    expect(forwarder.open).toHaveBeenCalledWith(project.id, expect.objectContaining({ host: "172.17.0.9" }), [{ containerPort: 3000, label: "web" }], expect.any(Function), expect.any(Object));
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
    expect(forwarder.open.mock.calls[1][1].host).toBe("172.17.0.42");
  });

  it("adopt forwards ports of running containers only", async () => {
    const { store, containers, orch, forwarder } = setup({ projects: { [project.id]: { password: "pw" } } });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(forwarder.open).toHaveBeenCalledWith(project.id, expect.objectContaining({ host: "172.17.0.9" }), [{ containerPort: 3000, label: "web" }], expect.any(Function), expect.any(Object));
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
  it("starts the relay before forwarding and forwards through it", async () => {
    const { store, relay, forwarder, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    const token = store.runtime(project.id).relayToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(relay.ensureRunning).toHaveBeenCalledWith(project, { ip: "172.17.0.9", token, binary: "/usr/local/bin/opencode" });
    expect(relay.ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(forwarder.open.mock.invocationCallOrder[0]);
    expect(forwarder.open.mock.calls[0][1]).toEqual({ host: "172.17.0.9", relay: { port: 4097, token } });
    expect(store.runtime(project.id).relay).toBe("active");
    expect(orch.logLines(project.id)).toContain("relay: active (bun)");
  });

  it("forwards directly and still starts when the relay is unavailable", async () => {
    const { store, relay, forwarder, orch } = setup();
    relay.ensureRunning.mockResolvedValueOnce({ status: "unavailable", reason: "no relay runtime" });
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open.mock.calls[0][1]).toEqual({ host: "172.17.0.9" });
    expect(store.runtime(project.id)).toMatchObject({ relay: "unavailable", opencode: "healthy", error: undefined });
    expect(orch.logLines(project.id)).toContain("relay: unavailable (no relay runtime)");
  });

  it("reuses the persisted relay token across restarts and adoption", async () => {
    const { relay, containers, orch } = setup({ projects: { [project.id]: { password: "pw", relayToken: "kept" } } });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(relay.ensureRunning.mock.calls[0][1].token).toBe("kept");
  });

  it("stop stops the relay and clears the relay status", async () => {
    const { store, relay, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.stop(project.id);
    expect(relay.stop).toHaveBeenCalledWith(project);
    expect(store.runtime(project.id).relay).toBeUndefined();
  });

  it("relaunches the relay in the background when the forwarder finds it unreachable (rate-limited)", async () => {
    const { store, relay, forwarder, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    const events = forwarder.open.mock.calls[0][4]!;
    relay.ensureRunning.mockResolvedValueOnce({ status: "unavailable", reason: "bun: gone" });
    events.onRelayUnreachable!();
    await vi.waitFor(() => expect(relay.ensureRunning).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.runtime(project.id).relay).toBe("unavailable"));
    expect(orch.logLines(project.id)).toContain("relay: unreachable, relaunching");
    events.onRelayUnreachable!();
    await new Promise((r) => setTimeout(r, 20));
    expect(relay.ensureRunning).toHaveBeenCalledTimes(2);
  });

  it("restart opencode also ensures the relay and re-forwards when it comes back", async () => {
    const { store, relay, forwarder, orch } = setup();
    relay.ensureRunning.mockResolvedValueOnce({ status: "unavailable", reason: "no relay runtime" });
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open.mock.calls[0][1]).toEqual({ host: "172.17.0.9" });
    await orch.restartOpencode(project.id);
    expect(relay.ensureRunning).toHaveBeenCalledTimes(2);
    expect(forwarder.open).toHaveBeenCalledTimes(2);
    expect(forwarder.open.mock.calls[1][1]).toMatchObject({ relay: { port: 4097 } });
    expect(store.runtime(project.id).relay).toBe("active");
  });

  describe("worktrees", () => {
    const wtPath = "/workspaces/demo.worktrees/feature-x";
    const known: Worktree = { path: wtPath, hostPath: "/src/demo.worktrees/feature-x", branch: "feature/x" };

    it("mounts a host folder next to the project, created before up", async () => {
      const { store, containers, mkdir, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      expect(mkdir).toHaveBeenCalledWith("/src/demo.worktrees");
      expect(containers.up.mock.calls[0][1].mounts).toEqual([
        "type=bind,source=/src/demo.worktrees,target=/workspaces/demo.worktrees",
      ]);
      expect(store.runtime(project.id)).toMatchObject({
        containerName: "demo_c1",
        remoteUser: "node",
        worktreeRoot: { host: "/src/demo.worktrees", container: "/workspaces/demo.worktrees", mounted: true },
      });
    });

    it("uses the configured workspace folder for the mount target", async () => {
      const { containers, orch } = setup();
      containers.workspaceFolder.mockResolvedValueOnce("/code/demo");
      await orch.rescan();
      await orch.start(project.id);
      expect(containers.up.mock.calls[0][1].mounts?.[0]).toMatch(/target=\/code\/demo\.worktrees$/);
    });

    it("still starts when the folder can't be created, and flags a container without the mount", async () => {
      const { store, containers, mkdir, orch } = setup();
      mkdir.mockRejectedValueOnce(new Error("EACCES"));
      containers.inspect.mockResolvedValue({ ...running, binds: {} });
      await orch.rescan();
      await orch.start(project.id);
      expect(containers.up.mock.calls[0][1].mounts).toEqual([]);
      expect(store.runtime(project.id)).toMatchObject({ containerState: "running", worktreeRoot: { mounted: false } });
      expect(orch.logLines(project.id).join("\n")).toMatch(/EACCES[\s\S]*rebuild it to enable worktrees/);
      await expect(orch.createWorktree(project.id, { branch: "x" })).rejects.toBeInstanceOf(UnavailableError);
    });

    it("lists worktrees on start and on adopt", async () => {
      const { store, worktrees, containers, orch } = setup({ projects: { [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" } } });
      worktrees.list.mockResolvedValue([known]);
      containers.listManaged.mockResolvedValue([running]);
      await orch.rescan();
      await orch.adopt();
      expect(worktrees.list.mock.calls[0][2]).toMatchObject({ mounted: true });
      expect(store.runtime(project.id).worktrees).toEqual([known]);
    });

    it("creates a worktree, refreshes the list and starts a session in it", async () => {
      const { store, worktrees, client, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      worktrees.list.mockResolvedValue([known]);
      const res = await orch.createWorktree(project.id, { branch: " feature/x ", base: " ", startSession: true });
      expect(worktrees.add.mock.calls[0][1]).toMatchObject({ branch: "feature/x", base: undefined, workspaceFolder: "/workspaces/demo" });
      expect(client.createSession).toHaveBeenCalledWith(res.worktree.path, "feature/x");
      expect(res.sessionId).toBe("ses_new");
      expect(store.runtime(project.id).worktrees).toEqual([known]);
    });

    it("validates input and needs a running container", async () => {
      const { orch } = setup();
      await orch.rescan();
      expect(() => orch.createWorktree(project.id, { branch: "a b" })).toThrow(InvalidRequestError);
      expect(() => orch.createWorktree(project.id, { branch: "ok" })).toThrow(UnavailableError);
      expect(() => orch.createWorktree("nope", { branch: "ok" })).toThrow(NotFoundError);
    });

    it("runs one git operation at a time per project", async () => {
      const { worktrees, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      let release!: () => void;
      worktrees.add.mockImplementationOnce(
        (_p, a) => new Promise((r) => (release = () => r({ path: `${a.root.container}/x`, branch: "x" }))),
      );
      const first = orch.createWorktree(project.id, { branch: "x" });
      expect(() => orch.createWorktree(project.id, { branch: "y" })).toThrow(BusyError);
      await vi.waitFor(() => expect(release).toBeDefined());
      release();
      await first;
    });

    it("only removes, opens and starts sessions in the workspace or known worktrees", async () => {
      const { store, worktrees, editors, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      store.updateRuntime(project.id, { worktrees: [known] });
      await expect(orch.removeWorktree(project.id, "/etc", true)).rejects.toThrow(InvalidRequestError);
      await expect(orch.startSession(project.id, "/tmp")).rejects.toThrow(InvalidRequestError);
      expect(() => orch.openInEditor(project.id, "zed", "/home")).toThrow(InvalidRequestError);

      await orch.openInEditor(project.id, "zed", wtPath);
      expect(editors.open).toHaveBeenLastCalledWith("zed", {
        containerPath: wtPath,
        hostPath: "/src/demo.worktrees/feature-x",
        containerName: "demo_c1",
      });
      await orch.openInEditor(project.id, "zed", "/workspaces/demo");
      expect(editors.open.mock.calls.at(-1)?.[1].hostPath).toBe("/src/demo");

      worktrees.list.mockResolvedValue([]);
      await orch.removeWorktree(project.id, wtPath, false);
      expect(worktrees.remove).toHaveBeenCalledWith(project, "/workspaces/demo", wtPath, false);
      expect(store.runtime(project.id).worktrees).toEqual([]);
    });

    it("opens host editors on a stopped project, without a container to attach to", async () => {
      const { store, editors, orch } = setup();
      await orch.rescan();
      store.updateRuntime(project.id, { containerName: "demo_c1", worktrees: [known] });
      await orch.openInEditor(project.id, "zed", wtPath);
      expect(editors.open.mock.calls[0][1]).toEqual({ containerPath: wtPath, hostPath: known.hostPath, containerName: undefined });
    });

    it("watches worktree directories and refreshes when a session shows up in an unknown one", async () => {
      const { store, worktrees, monitors, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      store.updateRuntime(project.id, { worktrees: [known] });
      expect(monitors[0].opts.extraDirectories?.()).toEqual([wtPath]);
      const calls = worktrees.list.mock.calls.length;
      const session = (directory: string) => ({ id: directory, projectId: project.id, title: "t", directory, updatedAt: 1, status: "idle" as const });
      monitors[0].opts.onSessions([session("/workspaces/demo"), session(wtPath)]);
      expect(worktrees.list.mock.calls.length).toBe(calls);
      monitors[0].opts.onSessions([session("/home/node/.local/share/opencode/worktree/p/y")]);
      await vi.waitFor(() => expect(worktrees.list.mock.calls.length).toBe(calls + 1));
      monitors[0].opts.onSessions([session("/home/node/.local/share/opencode/worktree/p/y")]);
      await new Promise((r) => setTimeout(r, 10));
      expect(worktrees.list.mock.calls.length).toBe(calls + 1);
    });
  });
});
