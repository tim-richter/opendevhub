import { describe, expect, it, vi } from "vitest";

import { SYSTEM } from "../../../src/server/db/events";
import { envIdFor } from "../../../src/server/environments/config";
import {
  CommandError,
  envLabels,
} from "../../../src/server/environments/containers";
import type {
  ContainerInfo,
  ExecTarget,
} from "../../../src/server/environments/containers";
import {
  BusyError,
  NotFoundError,
  UnavailableError,
} from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import type {
  Dial,
  Route,
  RouteContainer,
} from "../../../src/server/network/routes";
import type { Project } from "../../../src/shared/types";
import { rawSession } from "../../helpers/fake-opencode";
import {
  project,
  running,
  feat,
  featEnv,
  runningTask,
  remoteFix,
  remoteEnv,
  boxKit,
  setup,
  withRemote,
  withRemoteRunning,
  withWorktree,
  withEnv,
  waiting,
  permission,
} from "../../helpers/hub";

describe("environments", () => {
  it("routes terminals to shared, isolated and remote containers and rejects unknown or stopped checkouts", async () => {
    const shared = await withWorktree();
    await expect(
      shared.hub.environments.terminalTarget(project.id, feat.path)
    ).resolves.toMatchObject({ containerId: "c1" });
    await expect(
      shared.hub.environments.terminalTarget(project.id, "/unknown")
    ).rejects.toThrow(/neither the workspace nor a known worktree/u);
    shared.store.updateRuntime(project.id, { containerState: "stopped" });
    await expect(
      shared.hub.environments.terminalTarget(project.id, feat.path)
    ).rejects.toThrow(/Start this checkout/u);
    const isolated = await withEnv();
    await expect(
      isolated.hub.environments.terminalTarget(project.id, feat.path)
    ).resolves.toMatchObject({ containerId: "c2" });
    const remote = await withRemoteRunning();
    await expect(
      remote.hub.environments.terminalTarget(project.id, remoteFix.path)
    ).resolves.toMatchObject({ containerId: "r1", node: "box", user: "node" });
  });

  it("runs the main container as the project's main environment", async () => {
    const { hub, monitors } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(monitors[0].opts).toMatchObject({
      projectId: project.id,
      envId: project.id,
      directory: "/workspaces/demo",
    });
  });

  it("start brings up the container, launches opencode and starts a monitor", async () => {
    const { store, containers, runtime, hub, monitors } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBeFalsy();
    expect(runtime.ensureRunning.mock.calls[0][1]).toMatchObject({
      address: { host: "172.17.0.9", port: 4096 },
      containerId: "c1",
      workspaceFolder: "/workspaces/demo",
    });
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
    expect(hub.environments.logLines(project.id)).toContain("building image");
  });

  it("keeps opencode's sessions on a labelled volume that survives a rebuild", async () => {
    const { containers, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    await hub.environments.rebuild(project.id);
    const volume = `opendevhub-opencode-${project.id}`;
    expect(containers.ensureVolume).toHaveBeenCalledWith(volume, [
      "opendevhub.volume=opencode",
      `opendevhub.project=${project.id}`,
    ]);
    expect(containers.up.mock.calls[1][1]).toMatchObject({ rebuild: true });
    expect(containers.up.mock.calls[1][1].mounts).toContain(
      `type=volume,source=${volume},target=/opendevhub/opencode`
    );
    expect(containers.removeVolume).not.toHaveBeenCalled();
  });

  it("rebuilds without cache when asked", async () => {
    const { containers, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    await hub.environments.rebuild(project.id, true);
    expect(containers.up.mock.calls[0][1]).toMatchObject({ noCache: false });
    expect(containers.up.mock.calls[1][1]).toMatchObject({
      noCache: true,
      rebuild: true,
    });
  });

  it("throws synchronously for unknown projects and concurrent actions", async () => {
    const { hub } = setup();
    await hub.environments.rescan();
    expect(() => hub.environments.start("nope")).toThrow(NotFoundError);
    const first = hub.environments.start(project.id);
    expect(() => hub.environments.stop(project.id)).toThrow(BusyError);
    await first;
    await expect(hub.environments.stop(project.id)).resolves.toBeUndefined();
  });

  it("records devcontainer failures as error state with log tail", async () => {
    const { store, containers, hub } = setup();
    containers.up.mockRejectedValueOnce(
      new CommandError("devcontainer up failed: boom", ["tail line"])
    );
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "error",
      error: "devcontainer up failed: boom",
    });
    expect(hub.environments.logLines(project.id)).toContain("tail line");
  });

  it("rejects containers without a bridge IP but still records the container id so Stop can clean it up", async () => {
    const { store, containers, hub } = setup();
    containers.inspect.mockResolvedValueOnce({
      id: "c1",
      running: true,
      projectId: project.id,
    });
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "error",
      containerId: "c1",
    });
    expect(store.runtime(project.id).error).toMatch(/host networking/u);

    await hub.environments.stop(project.id);
    expect(containers.stop).toHaveBeenCalledWith("c1");
  });

  it("keeps the container running but marks opencode unhealthy when launch fails", async () => {
    const { store, runtime, hub } = setup();
    runtime.ensureRunning.mockRejectedValueOnce(
      new CommandError(
        "opencode 1.18.31 found, but opendevhub requires opencode v2"
      )
    );
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "unhealthy",
    });
    expect(store.runtime(project.id).error).toMatch(/requires opencode v2/u);
  });

  it("rebuild forces a new container and a new password", async () => {
    const { containers, runtime, hub } = setup({
      projects: { [project.id]: { password: "old" } },
    });
    await hub.environments.rescan();
    await hub.environments.rebuild(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBeTruthy();
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBeUndefined();
  });

  it("start reuses a persisted password", async () => {
    const { runtime, hub } = setup({
      projects: { [project.id]: { password: "old" } },
    });
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBe("old");
  });

  it("stop stops monitor, opencode and container and clears sessions", async () => {
    const { store, containers, runtime, hub, monitors } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    store.setSessions(project.id, [
      {
        id: "s",
        projectId: project.id,
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    await hub.environments.stop(project.id);
    expect(monitors[0].stopped).toBeTruthy();
    expect(runtime.stopServer).toHaveBeenCalled();
    expect(containers.stop).toHaveBeenCalledWith("c1");
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      opencode: "absent",
    });
    expect(store.snapshot().projects[0].sessions).toEqual([]);
  });

  it("restartOpencode relaunches with a fresh password", async () => {
    const { runtime, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    await hub.environments.restartOpencode(project.id);
    expect(runtime.ensureRunning).toHaveBeenCalledTimes(2);
    expect(runtime.ensureRunning.mock.calls[1][1].password).toBeUndefined();
  });

  it("adopts running containers with a working persisted password", async () => {
    const { store, containers, hub, monitors } = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await hub.environments.rescan();
    await hub.environments.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "c1",
    });
    expect(monitors).toHaveLength(1);
  });

  it("adopts a running container whose opencode is gone as unhealthy", async () => {
    const { store, containers, runtime, hub, monitors } = setup({
      projects: { [project.id]: { password: "pw" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    runtime.isHealthy.mockResolvedValueOnce(false);
    await hub.environments.rescan();
    await hub.environments.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "unhealthy",
    });
    expect(store.runtime(project.id).error).toMatch(/Restart opencode/u);
    expect(monitors).toHaveLength(0);
  });

  it("adopts stopped containers as stopped and ignores unknown labels", async () => {
    const { store, containers, hub } = setup();
    containers.listManaged.mockResolvedValueOnce([
      { ...running, running: false },
      { id: "x", running: true, ip: "1.2.3.4", projectId: "other-000000" },
    ]);
    await hub.environments.rescan();
    await hub.environments.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      containerId: "c1",
    });
  });

  it("refreshContainers notices containers stopped outside opendevhub", async () => {
    const { store, containers, hub, monitors } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    containers.inspect.mockResolvedValueOnce({ ...running, running: false });
    await hub.environments.refreshContainers();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      opencode: "absent",
    });
    expect(monitors[0].stopped).toBeTruthy();
  });

  it("refreshContainers keeps checking other projects when inspect rejects for one", async () => {
    const project2: Project = { ...project, id: "demo2-def456" };
    const { store, containers, hub } = setup();
    containers.up.mockImplementation(async (p: ExecTarget) => ({
      containerId: p.id === project.id ? "c1" : "c2",
      remoteWorkspaceFolder: "/workspaces/demo",
    }));
    await hub.environments.rescan();
    store.setProjects([project, project2]);
    await hub.environments.start(project.id);
    await hub.environments.start(project2.id);

    containers.inspect.mockImplementation(async (id?: string) => {
      if (id === "c1") {
        throw new Error("docker inspect failed");
      }
      return { ...running, id: "c2", running: false };
    });

    await expect(hub.environments.refreshContainers()).resolves.toBeUndefined();
    expect(store.runtime(project.id).containerState).toBe("running");
    expect(store.runtime(project2.id).containerState).toBe("stopped");
  });

  it("refreshContainers does not overwrite state set by a lifecycle action started while inspect is in flight", async () => {
    const { store, containers, runtime, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);

    let resolveInspect!: (v: ContainerInfo | undefined) => void;
    containers.inspect.mockImplementationOnce(
      () => new Promise((resolve) => (resolveInspect = resolve))
    );
    let resolveEnsure!: (v: { password: string; version: string }) => void;
    runtime.ensureRunning.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEnsure = resolve))
    );

    const refreshP = hub.environments.refreshContainers();
    const restartP = hub.environments.restartOpencode(project.id); // marks the project busy synchronously

    resolveInspect({ ...running, running: false });
    await refreshP;
    expect(store.runtime(project.id).containerState).toBe("running");

    // restartOpencode ensures the relay before launching opencode, so wait for the launch call.
    await vi.waitFor(() =>
      expect(runtime.ensureRunning).toHaveBeenCalledTimes(2)
    );
    resolveEnsure({ password: "pw", version: "2.0.20" });
    await restartP;
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
    });
  });

  it("monitor health updates opencode state; sessions flow into the store", async () => {
    const { store, hub, monitors } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    monitors[0].opts.onHealth(false);
    expect(store.runtime(project.id).opencode).toBe("unhealthy");
    monitors[0].opts.onSessions([
      {
        id: "s",
        projectId: project.id,
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "running",
      },
    ]);
    expect(store.snapshot().projects[0].sessions).toHaveLength(1);
  });

  it("records usage from every monitor under the project's id", async () => {
    const s = await withEnv();
    const main = s.monitors.find((m) => m.opts.envId === project.id)!;
    const env = s.monitors.find((m) => m.opts.envId !== project.id)!;
    main.opts.onRawSessions!([rawSession("a")]);
    env.opts.onRawSessions!([rawSession("b")]);
    expect(
      s.recordUsage.mock.calls.map(([id, sessions]) => [
        id,
        sessions.map((x: { id: string }) => x.id),
      ])
    ).toStrictEqual([
      [project.id, ["a"]],
      [project.id, ["b"]],
    ]);
  });

  it("notifies log listeners and caps the log buffer at 500 lines", async () => {
    const { containers, hub } = setup();
    containers.up.mockImplementationOnce(async (_p, o) => {
      for (let i = 0; i < 600; i++) {
        o.onLine(`line ${i}`);
      }
      return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo" };
    });
    const seen: string[] = [];
    hub.environments.onLog((_id, line) => seen.push(line));
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(seen).toContain("line 599");
    expect(hub.environments.logLines(project.id)).toHaveLength(500);
    expect(hub.environments.logLines(project.id)[0]).not.toBe("line 0");
  });

  it("forwards configured ports on start, including skipped entries in runtime.ports", async () => {
    const { store, hub, forwarder } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(forwarder.open).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ host: "172.17.0.9" }),
      [{ containerPort: 3000, label: "web" }],
      expect.any(Function),
      expect.any(Object)
    );
    expect(store.runtime(project.id).ports).toStrictEqual([
      {
        status: "forwarded",
        containerPort: 3000,
        label: "web",
        hostPort: 3000,
      },
      {
        status: "skipped",
        entry: "db:5432",
        reason: "service hosts are not supported yet",
      },
    ]);
    expect(hub.environments.logLines(project.id)).toContain(
      "ports: 3000 → localhost:3000"
    );
    expect(hub.environments.logLines(project.id)).toContain(
      "ports: skipped db:5432 (service hosts are not supported yet)"
    );
  });

  it("forwards ports before launching opencode, so they survive an opencode failure", async () => {
    const { store, runtime, hub, forwarder } = setup();
    runtime.ensureRunning.mockRejectedValueOnce(
      new CommandError(
        "opencode 1.18.31 found, but opendevhub requires opencode v2"
      )
    );
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(forwarder.open).toHaveBeenCalled();
    expect(store.runtime(project.id).ports).toHaveLength(2);
    expect(store.runtime(project.id).opencode).toBe("unhealthy");
  });

  it("still starts when the devcontainer config cannot be read", async () => {
    const { store, containers, hub, forwarder } = setup();
    containers.readConfiguration.mockRejectedValueOnce(
      new CommandError("devcontainer read-configuration failed (exit 1)")
    );
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(forwarder.open).not.toHaveBeenCalled();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      ports: [],
      error: undefined,
    });
    expect(hub.environments.logLines(project.id)).toContain(
      "ports: could not read devcontainer configuration: devcontainer read-configuration failed (exit 1)"
    );
  });

  it("logs failed forwards without touching the project error", async () => {
    const { store, hub, forwarder } = setup();
    forwarder.open.mockResolvedValueOnce([
      {
        status: "failed",
        containerPort: 3000,
        label: "web",
        reason: "no free host port in 3000–3100",
      },
    ]);
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(store.runtime(project.id).error).toBeUndefined();
    expect(hub.environments.logLines(project.id)).toContain(
      "ports: 3000 not forwarded (no free host port in 3000–3100)"
    );
  });

  it("stop closes the forwards and clears runtime.ports", async () => {
    const { store, hub, forwarder } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    await hub.environments.stop(project.id);
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(store.runtime(project.id).ports).toBeUndefined();
  });

  it("rebuild closes old forwards and reopens against the new container IP", async () => {
    const { containers, hub, forwarder } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    containers.inspect.mockResolvedValue({ ...running, ip: "172.17.0.42" });
    await hub.environments.rebuild(project.id);
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(forwarder.close.mock.invocationCallOrder[0]).toBeLessThan(
      forwarder.open.mock.invocationCallOrder[1]
    );
    expect(forwarder.open.mock.calls[1][1].host).toBe("172.17.0.42");
  });

  it("adopt forwards ports of running containers only", async () => {
    const { store, containers, hub, forwarder } = setup({
      projects: { [project.id]: { password: "pw" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await hub.environments.rescan();
    await hub.environments.adopt();
    expect(forwarder.open).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ host: "172.17.0.9" }),
      [{ containerPort: 3000, label: "web" }],
      expect.any(Function),
      expect.any(Object)
    );
    expect(store.runtime(project.id).ports).toHaveLength(2);

    const stopped = setup();
    stopped.containers.listManaged.mockResolvedValueOnce([
      { ...running, running: false },
    ]);
    await stopped.hub.environments.rescan();
    await stopped.hub.environments.adopt();
    expect(stopped.forwarder.open).not.toHaveBeenCalled();
  });

  it("refreshContainers closes forwards of containers that went away", async () => {
    const { store, containers, hub, forwarder } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    containers.inspect.mockResolvedValueOnce({ ...running, running: false });
    await hub.environments.refreshContainers();
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(store.runtime(project.id).ports).toBeUndefined();
  });

  it("shutdown closes all forwards", async () => {
    const { hub, forwarder } = setup();
    await hub.environments.shutdown();
    expect(forwarder.closeAll).toHaveBeenCalled();
  });

  it("starts the relay before forwarding and forwards through it", async () => {
    const { store, relay, forwarder, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    const token = store.runtime(project.id).relayToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(relay.ensureRunning).toHaveBeenCalledWith(project, {
      address: { host: "172.17.0.9", port: 4097 },
      token,
      binary: "/usr/local/bin/opencode",
    });
    expect(relay.ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(
      forwarder.open.mock.invocationCallOrder[0]
    );
    expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
      host: "172.17.0.9",
      relay: { host: "172.17.0.9", port: 4097, token },
    });
    expect(store.runtime(project.id).relay).toBe("active");
    expect(hub.environments.logLines(project.id)).toContain(
      "relay: active (bun)"
    );
  });

  it("forwards directly and still starts when the relay is unavailable", async () => {
    const { store, relay, forwarder, hub } = setup();
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "no relay runtime",
    });
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
      host: "172.17.0.9",
    });
    expect(store.runtime(project.id)).toMatchObject({
      relay: "unavailable",
      opencode: "healthy",
      error: undefined,
    });
    expect(hub.environments.logLines(project.id)).toContain(
      "relay: unavailable (no relay runtime)"
    );
  });

  it("reuses the persisted relay token across restarts and adoption", async () => {
    const { relay, containers, hub } = setup({
      projects: { [project.id]: { password: "pw", relayToken: "kept" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await hub.environments.rescan();
    await hub.environments.adopt();
    expect(relay.ensureRunning.mock.calls[0][1].token).toBe("kept");
  });

  it("stop stops the relay and clears the relay status", async () => {
    const { store, relay, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    await hub.environments.stop(project.id);
    expect(relay.stop).toHaveBeenCalledWith(project);
    expect(store.runtime(project.id).relay).toBeUndefined();
  });

  it("relaunches the relay in the background when the forwarder finds it unreachable (rate-limited)", async () => {
    const { store, relay, forwarder, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    const events = forwarder.open.mock.calls[0][4]!;
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "bun: gone",
    });
    events.onRelayUnreachable!();
    await vi.waitFor(() =>
      expect(relay.ensureRunning).toHaveBeenCalledTimes(2)
    );
    await vi.waitFor(() =>
      expect(store.runtime(project.id).relay).toBe("unavailable")
    );
    expect(hub.environments.logLines(project.id)).toContain(
      "relay: unreachable, relaunching"
    );
    events.onRelayUnreachable!();
    await new Promise((r) => setTimeout(r, 20));
    expect(relay.ensureRunning).toHaveBeenCalledTimes(2);
  });

  it("restart opencode also ensures the relay and re-forwards when it comes back", async () => {
    const { store, relay, forwarder, hub } = setup();
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "no relay runtime",
    });
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
      host: "172.17.0.9",
    });
    await hub.environments.restartOpencode(project.id);
    expect(relay.ensureRunning).toHaveBeenCalledTimes(2);
    expect(forwarder.open).toHaveBeenCalledTimes(2);
    expect(forwarder.open.mock.calls[1][1]).toMatchObject({
      relay: { port: 4097 },
    });
    expect(store.runtime(project.id).relay).toBe("active");
  });

  describe("through the gateway route", () => {
    function gatewayNetwork() {
      const dial: Dial = vi.fn(async () => {
        throw new Error("not used");
      });
      const routes: (Route & { closed: boolean })[] = [];
      const network = {
        route: vi.fn(async (c: RouteContainer, onLog: (l: string) => void) => {
          onLog(
            `network: container IP ${c.ip} is not reachable from this machine, using the gateway container`
          );
          const route = {
            kind: "gateway" as const,
            opencode: { host: "127.0.0.1", port: 50_001 },
            relay: { host: "127.0.0.1", port: 50_002 },
            dial,
            closed: false,
            close: async () => {
              route.closed = true;
            },
          };
          routes.push(route);
          return route;
        }),
      };
      return { network, routes, dial };
    }

    it("reaches opencode and the relay through the route's addresses, and forwards with its dial", async () => {
      const { network, dial } = gatewayNetwork();
      const { store, runtime, relay, forwarder, hub, monitors } = setup(
        undefined,
        network
      );
      await hub.environments.rescan();
      await hub.environments.start(project.id);
      expect(network.route).toHaveBeenCalledWith(
        { id: "c1", ip: "172.17.0.9", network: undefined },
        expect.any(Function)
      );
      expect(relay.ensureRunning.mock.calls[0][1].address).toStrictEqual({
        host: "127.0.0.1",
        port: 50_002,
      });
      expect(runtime.ensureRunning.mock.calls[0][1]).toMatchObject({
        address: { host: "127.0.0.1", port: 50_001 },
      });
      const token = store.runtime(project.id).relayToken!;
      expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
        host: "172.17.0.9",
        dial,
        relay: { host: "127.0.0.1", port: 50_002, token },
      });
      expect(hub.environments.opencodeAddress(project.id)).toStrictEqual({
        host: "127.0.0.1",
        port: 50_001,
      });
      expect(monitors[0].opts.client).toBeDefined();
      expect(hub.environments.logLines(project.id)).toContain(
        "network: container IP 172.17.0.9 is not reachable from this machine, using the gateway container"
      );
      expect(store.runtime(project.id)).toMatchObject({
        containerState: "running",
        opencode: "healthy",
      });
    });

    it("starts sessions through the route's opencode address", async () => {
      const { network } = gatewayNetwork();
      const { hub, client, clientFor } = setup(undefined, network);
      await hub.environments.rescan();
      await hub.environments.start(project.id);
      await hub.sessions.startSession(project.id, "/workspaces/demo");
      expect(clientFor).toHaveBeenLastCalledWith({
        baseUrl: "http://127.0.0.1:50001",
        password: "pw",
      });
      expect(client.createSession).toHaveBeenCalled();
    });

    it("passes the container's network to the route", async () => {
      const { network } = gatewayNetwork();
      const { containers, hub } = setup(undefined, network);
      containers.inspect.mockResolvedValue({
        ...running,
        network: "demo_default",
      });
      await hub.environments.rescan();
      await hub.environments.start(project.id);
      expect(network.route.mock.calls[0][0]).toEqual({
        id: "c1",
        ip: "172.17.0.9",
        network: "demo_default",
      });
    });

    it("forwards with the dial alone when the relay is unavailable", async () => {
      const { network, dial } = gatewayNetwork();
      const { relay, forwarder, hub } = setup(undefined, network);
      relay.ensureRunning.mockResolvedValueOnce({
        status: "unavailable",
        reason: "no relay runtime",
      });
      await hub.environments.rescan();
      await hub.environments.start(project.id);
      expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
        host: "172.17.0.9",
        dial,
      });
    });

    it("closes the route on stop, on rebuild and on shutdown", async () => {
      const { network, routes } = gatewayNetwork();
      const { hub } = setup(undefined, network);
      await hub.environments.rescan();
      await hub.environments.start(project.id);
      await hub.environments.rebuild(project.id);
      expect(routes.map((r) => r.closed)).toStrictEqual([true, false]);
      await hub.environments.stop(project.id);
      expect(routes[1].closed).toBeTruthy();
      expect(hub.environments.opencodeAddress(project.id)).toBeUndefined();
      await hub.environments.start(project.id);
      await hub.environments.shutdown();
      expect(routes[2].closed).toBeTruthy();
    });

    it("closes the route when the container stops outside opendevhub", async () => {
      const { network, routes } = gatewayNetwork();
      const { containers, hub } = setup(undefined, network);
      await hub.environments.rescan();
      await hub.environments.start(project.id);
      containers.inspect.mockResolvedValueOnce({ ...running, running: false });
      await hub.environments.refreshContainers();
      expect(routes[0].closed).toBeTruthy();
    });

    it("fails start, with the container still running, when the gateway cannot be set up", async () => {
      const { network } = gatewayNetwork();
      network.route.mockRejectedValueOnce(
        new CommandError("docker run failed for the gateway container", [
          "pull access denied",
        ])
      );
      const { store, runtime, hub } = setup(undefined, network);
      await hub.environments.rescan();
      await hub.environments.start(project.id);
      expect(store.runtime(project.id)).toMatchObject({
        containerState: "running",
        opencode: "unhealthy",
        error: "docker run failed for the gateway container",
      });
      expect(hub.environments.logLines(project.id)).toContain(
        "pull access denied"
      );
      expect(runtime.ensureRunning).not.toHaveBeenCalled();
    });

    it("adopt checks health through the route and keeps adopting when one route fails", async () => {
      const { network } = gatewayNetwork();
      const other: Project = {
        ...project,
        id: "other-000000",
        name: "other",
        path: "/src/other",
      };
      const { store, containers, runtime, hub } = setup(
        {
          projects: {
            [project.id]: { password: "pw" },
            [other.id]: { password: "pw" },
          },
        },
        network,
        [project, other]
      );
      network.route.mockRejectedValueOnce(new Error("gateway down"));
      containers.listManaged.mockResolvedValueOnce([
        running,
        { ...running, id: "c2", projectId: other.id },
      ]);
      await hub.environments.rescan();
      await hub.environments.adopt();
      expect(store.runtime(project.id)).toMatchObject({
        containerState: "running",
        error: "gateway down",
      });
      expect(runtime.isHealthy).toHaveBeenCalledWith({
        baseUrl: "http://127.0.0.1:50001",
        password: "pw",
      });
      expect(store.runtime(other.id)).toMatchObject({
        containerState: "running",
        opencode: "healthy",
      });
    });
  });
});

