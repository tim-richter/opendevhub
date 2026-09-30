import net from "node:net";
import type { ForwardedPort } from "../shared/types";
import type { PortSpec } from "./ports";

interface Forward {
  server: net.Server;
  sockets: Set<net.Socket>;
}

export interface PortForwarderOptions {
  bindHost?: string;
  maxOffset?: number;
  logIntervalMs?: number;
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
    targetHost: string,
    ports: PortSpec[],
    onLog: (line: string) => void = () => {},
  ): Promise<ForwardedPort[]> {
    await this.close(projectId);
    const list: Forward[] = [];
    this.forwards.set(projectId, list);
    const results: ForwardedPort[] = [];
    for (const spec of ports) results.push(await this.openOne(spec, targetHost, list, onLog));
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
            f.server.close(() => resolve());
          }),
      ),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.forwards.keys()].map((id) => this.close(id)));
  }

  private async openOne(
    spec: PortSpec,
    targetHost: string,
    list: Forward[],
    onLog: (line: string) => void,
  ): Promise<ForwardedPort> {
    const labelled = spec.label === undefined ? {} : { label: spec.label };
    const sockets = new Set<net.Socket>();
    const logIntervalMs = this.opts.logIntervalMs ?? 30_000;
    let lastLog = -Infinity;

    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      const upstream = net.connect({ host: targetHost, port: spec.containerPort, allowHalfOpen: true });
      sockets.add(client);
      sockets.add(upstream);
      const destroy = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", destroy);
      client.on("close", destroy);
      upstream.on("error", (err) => {
        const now = Date.now();
        if (now - lastLog >= logIntervalMs) {
          lastLog = now;
          onLog(`ports: ${spec.containerPort}: ${err.message}`);
        }
        destroy();
      });
      upstream.on("close", destroy);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    const bindHost = this.opts.bindHost ?? "127.0.0.1";
    const last = Math.min(65535, spec.containerPort + (this.opts.maxOffset ?? 100));
    for (let port = spec.containerPort; port <= last; port++) {
      const err = await listen(server, port, bindHost);
      if (!err) {
        server.on("error", () => {});
        list.push({ server, sockets });
        return { status: "forwarded", containerPort: spec.containerPort, ...labelled, hostPort: port };
      }
      if (err.code !== "EADDRINUSE") {
        return { status: "failed", containerPort: spec.containerPort, ...labelled, reason: err.message };
      }
    }
    return {
      status: "failed",
      containerPort: spec.containerPort,
      ...labelled,
      reason: `no free host port in ${spec.containerPort}–${last}`,
    };
  }
}
