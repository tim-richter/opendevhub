import path from "node:path";
import type { Project, ProjectId } from "../shared/types";
import { CommandError, type ContainerInfo, type Containers } from "./containers";
import { LogBuffer } from "./log-buffer";
import { Monitor, type MonitorOptions } from "./monitor";
import type { OpencodeClient, OpencodeEndpoint } from "./opencode/client";
import type { OpencodeRuntime } from "./opencode/runtime";
import type { StateStore } from "./state";

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

export type ContainersPort = Pick<Containers, "up" | "inspect" | "listManaged" | "stop">;
export type RuntimePort = Pick<OpencodeRuntime, "ensureRunning" | "stopServer" | "isHealthy" | "endpoint">;
export interface MonitorHandle {
  start(): void;
  stop(): void;
}

export interface OrchestratorDeps {
  store: StateStore;
  containers: ContainersPort;
  runtime: RuntimePort;
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

  constructor(private readonly deps: OrchestratorDeps) {}

  async rescan(): Promise<void> {
    this.deps.store.setProjects(await this.deps.scan(this.deps.roots()));
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
    return this.exclusive(id, (p) => {
      this.stopMonitor(p.id);
      return this.bringUp(p, true);
    });
  }

  restartOpencode(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      const rt = this.deps.store.runtime(p.id);
      if (rt.containerState !== "running" || !rt.containerIp) {
        this.fail(p.id, new Error("container is not running — start the project first"));
        return;
      }
      this.stopMonitor(p.id);
      this.deps.store.updateRuntime(p.id, { opencode: "starting", error: undefined });
      try {
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
      const rt = store.runtime(p.id);
      store.updateRuntime(p.id, { containerState: "stopping", error: undefined });
      try {
        if (rt.containerState === "running") await runtime.stopServer(p).catch(() => {});
        if (rt.containerId) await containers.stop(rt.containerId);
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
      const rt = store.runtime(id);
      if (info.ip && rt.password && (await runtime.isHealthy(runtime.endpoint(info.ip, rt.password)))) {
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
        store.updateRuntime(p.id, { containerState: "stopped", opencode: "absent", containerIp: undefined });
        store.setSessions(p.id, []);
      } catch {
        // One project's docker inspect failing shouldn't stop the others from refreshing.
      }
    }
  }

  shutdown(): void {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
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
      await this.launchOpencode(project, rebuild ? undefined : store.runtime(project.id).password);
    } catch (err) {
      this.fail(project.id, err);
    }
  }

  private async launchOpencode(project: Project, password: string | undefined): Promise<void> {
    const { store, runtime } = this.deps;
    const rt = store.runtime(project.id);
    const result = await runtime.ensureRunning(project, {
      ip: rt.containerIp!,
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

  private startMonitor(id: ProjectId): void {
    this.stopMonitor(id);
    const { store, runtime, clientFor } = this.deps;
    const project = store.project(id)!;
    const rt = store.runtime(id);
    const factory = this.deps.monitorFactory ?? ((opts: MonitorOptions) => new Monitor(opts));
    const monitor = factory({
      client: clientFor(runtime.endpoint(rt.containerIp!, rt.password!)),
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