describe("task environments", () => {
  it("retains the ticket in isolated task sessions too", async () => {
    const s = await withWorktree();
    const jira = {
      key: "APP-12",
      instanceUrl: "https://jira.example.com",
      title: "Fix login",
      description: "Safari login must succeed.",
    };
    const result = await s.hub.tasks.createTask(project.id, {
      prompt: "Fix login",
      jira,
      environment: "isolated",
      variants: [{}],
    });
    expect(result.variants[0].envId).toBeDefined();
    expect(s.client.createSession.mock.calls[0][1]?.metadata).toBeUndefined();
    expect(s.tasks.bySession(result.variants[0].sessionId ?? "")).toMatchObject(
      {
        task: { id: result.task, jira },
        variant: { envId: result.variants[0].envId, n: 1 },
      }
    );
  });

  it("starts each variant of an isolated task in its own container", async () => {
    const s = await withWorktree();
    const r = await s.hub.tasks.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      where: "worktree",
      environment: "isolated",
      variants: [{}, {}],
    });
    expect(r.variants.map((v) => v.branch)).toStrictEqual(["iso-1", "iso-2"]);
    expect(r.variants.every((v) => v.envId && v.sessionId && !v.error)).toBe(
      true
    );
    expect(new Set(r.variants.map((v) => v.envId)).size).toBe(2);
    expect(s.images.ensureBase).toHaveBeenCalledTimes(2);
    expect(
      s.client.createSession.mock.calls.map((c) => c[0]).sort()
    ).toStrictEqual([
      "/workspaces/demo.worktrees/iso-1",
      "/workspaces/demo.worktrees/iso-2",
    ]);
    expect(
      s.store
        .environments(project.id)
        .map((e) => e.worktree.branch)
        .sort()
    ).toStrictEqual(["iso-1", "iso-2"]);
  });

  it("brings task containers up one at a time (concurrent devcontainer up calls race in the CLI)", async () => {
    const s = await withWorktree();
    let active = 0;
    let most = 0;
    const plain = s.containers.up.getMockImplementation()!;
    s.containers.up.mockImplementation(async (t, o) => {
      if (!t.idLabels) {
        return plain(t, o);
      }
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return plain(t, o);
    });
    const r = await s.hub.tasks.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      environment: "isolated",
      variants: [{}, {}, {}],
    });
    expect(r.variants.every((v) => v.envId && !v.error)).toBeTruthy();
    expect(most).toBe(1);
  });

  it("uses the project's default when the task doesn't choose", async () => {
    const s = setup();
    s.projectSettings.mockReturnValue({ isolation: "isolated" });
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    const r = await s.hub.tasks.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      variants: [{}],
    });
    expect(r.variants[0].envId).toBeDefined();
    const shared = await s.hub.tasks.createTask(project.id, {
      prompt: "Do it",
      title: "Sh",
      environment: "shared",
      variants: [{}],
    });
    expect(shared.variants[0].envId).toBeUndefined();
  });

  it("runs an isolated task shared, and says why, when the project can't isolate", async () => {
    const s = setup();
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: { appPort: 1 },
    });
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    const r = await s.hub.tasks.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      environment: "isolated",
      variants: [{}],
    });
    expect(r.variants[0]).toMatchObject({
      sessionId: "ses_new",
      notice: expect.stringMatching(/shared container: appPort/u),
    });
    expect(r.variants[0].envId).toBeUndefined();
  });

  it("keeps the worktree of a variant whose container didn't start", async () => {
    const s = await withWorktree();
    s.images.ensureBase.mockRejectedValueOnce(
      new CommandError("devcontainer build failed: boom")
    );
    const r = await s.hub.tasks.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      environment: "isolated",
      variants: [{}],
    });
    expect(r.variants[0].error).toMatch(
      /its container did not start: devcontainer build failed: boom/u
    );
    expect(r.variants[0].directory).toBe("/workspaces/demo.worktrees/iso");
    expect(s.worktrees.remove).not.toHaveBeenCalled();
  });

  it("removes a worktree's container before the worktree, and keeps the worktree when that fails", async () => {
    const { hub, containers, worktrees, store, envId } = await withEnv();
    containers.remove.mockRejectedValueOnce(
      new CommandError("docker rm failed: busy")
    );
    await expect(
      hub.checkouts.removeWorktree(project.id, feat.path, false)
    ).rejects.toThrow(/kept the worktree/u);
    expect(worktrees.remove).not.toHaveBeenCalled();
    await hub.checkouts.removeWorktree(project.id, feat.path, false);
    expect(containers.remove.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      worktrees.remove.mock.invocationCallOrder[0]
    );
    expect(store.environment(envId)).toBeUndefined();
  });

  it("Pick removes a discarded variant's container with its worktree", async () => {
    const { hub, store, containers, envId, tasks } = await withEnv();
    tasks.createTask({
      createdAt: 1,
      id: "tsk_1",
      projectId: project.id,
      prompt: "T",
      title: "T",
      variants: [{}, {}],
    });
    tasks.attachSession(
      "tsk_1",
      1,
      {
        directory: "/workspaces/demo",
        envId: project.id,
        sessionId: "ses_keep",
      },
      SYSTEM
    );
    tasks.updateVariant("tsk_1", 2, { branch: "feat" }, SYSTEM);
    tasks.attachSession(
      "tsk_1",
      2,
      { directory: feat.path, envId, sessionId: "ses_drop" },
      SYSTEM
    );
    store.setSessions(project.id, [
      {
        id: "ses_keep",
        projectId: project.id,
        title: "T",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    store.setSessions(envId, [
      {
        id: "ses_drop",
        projectId: project.id,
        envId,
        title: "T",
        directory: feat.path,
        updatedAt: 1,
        status: "idle",
      },
    ]);
    const r = await hub.tasks.pickVariant(
      project.id,
      "tsk_1",
      "ses_keep",
      true
    );
    // The listing found `feat` before the task used it, so its branch isn't the task's to delete.
    expect(r).toStrictEqual({
      discarded: ["ses_drop"],
      removed: [feat.path],
      errors: ["feat: kept — not created by this task"],
    });
    expect(containers.remove).toHaveBeenCalledWith("c2");
    expect(store.environment(envId)).toBeUndefined();
  });

  it("gives a worktree its own container from the base image", async () => {
    const {
      hub,
      store,
      containers,
      images,
      envFiles,
      runtime,
      forwarder,
      monitors,
      envId,
    } = await withEnv();
    expect(envId).toBe(featEnv);
    expect(store.environment(envId)).toMatchObject({
      projectId: project.id,
      worktree: feat,
      image: { ref: `opendevhub/${project.id}:kkkkkkkkkkkk-base` },
    });
    expect(images.ensureBase.mock.calls[0].slice(0, 3)).toStrictEqual([
      project,
      feat,
      [],
    ]);
    expect(containers.readConfig).toHaveBeenCalledWith(feat.hostPath);
    const written = envFiles.write.mock.calls[0][1];
    expect(written).toMatchObject({
      image: `opendevhub/${project.id}:kkkkkkkkkkkk-base`,
      workspaceFolder: feat.path,
      mounts: ["type=bind,source=/src/demo/.git,target=/workspaces/demo/.git"],
    });
    expect(written).not.toHaveProperty("postCreateCommand");
    expect(containers.up.mock.calls.at(-1)![0]).toStrictEqual({
      id: envId,
      path: feat.hostPath,
      idLabels: [
        `opendevhub.env=${envId}`,
        `opendevhub.env-project=${project.id}`,
      ],
      overrideConfig: `/state/envs/${envId}/devcontainer.json`,
    });
    expect(containers.up.mock.calls.at(-1)![1].mounts).toStrictEqual([
      `type=volume,source=opendevhub-opencode-${envId},target=/opendevhub/opencode`,
    ]);
    expect(containers.ensureVolume).toHaveBeenCalledWith(
      `opendevhub-opencode-${envId}`,
      [
        "opendevhub.volume=opencode",
        `opendevhub.env=${envId}`,
        `opendevhub.env-project=${project.id}`,
      ]
    );
    expect(runtime.ensureRunning.mock.calls.at(-1)![1]).toMatchObject({
      address: { host: "172.17.0.10", port: 4096 },
      containerId: "c2",
      workspaceFolder: feat.path,
    });
    expect(forwarder.open.mock.calls.at(-1)![0]).toBe(envId);
    expect(monitors.at(-1)!.opts).toMatchObject({
      envId,
      projectId: project.id,
      directory: feat.path,
    });
    expect(monitors.at(-1)!.opts.extraDirectories).toBeUndefined();
    expect(hub.environments.opencodeAddress(envId)).toStrictEqual({
      host: "172.17.0.10",
      port: 4096,
    });
    expect(store.runtime(project.id).containerId).toBe("c1");
  });

  it("keeps listing sessions the project's opencode ran in a worktree before it got its own container", async () => {
    const { monitors } = await withEnv();
    expect(monitors[0].opts.extraDirectories!()).toStrictEqual([feat.path]);
  });

  it("records why a worktree's config can't get its own container", async () => {
    const s = await withWorktree();
    s.containers.readConfig.mockResolvedValueOnce({
      configuration: { dockerComposeFile: "c.yml" },
      workspaceFolder: "/workspaces/feat",
    });
    const { envId } = await s.hub.environments.createEnv(project.id, feat.path);
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).containerState).toBe("error")
    );
    expect(s.store.runtime(envId).error).toMatch(/Docker Compose/u);
    expect(s.containers.up).toHaveBeenCalledOnce();
  });

  it("refuses its own container when the project's config can't run one per worktree", async () => {
    const s = setup();
    s.worktrees.list.mockResolvedValue([feat]);
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: { appPort: 3000 },
    });
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    expect(s.store.isolation(project.id)).toStrictEqual({
      default: "shared",
      unsupported: expect.stringMatching(/appPort/u),
    });
    await expect(
      s.hub.environments.createEnv(project.id, feat.path)
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("reads the isolation default from devcontainer.json, with config.json taking precedence", async () => {
    const s = setup();
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: {
        customizations: { opendevhub: { isolation: "isolated" } },
      },
    });
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    expect(s.store.isolation(project.id)).toStrictEqual({
      default: "isolated",
    });
    s.projectSettings.mockReturnValue({ isolation: "shared" });
    await s.hub.environments.rebuild(project.id);
    expect(s.store.isolation(project.id)).toStrictEqual({ default: "shared" });
  });

  it("only gives known worktrees in the mounted folder their own container, while the project runs", async () => {
    const s = await withWorktree();
    await expect(
      s.hub.environments.createEnv(project.id, "/elsewhere")
    ).rejects.toBeInstanceOf(InvalidRequestError);
    s.store.updateRuntime(project.id, {
      worktrees: [{ path: "/tmp/wt", branch: "x" }],
    });
    await expect(
      s.hub.environments.createEnv(project.id, "/tmp/wt")
    ).rejects.toThrow(/mounted worktrees folder/u);
    await s.hub.environments.stop(project.id);
    await expect(
      s.hub.environments.createEnv(project.id, feat.path)
    ).rejects.toBeInstanceOf(UnavailableError);
  });

  it("stops a task container on its own, and together with the project", async () => {
    const { hub, store, containers, envId } = await withEnv();
    store.setSessions(envId, [
      {
        id: "t",
        projectId: project.id,
        envId,
        title: "t",
        directory: feat.path,
        updatedAt: 1,
        status: "idle",
      },
    ]);
    await hub.environments.stopEnv(project.id, envId);
    expect(containers.stop).toHaveBeenCalledWith("c2");
    expect(store.runtime(envId).containerState).toBe("stopped");
    expect(store.sessionsOf(project.id).map((s) => s.id)).not.toContain("t");
    expect(store.runtime(project.id).containerState).toBe("running");
    await hub.environments.startEnv(project.id, envId);
    expect(store.runtime(envId).opencode).toBe("healthy");
    containers.stop.mockClear();
    await hub.environments.stop(project.id);
    expect(containers.stop.mock.calls.map((c) => c[0])).toStrictEqual([
      "c2",
      "c1",
    ]);
    expect(store.runtime(envId).containerState).toBe("stopped");
  });

  it("removes a task container, the image the CLI left for it, its config and its record", async () => {
    const { hub, store, containers, envFiles, envId } = await withEnv();
    containers.remove.mockRejectedValueOnce(
      new CommandError("docker rm failed: busy")
    );
    await expect(hub.environments.removeEnv(project.id, envId)).rejects.toThrow(
      /busy/u
    );
    expect(store.environment(envId)).toBeDefined();
    await hub.environments.removeEnv(project.id, envId);
    expect(containers.remove).toHaveBeenLastCalledWith("c2");
    expect(containers.removeImage).toHaveBeenCalledWith("vsc-feat-1234-uid");
    expect(containers.removeVolume).toHaveBeenCalledWith(
      `opendevhub-opencode-${envId}`
    );
    expect(envFiles.remove).toHaveBeenCalledWith(envId);
    expect(store.environment(envId)).toBeUndefined();
    expect(hub.environments.opencodeAddress(envId)).toBeUndefined();
  });

  it("re-adopts running task containers after a restart and ignores ones it has no record of", async () => {
    const s = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
      environments: {
        [featEnv]: {
          projectId: project.id,
          worktree: feat,
          containerId: "c2",
          password: "pw",
        },
      },
    });
    const stray: ContainerInfo = {
      ...runningTask,
      id: "c3",
      name: "stray",
      envId: "demo-abc123-old-ffff",
    };
    s.containers.listManaged.mockResolvedValueOnce([
      running,
      runningTask,
      stray,
    ]);
    await s.hub.environments.rescan();
    await s.hub.environments.adopt();
    expect(s.store.runtime(project.id)).toMatchObject({
      containerId: "c1",
      opencode: "healthy",
    });
    expect(s.store.runtime(featEnv)).toMatchObject({
      containerId: "c2",
      containerState: "running",
      opencode: "healthy",
    });
    expect(s.monitors.map((m) => m.opts.envId)).toStrictEqual([
      project.id,
      featEnv,
    ]);
    expect(
      s.hub.environments
        .logLines(project.id)
        .some((l) => l.includes("ignoring container stray"))
    ).toBeTruthy();
    expect(s.store.environments(project.id)).toHaveLength(1);
    expect(s.store.runtime("demo-abc123-old-ffff").containerId).toBeUndefined();
  });

  it("notices a task container stopped outside opendevhub", async () => {
    const { hub, store, containers, envId } = await withEnv();
    containers.inspect.mockImplementation(async (id?: string) =>
      id === "c2" ? { ...runningTask, running: false } : running
    );
    await hub.environments.refreshContainers();
    expect(store.runtime(envId).containerState).toBe("stopped");
    expect(store.runtime(project.id).containerState).toBe("running");
  });

  it("sends a worktree's sessions and replies to its own opencode", async () => {
    const { hub, store, clientFor, client, envId } = await withEnv();
    clientFor.mockClear();
    await hub.sessions.startSession(project.id, feat.path);
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.10:4096");
    clientFor.mockClear();
    await hub.sessions.startSession(project.id, "/workspaces/demo");
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.9:4096");
    store.setSessions(envId, [
      {
        ...waiting({ permissions: [permission], forms: [] }),
        envId,
        directory: feat.path,
      },
    ]);
    clientFor.mockClear();
    await hub.sessions.replyPermission(project.id, "per_1", {
      decision: "once",
    });
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.10:4096");
    expect(client.replyPermission).toHaveBeenCalled();
    await hub.environments.stopEnv(project.id, envId);
    await expect(
      hub.sessions.startSession(project.id, feat.path)
    ).rejects.toThrow(/container is not running/u);
  });
});

