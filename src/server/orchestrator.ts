import path from "node:path";
import type { ForwardedPort, Project, ProjectId } from "../shared/types";
import { CommandError, type ContainerInfo, type Containers, type PortConfig } from "./containers";
import { LogBuffer } from "./log-buffer";
import { Monitor, type MonitorOptions } from "./monitor";
import { type HostPort, type Network, type Route, type RouteContainer, directRoute } from "./network";
import type { OpencodeClient, OpencodeEndpoint } from "./opencode/client";
import type { OpencodeRuntime } from "./opencode/runtime";
import type { ForwardTarget, PortForwarder } from "./port-forwarder";
import { parseForwardPorts } from "./ports";
import { type RelayRuntime, generateRelayToken } from "./relay/runtime";
import type { StateStore } from "./state";

const RELAY_RECOVERY_INTERVAL_MS = 30_000;

export class BusyError extends Error {
  constructor(id: string) {
    super(`another action is already running for ${id}`);
    this.name = "BusyError";
  }
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`unknown project ${id}`);
    this.name = "NotFoundError";
  }
}

export type ContainersPort = Pick<Containers, "up" | "inspect" | "listManaged" | "stop" | "readConfiguration">;
export type ForwarderPort = Pick<PortForwarder, "open" | "close" | "closeAll">;
export type RuntimePort = Pick<
  OpencodeRuntime,
  "ensureRunning" | "stopServer" | "isHealthy" | "endpoint" | "resolveBinary"
>;
export type RelayPort = Pick<RelayRuntime, "ensureRunning" | "stop">;
export type NetworkPort = Pick<Network, "route">;
export interface MonitorHandle {
  start(): void;
  stop(): void;
}

export interface OrchestratorDeps {
  store: StateStore;
  containers: ContainersPort;
  runtime: RuntimePort;
  forwarder: ForwarderPort;
  relay: RelayPort;
  /** Defaults to connecting to container IPs directly. */
  network?: NetworkPort;
  clientFor: (ep: OpencodeEndpoint) => OpencodeClient;
  roots: () => string[];
  scan: (roots: string[]) => Promise<Project[]>;
  monitorFactory?: (opts: MonitorOptions) => MonitorHandle;
}

export class Orchestrator {
  private readonly busy = new Set<ProjectId>();
  private readonly monitors = new Map<ProjectId, MonitorHandle>();
  private readonly logs = new Map<ProjectId, LogBuffer>();
  private readonly logListeners = new Set<(projectId: ProjectId, line: string) => void>();
  private readonly relayRecoveries = new Map<ProjectId, number>();
  private readonly routes = new Map<ProjectId, Route>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async rescan(): Promise<void> {
    this.deps.store.setProjects(await this.deps.scan(this.deps.roots()));
  }

  /** Where the host reaches the project's opencode server, while its container runs. */
  opencodeAddress(id: ProjectId): HostPort | undefined {
    return this.routes.get(id)?.opencode;
  }

  logLines(id: ProjectId): string[] {
    return this.logs.get(id)?.lines() ?? [];
  }

  onLog(fn: (projectId: ProjectId, line: string) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  start(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => this.bringUp(p, false));
  }

