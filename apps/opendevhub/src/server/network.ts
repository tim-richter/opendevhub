import net from "node:net";
import type { Duplex } from "node:stream";

import type { Host } from "./host";
import { OPENCODE_PORT } from "./opencode/runtime";
import { RELAY_PORT } from "./relay/runtime";

export interface HostPort {
  host: string;
  port: number;
}

/** Opens a stream to a port of the container. */
export type Dial = (port: number) => Promise<Duplex>;

/**
 * How the host reaches one container. `direct` connects to the container's IP (Linux with a native
 * Docker engine); `gateway` goes through the gateway container's published port (Docker Desktop,
 * Colima, rootless Docker, ...), with loopback tunnels for opencode and the relay.
 */
export interface Route {
  kind: "direct" | "gateway" | "ssh";
  opencode: HostPort;
  relay: HostPort;
  /** Set on the gateway and ssh routes; the direct route connects to the container IP itself. */
  dial?: Dial;
  close: () => Promise<void>;
}

export interface RouteContainer {
  id: string;
  ip: string;
  /** Docker network `ip` belongs to; the gateway joins it. */
  network?: string;
}

export interface GatewayPort {
  attach: (
    container: RouteContainer,
    onLog: (line: string) => void
  ) => Promise<void>;
  connect: (ip: string, port: number) => Promise<net.Socket>;
}

export type RouteMode = "auto" | "direct" | "gateway";

export const parseRouteMode = (value: string | undefined): RouteMode => {
  if (value === undefined || value === "" || value === "auto") {
    return "auto";
  }
  if (value === "direct" || value === "gateway") {
    return value;
  }
  throw new Error(
    `invalid OPENDEVHUB_ROUTE: ${value} (expected auto, direct or gateway)`
  );
};

export const directRoute = (ip: string): Route => ({
  close: () => Promise.resolve(),
  kind: "direct",
  opencode: { host: ip, port: OPENCODE_PORT },
  relay: { host: ip, port: RELAY_PORT },
});

/**
 * True when `ip` is routable from this machine. Nothing may listen on `port` yet, so on Linux a
 * refused connection counts as reachable: the container's kernel answered. Elsewhere the container
 * IP sits behind a VM and a refusal more likely comes from a firewall or VPN, so only an accepted
 * connection counts (OrbStack users can set OPENDEVHUB_ROUTE=direct).
 */
export const probeReachable = (
  ip: string,
  port: number,
  timeoutMs = 500,
  refusedIsReachable = process.platform === "linux"
): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (reachable: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(refusedIsReachable && err.code === "ECONNREFUSED")
    );
  });

export interface Tunnel {
  address: HostPort;
  close: () => Promise<void>;
}

/** Listens on a free 127.0.0.1 port and pipes each connection to a socket from `dial`. */
export const openTunnel = async (
  dial: () => Promise<Duplex>
): Promise<Tunnel> => {
  const sockets = new Set<Duplex>();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    client.pause();
    sockets.add(client);
    client.on("error", () => client.destroy());
    client.on("close", () => sockets.delete(client));
    dial().then(
      (upstream) => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        sockets.add(upstream);
        const close = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(upstream);
        };
        upstream.on("error", close);
        upstream.on("close", close);
        client.on("close", close);
        client.pipe(upstream);
        upstream.pipe(client);
      },
      () => client.destroy()
    );
  });
  server.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    address: { host: "127.0.0.1", port },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) {
          s.destroy();
        }
        server.close(() => resolve());
      }),
  };
};

/** Loopback tunnels for opencode and the relay, each connection through `dial`. */
export const tunnelRoute = async (
  kind: "gateway" | "ssh",
  dial: Dial
): Promise<Route> => {
  const opencode = await openTunnel(() => dial(OPENCODE_PORT));
  const relay = await openTunnel(() => dial(RELAY_PORT)).catch(
    async (error: unknown) => {
      await opencode.close();
      throw error;
    }
  );
  return {
    close: async () => {
      await Promise.all([opencode.close(), relay.close()]);
    },
    dial,
    kind,
    opencode: opencode.address,
    relay: relay.address,
  };
};

/** A container on another node: every connection is an ssh channel opened from that node. */
export const sshRoute = (
  host: Pick<Host, "dial">,
  ip: string
): Promise<Route> => tunnelRoute("ssh", (port) => host.dial(ip, port));

export interface NetworkDeps {
  gateway: GatewayPort;
  mode?: RouteMode;
  probe?: (ip: string, port: number) => Promise<boolean>;
}

export class Network {
  constructor(private readonly deps: NetworkDeps) {}

  async route(
    container: RouteContainer,
    onLog: (line: string) => void
  ): Promise<Route> {
    const mode = this.deps.mode ?? "auto";
    if (mode === "direct") {
      return directRoute(container.ip);
    }
    if (mode === "auto") {
      if (await (this.deps.probe ?? probeReachable)(container.ip, RELAY_PORT)) {
        return directRoute(container.ip);
      }
      onLog(
        `network: container IP ${container.ip} is not reachable from this machine, using the gateway container`
      );
    }
    const { gateway } = this.deps;
    await gateway.attach(container, onLog);
    return tunnelRoute("gateway", (port) =>
      gateway.connect(container.ip, port)
    );
  }
}