describe("git and ssh credentials", () => {
  it("prepares credentials and the agent tunnel after the relay and before opencode", async () => {
    const { store, hub, relay, credentials, agentTunnel, tunnels, runtime } =
      setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    const token = store.runtime(project.id).relayToken!;
    expect(credentials.prepare).toHaveBeenCalledWith(
      project,
      "/src/demo",
      expect.objectContaining({ sshAgent: true })
    );
    expect(agentTunnel).toHaveBeenCalledWith(
      { host: "172.17.0.9", port: 4097, token },
      expect.anything()
    );
    expect(tunnels[0].start).toHaveBeenCalled();
    expect(relay.ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(
      credentials.prepare.mock.invocationCallOrder[0]
    );
    expect(credentials.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.ensureRunning.mock.invocationCallOrder[0]
    );
    expect(runtime.ensureRunning.mock.calls[0][1].env).toStrictEqual({
      SSH_AUTH_SOCK: "/tmp/opendevhub-ssh-agent.sock",
    });
  });

  it("shows the tunnel's status on the runtime", async () => {
    const { store, hub, tunnels } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    tunnels[0].opts.onStatus({ state: "forwarded" });
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "forwarded",
      sshAgentReason: undefined,
    });
    tunnels[0].opts.onStatus({
      state: "unavailable",
      reason: "SSH_AUTH_SOCK is not set on this machine",
    });
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "unavailable",
      sshAgentReason: "SSH_AUTH_SOCK is not set on this machine",
    });
  });

  it("leaves the agent out when the project turns it off", async () => {
    const { store, hub, credentials, agentTunnel, runtime, projectSettings } =
      setup();
    projectSettings.mockReturnValue({ sshAgent: false });
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(credentials.prepare).toHaveBeenCalledWith(
      project,
      "/src/demo",
      expect.objectContaining({ sshAgent: false })
    );
    expect(agentTunnel).not.toHaveBeenCalled();
    expect(store.runtime(project.id).sshAgent).toBe("off");
    expect(runtime.ensureRunning.mock.calls[0][1].env).toBeUndefined();
  });

  it("reports the agent unavailable without a relay", async () => {
    const { store, hub, relay, agentTunnel } = setup();
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "no relay runtime",
    });
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(agentTunnel).not.toHaveBeenCalled();
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "unavailable",
      sshAgentReason: "relay not running",
    });
    expect(hub.environments.logLines(project.id)).toContain(
      "ssh-agent: unavailable (relay not running)"
    );
  });

  it("still starts when preparing credentials fails", async () => {
    const { store, hub, credentials } = setup();
    credentials.prepare.mockRejectedValueOnce(new Error("boom"));
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      opencode: "healthy",
      error: undefined,
    });
    expect(hub.environments.logLines(project.id)).toContain(
      "credentials: boom"
    );
  });

  it("stops the tunnel and clears the status when the container stops", async () => {
    const { store, hub, tunnels } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    tunnels[0].opts.onStatus({ state: "forwarded" });
    await hub.environments.stop(project.id);
    expect(tunnels[0].stop).toHaveBeenCalled();
    expect(store.runtime(project.id).sshAgent).toBeUndefined();
  });

  it("stops every tunnel on shutdown", async () => {
    const { hub, tunnels } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    await hub.environments.shutdown();
    expect(tunnels[0].stop).toHaveBeenCalled();
  });

  it("gives an adopted running container a tunnel too", async () => {
    const { hub, containers, agentTunnel, credentials } = setup({
      projects: { [project.id]: { password: "pw", relayToken: "kept" } },
    });
    containers.listManaged.mockResolvedValue([running]);
    await hub.environments.rescan();
    await hub.environments.adopt();
    expect(credentials.prepare).toHaveBeenCalledOnce();
    expect(agentTunnel).toHaveBeenCalledWith(
      { host: "172.17.0.9", port: 4097, token: "kept" },
      expect.anything()
    );
  });

  it("gives a task container its own tunnel, with its own token", async () => {
    const s = await withEnv();
    expect(s.agentTunnel).toHaveBeenCalledTimes(2);
    const [main, task] = s.tunnels;
    expect(task.target.host).toBe("172.17.0.10");
    expect(task.target.token).not.toBe(main.target.token);
    expect(s.credentials.prepare.mock.calls[1][0]).toMatchObject({
      id: s.envId,
    });
  });

  it("honours sshAgent: false in a task container's own configuration, whatever the main one said", async () => {
    const s = setup();
    s.worktrees.list.mockResolvedValue([feat]);
    s.containers.readConfiguration.mockImplementation(
      async (t?: ExecTarget) => ({
        forwardPorts: [],
        portsAttributes: {},
        configuration: t?.idLabels
          ? { customizations: { opendevhub: { sshAgent: false } } }
          : undefined,
      })
    );
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    const { envId } = await s.hub.environments.createEnv(project.id, feat.path);
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).opencode).toBe("healthy")
    );
    expect(s.agentTunnel).toHaveBeenCalledOnce();
    expect(s.store.runtime(envId).sshAgent).toBe("off");
    expect(s.credentials.prepare.mock.calls[1][2].sshAgent).toBeFalsy();
    expect(s.runtime.ensureRunning.mock.calls[1][1].env).toBeUndefined();
  });

  it("asks for relay recovery when the tunnel loses the relay", async () => {
    const { hub, relay, tunnels } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    tunnels[0].opts.onRelayLost?.();
    await vi.waitFor(() =>
      expect(relay.ensureRunning).toHaveBeenCalledTimes(2)
    );
  });
});

