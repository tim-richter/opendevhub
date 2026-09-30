import net from "node:net";
import type { ForwardedPort } from "../shared/types";
import type { PortSpec } from "./ports";
import { RelayError, openRelayConnection } from "./relay/client";

export interface ForwardEvents {
  /** Called whenever a connection finds the relay unreachable and falls back to the direct route. */
  onRelayUnreachable?: () => void;
}

export interface ForwardTarget {
  host: string;
  relay?: { port: number; token: string };
}

interface Forward {
  servers: net.Server[];
  sockets: Set<net.Socket>;
}

export interface PortForwarderOptions {
  /** Defaults to 127.0.0.1, in which case ::1 is bound too (browsers resolve `localhost` to ::1 first). */
  bindHost?: string;
  maxOffset?: number;
  logIntervalMs?: number;
}

function closeServers(servers: net.Server[]): Promise<void> {
  return Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))).then(() => {});
}

function listen(server: net.Server, port: number, host: string): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export class PortForwarder {
  private readonly forwards = new Map<string, Forward[]>();

  constructor(private readonly opts: PortForwarderOptions = {}) {}

  async open(
    projectId: string,
    target: ForwardTarget,
    ports: PortSpec[],
    onLog: (line: string) => void = () => {},
    events: ForwardEvents = {},
  ): Promise<ForwardedPort[]> {
    await this.close(projectId);
    const list: Forward[] = [];
    this.forwards.set(projectId, list);
    const results: ForwardedPort[] = [];
    for (const spec of ports) results.push(await this.openOne(spec, target, list, onLog, events));
    return results;
  }

  async close(projectId: string): Promise<void> {
    const list = this.forwards.get(projectId);
    if (!list) return;
    this.forwards.delete(projectId);
    await Promise.all(
      list.map(
        (f) =>
          new Promise<void>((resolve) => {
            for (const s of f.sockets) s.destroy();
            void closeServers(f.servers).then(resolve);
          }),
      ),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.forwards.keys()].map((id) => this.close(id)));
  }

  private async openOne(
    spec: PortSpec,
    target: ForwardTarget,
    list: Forward[],
    onLog: (line: string) => void,
    events: ForwardEvents,
  ): Promise<ForwardedPort> {
    const labelled = spec.label === undefined ? {} : { label: spec.label };
    const sockets = new Set<net.Socket>();
    const logIntervalMs = this.opts.logIntervalMs ?? 30_000;
    let lastLog = -Infinity;

    const logLimited = (line: string) => {
      const now = Date.now();
      if (now - lastLog >= logIntervalMs) {
        lastLog = now;
        onLog(line);
      }
    };

    const handleClient = (client: net.Socket) => {
      // Paused until an upstream is ready, so bytes sent before the relay answers are not lost.
      client.pause();
      sockets.add(client);
      let upstream: net.Socket | undefined;
      const destroy = () => {
        client.destroy();
        upstream?.destroy();
        sockets.delete(client);
        if (upstream) sockets.delete(upstream);
      };
      client.on("error", destroy);
      client.on("close", destroy);

      const pipe = (socket: net.Socket, rest?: Buffer) => {
        if (client.destroyed) {
          socket.destroy();
          return;
        }
        upstream = socket;
        sockets.add(socket);
        socket.on("error", destroy);
        socket.on("close", destroy);
        if (rest?.length) client.write(rest);
        client.pipe(socket);
        socket.pipe(client);
        client.resume();
        socket.resume();
      };

      const direct = () => {
        const socket = net.connect({ host: target.host, port: spec.containerPort, allowHalfOpen: true });
        const onConnectError = (err: NodeJS.ErrnoException) => {
          const hint =
            err.code === "ECONNREFUSED"
              ? " (is the app listening on 0.0.0.0 inside the container? apps bound to localhost there are not reachable)"
              : "";
          logLimited(`ports: ${spec.containerPort}: ${err.message}${hint}`);
          socket.destroy();
          destroy();
        };
        socket.once("error", onConnectError);
        socket.once("connect", () => {
          socket.off("error", onConnectError);
          pipe(socket);
        });
      };

      if (!target.relay) return direct();
      openRelayConnection({ host: target.host, ...target.relay }, spec.containerPort).then(
        ({ socket, rest }) => pipe(socket, rest),
        (err: Error) => {
          if (err instanceof RelayError) {
            logLimited(
              err.code === "ECONNREFUSED"
                ? `ports: ${spec.containerPort}: nothing is listening on port ${spec.containerPort} inside the container`
                : `ports: ${spec.containerPort}: relay could not connect (${err.code})`,
            );
            destroy();
            return;
          }
          if (client.destroyed) return;
          events.onRelayUnreachable?.();
          logLimited(`ports: ${spec.containerPort}: relay unreachable (${err.message}), connecting directly`);
          direct();
        },
      );
    };
    const newServer = () => net.createServer({ allowHalfOpen: true }, handleClient);

    const bindHost = this.opts.bindHost ?? "127.0.0.1";
    // ::1 is bound best-effort alongside the default: if another app holds the port there,
    // `localhost:<port>` would reach that app instead, so the port counts as taken.
    const extraHosts = this.opts.bindHost === undefined ? ["::1"] : [];
    const last = Math.min(65535, spec.containerPort + (this.opts.maxOffset ?? 100));
    for (let port = spec.containerPort; port <= last; port++) {
      const main = newServer();
      const err = await listen(main, port, bindHost);
      if (err?.code === "EADDRINUSE") continue;
      if (err) return { status: "failed", containerPort: spec.containerPort, ...labelled, reason: err.message };
      const servers = [main];
      let taken = false;
      for (const host of extraHosts) {
        const extra = newServer();
        const extraErr = await listen(extra, port, host);
        if (!extraErr) servers.push(extra);
        else if (extraErr.code === "EADDRINUSE") taken = true;
        // any other error (e.g. IPv6 disabled): serve IPv4 only
        if (taken) break;
      }
      if (taken) {
        await closeServers(servers);
        continue;
      }
      for (const server of servers) server.on("error", () => {});
      list.push({ servers, sockets });
      return { status: "forwarded", containerPort: spec.containerPort, ...labelled, hostPort: port };
    }
    return {
      status: "failed",
      containerPort: spec.containerPort,
      ...labelled,
      reason: `no free host port in ${spec.containerPort}–${last}`,
    };
  }
}