  rebuild(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      this.stopMonitor(p.id);
      await this.closePorts(p.id);
      await this.bringUp(p, true);
    });
  }

  restartOpencode(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      const rt = this.deps.store.runtime(p.id);
      const route = this.routes.get(p.id);
      if (rt.containerState !== "running" || !rt.containerIp || !route) {
        this.fail(p.id, new Error("container is not running — start the project first"));
        return;
      }
      this.stopMonitor(p.id);
      this.deps.store.updateRuntime(p.id, { opencode: "starting", error: undefined });
      try {
        const relayWasActive = rt.relay === "active";
        const target = await this.startRelay(p, rt.containerIp, route);
        if (target.relay && !relayWasActive) await this.forwardPorts(p, target);
        await this.launchOpencode(p, undefined);
      } catch (err) {
        this.fail(p.id, err);
      }
    });
  }

  stop(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      const { store, runtime, containers } = this.deps;
      this.stopMonitor(p.id);
      await this.closePorts(p.id);
      const rt = store.runtime(p.id);
      store.updateRuntime(p.id, { containerState: "stopping", error: undefined });
      try {
        if (rt.containerState === "running") {
          await runtime.stopServer(p).catch(() => {});
          await this.deps.relay.stop(p).catch(() => {});
        }
        if (rt.containerId) await containers.stop(rt.containerId);
        await this.closeRoute(p.id);
        store.updateRuntime(p.id, { containerState: "stopped", opencode: "absent", containerIp: undefined });
        store.setSessions(p.id, []);
      } catch (err) {
        this.fail(p.id, err);
      }
    });
  }

  async adopt(): Promise<void> {
    const { store, containers, runtime } = this.deps;
    let managed: ContainerInfo[];
    try {
      managed = await containers.listManaged();
    } catch {
      return;
    }
    for (const info of managed) {
      const id = info.projectId;
      if (!id || !store.project(id)) continue;
      if (!info.running) {
        store.updateRuntime(id, { containerId: info.id, containerState: "stopped", opencode: "absent" });
        continue;
      }
      store.updateRuntime(id, { containerId: info.id, containerIp: info.ip, containerState: "running" });
      const adopted = store.project(id)!;
      let route: Route | undefined;
      if (info.ip) {
        try {
          route = await this.openRoute(adopted, { id: info.id, ip: info.ip, network: info.network });
        } catch (err) {
          this.fail(id, err);
          continue;
        }
        await this.forwardPorts(adopted, await this.startRelay(adopted, info.ip, route));
      }
      const rt = store.runtime(id);
      if (route && rt.password && (await runtime.isHealthy(runtime.endpoint(route.opencode, rt.password)))) {
        store.updateRuntime(id, { opencode: "healthy", error: undefined });
        this.startMonitor(id);
      } else {
        store.updateRuntime(id, { opencode: "unhealthy", error: "opencode is not running — use Restart opencode" });
      }
    }
  }

  async refreshContainers(): Promise<void> {
    const { store, containers } = this.deps;
    for (const p of store.projects()) {
      const rt = store.runtime(p.id);
      if (this.busy.has(p.id) || rt.containerState !== "running" || !rt.containerId) continue;
      try {
        const info = await containers.inspect(rt.containerId);
        // A lifecycle action (start/stop/rebuild/...) may have started while inspect() was in
        // flight; if so it owns the project's state now, so don't race it with a stale write.
        if (this.busy.has(p.id)) continue;
        if (info?.running) continue;
        this.stopMonitor(p.id);
        await this.closePorts(p.id);
        await this.closeRoute(p.id);
        store.updateRuntime(p.id, { containerState: "stopped", opencode: "absent", containerIp: undefined });
        store.setSessions(p.id, []);
      } catch {
        // One project's docker inspect failing shouldn't stop the others from refreshing.
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
    await this.deps.forwarder.closeAll();
    await Promise.all([...this.routes.keys()].map((id) => this.closeRoute(id)));
  }

  private exclusive(id: ProjectId, fn: (project: Project) => Promise<void>): Promise<void> {
    const project = this.deps.store.project(id);
    if (!project) throw new NotFoundError(id);
    if (this.busy.has(id)) throw new BusyError(id);
    this.busy.add(id);
    return fn(project).finally(() => this.busy.delete(id));
  }

  private async bringUp(project: Project, rebuild: boolean): Promise<void> {
    const { store, containers } = this.deps;
    store.updateRuntime(project.id, { containerState: "starting", opencode: "absent", error: undefined });
    try {
      const up = await containers.up(project, { rebuild, onLine: (l) => this.log(project.id, l) });
      // Record the container id as soon as `up` succeeds, before the running/IP checks below can
      // throw — otherwise a container that came up but failed those checks has no containerId on
      // record, and Stop has nothing to stop.
      store.updateRuntime(project.id, { containerId: up.containerId });
      const info = await containers.inspect(up.containerId);
      if (!info?.running) throw new CommandError("container is not running after devcontainer up");
      if (!info.ip) {
        throw new CommandError("container has no bridge network IP (host networking is not supported)");
      }
      store.updateRuntime(project.id, {
        containerId: up.containerId,
        containerIp: info.ip,
        workspaceFolder: up.remoteWorkspaceFolder,
        containerState: "running",
        opencode: "starting",
      });
      const route = await this.openRoute(project, { id: up.containerId, ip: info.ip, network: info.network });
      await this.forwardPorts(project, await this.startRelay(project, info.ip, route));
      await this.launchOpencode(project, rebuild ? undefined : store.runtime(project.id).password);
    } catch (err) {
      this.fail(project.id, err);
    }
  }

  private async launchOpencode(project: Project, password: string | undefined): Promise<void> {
    const { store, runtime } = this.deps;
    const route = this.routes.get(project.id);
    if (!route) throw new Error("container is not running — start the project first");
    const result = await runtime.ensureRunning(project, {
      address: route.opencode,
      password,
      workspaceFolder: this.workspaceFolder(project),
      onLine: (l) => this.log(project.id, l),
    });
    store.updateRuntime(project.id, {
      password: result.password,
      opencodeVersion: result.version,
      opencode: "healthy",
      error: undefined,
    });
    this.startMonitor(project.id);
  }

  private workspaceFolder(project: Project): string {
    return this.deps.store.runtime(project.id).workspaceFolder ?? `/workspaces/${path.basename(project.path)}`;
  }

  private async forwardPorts(project: Project, target: ForwardTarget): Promise<void> {
    const { store, containers, forwarder } = this.deps;
    let config: PortConfig;
    try {
      config = await containers.readConfiguration(project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(project.id, `ports: could not read devcontainer configuration: ${message}`);
      store.updateRuntime(project.id, { ports: [] });
      return;
    }
    const { ports, skipped } = parseForwardPorts(config.forwardPorts, config.portsAttributes);
    for (const s of skipped) this.log(project.id, `ports: skipped ${s.entry} (${s.reason})`);
    const opened = await forwarder.open(project.id, target, ports, (line) => this.log(project.id, line), {
      onRelayUnreachable: () => void this.recoverRelay(project.id),
    });
    for (const f of opened) {
      if (f.status === "forwarded") this.log(project.id, `ports: ${f.containerPort} → localhost:${f.hostPort}`);
      else if (f.status === "failed") this.log(project.id, `ports: ${f.containerPort} not forwarded (${f.reason})`);
    }
    const skippedPorts: ForwardedPort[] = skipped.map((s) => ({ status: "skipped", entry: s.entry, reason: s.reason }));
    store.updateRuntime(project.id, { ports: [...opened, ...skippedPorts] });
  }

  private async openRoute(project: Project, container: RouteContainer): Promise<Route> {
    await this.closeRoute(project.id);
    const network = this.deps.network ?? { route: async (c: RouteContainer) => directRoute(c.ip) };
    const route = await network.route(container, (line) => this.log(project.id, line));
    this.routes.set(project.id, route);
    return route;
  }

  private async closeRoute(id: ProjectId): Promise<void> {
    const route = this.routes.get(id);
    this.routes.delete(id);
    await route?.close();
  }

  private async startRelay(project: Project, ip: string, route: Route): Promise<ForwardTarget> {
    const { store, runtime, relay } = this.deps;
    let token = store.runtime(project.id).relayToken;
    if (!token) {
      token = generateRelayToken();
      store.updateRuntime(project.id, { relayToken: token });
    }
    const binary = await runtime.resolveBinary(project).catch(() => undefined);
    const result = await relay.ensureRunning(project, { address: route.relay, token, binary });
    const direct: ForwardTarget = route.dial ? { host: ip, dial: route.dial } : { host: ip };
    if (result.status === "active") {
      this.log(project.id, `relay: active (${result.via})`);
      store.updateRuntime(project.id, { relay: "active" });
      return { ...direct, relay: { ...route.relay, token } };
    }
    this.log(project.id, `relay: unavailable (${result.reason})`);
    store.updateRuntime(project.id, { relay: "unavailable" });
    return direct;
  }

  /** A forwarded connection found the relay gone: mark it and relaunch in the background (at most every 30 s). */
  private async recoverRelay(id: ProjectId): Promise<void> {
    const now = Date.now();
    if (now - (this.relayRecoveries.get(id) ?? -Infinity) < RELAY_RECOVERY_INTERVAL_MS) return;
    this.relayRecoveries.set(id, now);
    const { store } = this.deps;
    const project = store.project(id);
    const rt = store.runtime(id);
    const route = this.routes.get(id);
    if (!project || this.busy.has(id) || rt.containerState !== "running" || !rt.containerIp || !route) return;
    store.updateRuntime(id, { relay: "unavailable" });
    this.log(id, "relay: unreachable, relaunching");
    await this.startRelay(project, rt.containerIp, route).catch(() => {});
  }

  private async closePorts(id: ProjectId): Promise<void> {
    await this.deps.forwarder.close(id);
    this.deps.store.updateRuntime(id, { ports: undefined, relay: undefined });
  }

  private startMonitor(id: ProjectId): void {
    this.stopMonitor(id);
    const { store, runtime, clientFor } = this.deps;
    const project = store.project(id)!;
    const rt = store.runtime(id);
    const factory = this.deps.monitorFactory ?? ((opts: MonitorOptions) => new Monitor(opts));
    const monitor = factory({
      client: clientFor(runtime.endpoint(this.routes.get(id)!.opencode, rt.password!)),
      projectId: id,
      directory: this.workspaceFolder(project),
      onSessions: (sessions) => store.setSessions(id, sessions),
      onHealth: (healthy) => {
        if (store.runtime(id).opencode === "starting") return;
        store.updateRuntime(id, { opencode: healthy ? "healthy" : "unhealthy" });
      },
    });
    this.monitors.set(id, monitor);
    monitor.start();
  }

  private stopMonitor(id: ProjectId): void {
    this.monitors.get(id)?.stop();
    this.monitors.delete(id);
  }

  private log(id: ProjectId, line: string): void {
    let buffer = this.logs.get(id);
    if (!buffer) {
      buffer = new LogBuffer();
      this.logs.set(id, buffer);
    }
    buffer.push(line);
    for (const fn of this.logListeners) fn(id, line);
  }

  private fail(id: ProjectId, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CommandError) for (const line of err.tail) this.log(id, line);
    this.log(id, `error: ${message}`);
    const containerUp = this.deps.store.runtime(id).containerState === "running";
    this.deps.store.updateRuntime(id, {
      containerState: containerUp ? "running" : "error",
      opencode: containerUp ? "unhealthy" : "absent",
      error: message,
    });
  }
}