describe("environments on another node", () => {
  it("keep their sessions out of cleanup's removed-worktree list", async () => {
    const { hub, client, clock } = await withRemoteRunning();
    client.sessions.mockResolvedValue([
      {
        id: "ses_r",
        time: { created: 1, updated: clock.now },
        location: { directory: remoteFix.path },
      },
    ]);
    const scan = await hub.cleanupTargets.cleanupSessionScan(project.id);
    expect(scan.items.filter((i) => i.sessionId === "ses_r")).toStrictEqual([]);
  });

  it("review and commit with git in their own container", async () => {
    const { hub, box } = await withRemoteRunning();
    const data = await hub.reviews.review(project.id, remoteFix.path);
    expect(data).toMatchObject({ branch: "fix", ahead: 3 });
    expect(box.kit.git.currentBranch.mock.calls[0][0]).toMatchObject({
      id: remoteEnv,
      path: remoteFix.hostPath,
    });
    box.kit.git.isClean.mockResolvedValueOnce(false);
    await hub.reviews.commit(project.id, remoteFix.path, "fix: login");
    expect(box.kit.git.commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: remoteEnv }),
      remoteFix.path,
      "fix: login"
    );
  });

  it("update from the base after pushing it again", async () => {
    const { hub, box } = await withRemoteRunning();
    box.kit.repo.pushBase.mockClear();
    await hub.reviews.updateFromBase(project.id, remoteFix.path, "main");
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(
      project,
      box.layout(project, "/workspaces/demo"),
      "main"
    );
    expect(box.kit.git.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: remoteEnv }),
      remoteFix.path,
      "main",
      "rebase"
    );
  });

  it("bring their branch home", async () => {
    const { hub, box } = await withRemoteRunning();
    await expect(
      hub.checkouts.bringHome(project.id, remoteFix.path)
    ).resolves.toStrictEqual({
      branch: "fix",
    });
    expect(box.kit.repo.bringHome).toHaveBeenCalledWith(
      project,
      box.layout(project, "/workspaces/demo"),
      "fix"
    );
    await expect(
      hub.checkouts.bringHome(project.id, "/workspaces/demo")
    ).rejects.toThrow(/on this machine already/u);
  });

  it("merge into the base after bringing the branch home", async () => {
    const { hub, box, git } = await withRemoteRunning();
    await expect(
      hub.reviews.mergeIntoBase(project.id, remoteFix.path, "main", true)
    ).resolves.toStrictEqual({ branch: "fix" });
    expect(box.kit.repo.bringHome).toHaveBeenCalled();
    expect(git.mergeInto).toHaveBeenCalledWith(
      project,
      "/workspaces/demo",
      "fix",
      true
    );
    expect(box.kit.repo.bringHome.mock.invocationCallOrder[0]).toBeLessThan(
      git.mergeInto.mock.invocationCallOrder[0]
    );
  });

  it("publish from the main checkout after bringing the branch home", async () => {
    const { hub, box, publisher, checkouts } = await withRemoteRunning();
    const main = { container: "/workspaces/demo", host: project.path };
    await hub.reviews.publishInfo(project.id, remoteFix.path);
    expect(publisher.info).toHaveBeenCalledWith(
      project,
      main,
      "fix",
      undefined
    );
    await hub.reviews.publish(project.id, remoteFix.path, {
      remote: "origin",
      base: "main",
      strategy: "branch",
      title: "Fix",
      description: "",
    });
    expect(box.kit.repo.bringHome).toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledWith(
      project,
      main,
      "fix",
      expect.objectContaining({ remote: "origin" }),
      undefined
    );
    expect(checkouts.branch(project.id, "fix")).toMatchObject({
      publishedRemote: "origin",
    });
  });

  it("don't run checks or open editors yet", async () => {
    const { hub, editors } = await withRemoteRunning();
    expect(
      hub.checkouts.checkTarget(project.id, remoteFix.path).unavailable
    ).toBe("checks don't run on other nodes yet");
    expect(() =>
      hub.checkouts.openInEditor(project.id, "code", remoteFix.path)
    ).toThrow(/isn't available for environments on other nodes/u);
    expect(editors.open).not.toHaveBeenCalled();
  });

  it("are removed with their worktree and branch on the node", async () => {
    const { hub, store, box } = await withRemoteRunning();
    await hub.environments.removeEnv(project.id, remoteEnv);
    expect(box.kit.containers.remove).toHaveBeenCalledWith("r1");
    expect(box.kit.envFiles.remove).toHaveBeenCalledWith(remoteEnv);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalledWith(
      box.layout(project, "/workspaces/demo"),
      remoteFix
    );
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  it("keep their record when the node's worktree won't go", async () => {
    const { hub, store, box } = await withRemoteRunning();
    box.kit.repo.removeWorktree.mockRejectedValueOnce(
      new CommandError("removing worktree fix on box failed: busy")
    );
    await expect(
      hub.environments.removeEnv(project.id, remoteEnv)
    ).rejects.toThrow(/busy/u);
    expect(store.environment(remoteEnv)).toBeDefined();
  });

  it("are removed as worktrees, even while the project's container is stopped", async () => {
    const { hub, store, box, worktrees } = await withRemoteRunning();
    await hub.environments.stop(project.id);
    store.updateRuntime(project.id, { containerState: "stopped" });
    box.kit.repo.removeWorktree.mockClear();
    await hub.checkouts.removeWorktree(project.id, remoteFix.path, false);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalled();
    expect(worktrees.remove).not.toHaveBeenCalled();
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  it("are removed when another variant is picked", async () => {
    const { hub, store, box, tasks } = await withRemoteRunning();
    const local = {
      ...waiting({ permissions: [], forms: [] }),
      id: "ses_keep",
      status: "idle" as const,
      directory: "/workspaces/demo",
    };
    const remote = {
      ...local,
      id: "ses_r",
      envId: remoteEnv,
      directory: remoteFix.path,
    };
    tasks.createTask({
      createdAt: 1,
      id: "tsk_1",
      projectId: project.id,
      prompt: "t",
      title: "t",
      variants: [{}, { node: "box" }],
    });
    tasks.attachSession(
      "tsk_1",
      1,
      { directory: local.directory, envId: project.id, sessionId: "ses_keep" },
      SYSTEM
    );
    tasks.updateVariant("tsk_1", 2, { branch: "fix" }, SYSTEM);
    tasks.attachSession(
      "tsk_1",
      2,
      { directory: remote.directory, envId: remoteEnv, sessionId: "ses_r" },
      SYSTEM
    );
    store.setSessions(project.id, [local]);
    store.setSessions(remoteEnv, [remote]);
    const result = await hub.tasks.pickVariant(
      project.id,
      "tsk_1",
      "ses_keep",
      true
    );
    expect(result.removed).toEqual([remoteFix.path]);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalled();
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  async function remoteTask(body: Record<string, unknown> = {}) {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    const result = await s.hub.tasks.createTask(project.id, {
      prompt: "Fix login",
      environment: "isolated",
      node: "box",
      ...body,
    });
    return { ...s, box, result };
  }

  it("place a task: push the base, worktree on the node, environment there", async () => {
    const { result, box, worktrees, store, client } = await remoteTask();
    const layout = box.layout(project, "/workspaces/demo");
    expect(box.kit.repo.ensure).toHaveBeenCalledWith(layout);
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(project, layout, "main");
    expect(box.kit.repo.addWorktree).toHaveBeenCalledWith(
      layout,
      "fix-login",
      "main"
    );
    expect(worktrees.add).not.toHaveBeenCalled();
    const v = result.variants[0];
    expect(v).toMatchObject({
      branch: "fix-login",
      directory: "/workspaces/demo.worktrees/fix-login",
      sessionId: "ses_new",
    });
    expect(store.environment(v.envId!)).toMatchObject({
      node: "box",
      worktree: { branch: "fix-login" },
    });
    expect(v.envId).toBe(
      envIdFor(
        project.id,
        "box:/workspaces/demo.worktrees/fix-login",
        "fix-login"
      )
    );
    expect(client.createSession).toHaveBeenCalledWith(
      "/workspaces/demo.worktrees/fix-login",
      expect.anything()
    );
    expect(box.kit.containers.up).toHaveBeenCalled();
  });

  it("avoid branch names the node already has, and use the requested base", async () => {
    const box = boxKit();
    box.kit.repo.branches.mockResolvedValue(["fix-login"]);
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    const result = await s.hub.tasks.createTask(project.id, {
      prompt: "Fix login",
      environment: "isolated",
      node: "box",
      base: "origin/main",
    });
    expect(result.variants[0].branch).not.toBe("fix-login");
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(
      project,
      expect.anything(),
      "origin/main"
    );
  });

  it("say when the main checkout's uncommitted changes stay behind", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.git.isClean.mockResolvedValue(false);
    const result = await s.hub.tasks.createTask(project.id, {
      prompt: "x",
      environment: "isolated",
      node: "box",
    });
    expect(result.variants[0].notice).toBe(
      "uncommitted changes in the main checkout are not on node box"
    );
  });

  it("refuse what can't run on a node", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    const task = (body: Record<string, unknown>) =>
      s.hub.tasks.createTask(project.id, { prompt: "x", ...body });
    await expect(task({ where: "workspace", node: "box" })).rejects.toThrow(
      InvalidRequestError
    );
    await expect(task({ environment: "shared", node: "box" })).rejects.toThrow(
      /needs a new worktree with its own container/u
    );
    await expect(
      task({ environment: "isolated", node: "nope" })
    ).rejects.toThrow("unknown node nope");
    s.git.currentBranch.mockResolvedValue(undefined);
    await expect(
      task({ environment: "isolated", node: "box" })
    ).rejects.toThrow(/detached HEAD/u);
    box.online.box = false;
    await expect(
      task({ environment: "isolated", node: "box" })
    ).rejects.toThrow("node box is unreachable");
    s.store.setIsolation(project.id, {
      default: "shared",
      unsupported: "host networking is not supported",
    });
    box.online.box = true;
    await expect(
      task({ environment: "isolated", node: "box" })
    ).rejects.toThrow(/can't run on another node: host networking/u);
  });

  it("accept their checkouts as known directories", async () => {
    const { hub, result } = await remoteTask();
    await expect(
      hub.reviews.review(project.id, result.variants[0].directory!)
    ).resolves.toMatchObject({ branch: "fix" });
  });

  it("keep a local worktree from taking a remote environment's path", async () => {
    const { hub } = await remoteTask();
    await expect(
      hub.checkouts.createWorktree(project.id, { branch: "fix-login" })
    ).rejects.toThrow(/used by a task on node box/u);
  });

  it("are parked when their node drops: watching stops, state and sessions stay", async () => {
    const { hub, store, monitors, forwarder, box } = await withRemoteRunning();
    const session = {
      ...waiting({ permissions: [], forms: [] }),
      id: "ses_r",
      envId: remoteEnv,
      directory: remoteFix.path,
      status: "idle" as const,
    };
    store.setSessions(remoteEnv, [session]);
    box.online.box = false;
    await hub.environments.nodeOffline("box");
    expect(monitors.find((m) => m.opts.envId === remoteEnv)?.stopped).toBe(
      true
    );
    expect(forwarder.close).toHaveBeenCalledWith(remoteEnv);
    expect(box.routes[0].close).toHaveBeenCalled();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
    expect(store.sessionsOf(project.id).map((s) => s.id)).toContain("ses_r");
    await expect(
      hub.sessions.promptSession(project.id, "ses_r", "hi")
    ).rejects.toThrow("node box is unreachable");
  });

  it("are adopted again when their node comes back", async () => {
    const { hub, store, monitors, box } = await withRemoteRunning();
    box.online.box = false;
    await hub.environments.nodeOffline("box");
    box.online.box = true;
    box.kit.containers.listManaged.mockResolvedValue([box.info]);
    await hub.environments.nodeOnline("box");
    expect(store.runtime(remoteEnv)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
    });
    expect(
      monitors.filter(
        (m) => m.opts.envId === remoteEnv && m.started && !m.stopped
      )
    ).toHaveLength(1);
  });

  it("are marked stopped when their container is gone after the node comes back", async () => {
    const { hub, store, box } = await withRemoteRunning();
    box.kit.containers.listManaged.mockResolvedValue([]);
    await hub.environments.nodeOnline("box");
    expect(store.runtime(remoteEnv).containerState).toBe("stopped");
  });

  it("are left alone by the refresh while offline, or when ssh fails", async () => {
    const { hub, store, box } = await withRemoteRunning();
    box.kit.containers.inspect.mockRejectedValueOnce(
      new CommandError("docker inspect could not run: ssh exited 255")
    );
    await hub.environments.refreshContainers();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
    box.online.box = false;
    box.kit.containers.inspect.mockClear();
    await hub.environments.refreshContainers();
    expect(box.kit.containers.inspect).not.toHaveBeenCalled();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("start with that node's tools, mounting the node's repository", async () => {
    const { hub, store, containers, images, box } = await withRemote();
    await hub.environments.startEnv(project.id, remoteEnv);
    expect(box.kit.images.ensureBase).toHaveBeenCalledWith(
      project,
      remoteFix,
      [],
      expect.any(Function),
      false
    );
    expect(images.ensureBase).not.toHaveBeenCalled();
    expect(box.kit.containers.readConfig).toHaveBeenCalledWith(
      remoteFix.hostPath
    );
    const config = box.kit.envFiles.write.mock.calls[0][1];
    expect(config.mounts).toContain(
      `type=bind,source=/home/tim/.opendevhub/repos/${project.id}/demo/.git,target=/workspaces/demo/.git`
    );
    expect(box.kit.containers.up).toHaveBeenCalledWith(
      {
        id: remoteEnv,
        path: remoteFix.hostPath,
        idLabels: envLabels(remoteEnv, project.id),
        overrideConfig: `/home/tim/.opendevhub/envs/${remoteEnv}/devcontainer.json`,
      },
      expect.anything()
    );
    expect(containers.up).toHaveBeenCalledOnce();
    expect(box.kit.network.route).toHaveBeenCalled();
    expect(box.kit.runtime.ensureRunning).toHaveBeenCalled();
    expect(store.runtime(remoteEnv)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "r1",
    });
  });

  it("start while the project's own container is stopped", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.hub.environments.rescan();
    s.store.putEnvironment({
      id: remoteEnv,
      projectId: project.id,
      worktree: remoteFix,
      node: "box",
    });
    await s.hub.environments.startEnv(project.id, remoteEnv);
    expect(s.store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("fail with 'node box is unreachable' while it's offline, without touching their state", async () => {
    const { hub, store, box } = await withRemoteRunning();
    box.online.box = false;
    expect(() => hub.environments.stopEnv(project.id, remoteEnv)).toThrow(
      UnavailableError
    );
    expect(() => hub.environments.startEnv(project.id, remoteEnv)).toThrow(
      "node box is unreachable"
    );
    expect(store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("are skipped when the project stops while their node is offline", async () => {
    const { hub, store, box } = await withRemoteRunning();
    box.online.box = false;
    await hub.environments.stop(project.id);
    expect(store.runtime(project.id).containerState).toBe("stopped");
    expect(box.kit.containers.stop).not.toHaveBeenCalled();
  });
});
