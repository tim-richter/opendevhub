import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayError } from "../../../src/server/network/relay/client";
import { RELAY_PORT } from "../../../src/server/network/relay/runtime";
import {
  Network,
  directRoute,
  openTunnel,
  parseRouteMode,
  probeReachable,
  sshRoute,
} from "../../../src/server/network/routes";
import type { GatewayPort, Route } from "../../../src/server/network/routes";
import { OPENCODE_PORT } from "../../../src/server/opencode/runtime";
import { freePort } from "../../helpers/relay";

const servers: net.Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r)))
  );
});

async function echo(prefix = "echo:"): Promise<number> {
  const server = net.createServer((s) =>
    s.on("data", (d) => s.write(prefix + d.toString()))
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(message));
    socket.once("data", (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

function closed(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

const connectLocal = (port: number) =>
  new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });

describe(parseRouteMode, () => {
  it.each([
    [undefined, "auto"],
    ["", "auto"],
    ["auto", "auto"],
    ["direct", "direct"],
    ["gateway", "gateway"],
  ])("%j -> %s", (input, expected) =>
    expect(parseRouteMode(input)).toBe(expected)
  );

  it("rejects anything else", () => {
    expect(() => parseRouteMode("bridge")).toThrow(/OPENDEVHUB_ROUTE/u);
  });
});

describe(directRoute, () => {
  it("reaches opencode and the relay on the container IP", async () => {
    const route = directRoute("172.17.0.9");
    expect(route).toMatchObject({
      kind: "direct",
      opencode: { host: "172.17.0.9", port: 4096 },
      relay: { host: "172.17.0.9", port: 4097 },
    });
    expect(route.dial).toBeUndefined();
  });
});

describe(probeReachable, () => {
  it("is true when something listens", async () => {
    await expect(
      probeReachable("127.0.0.1", await echo())
    ).resolves.toBeTruthy();
  });

  it("counts a refused connection as reachable only when asked to (the Linux default)", async () => {
    const port = await freePort();
    await expect(probeReachable("127.0.0.1", port, 500, true)).resolves.toBe(
      true
    );
    await expect(probeReachable("127.0.0.1", port, 500, false)).resolves.toBe(
      false
    );
  });
});

describe(openTunnel, () => {
  it("pipes each connection to a dialed socket", async () => {
    const upstream = await echo("up:");
    const tunnel = await openTunnel(() => connectLocal(upstream));
    closers.push(tunnel.close);
    expect(tunnel.address.host).toBe("127.0.0.1");
    await expect(roundTrip(tunnel.address.port, "a")).resolves.toBe("up:a");
    await expect(roundTrip(tunnel.address.port, "b")).resolves.toBe("up:b");
  });

  it("does not lose bytes sent before the dial completes", async () => {
    const upstream = await echo("late:");
    const tunnel = await openTunnel(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return connectLocal(upstream);
    });
    closers.push(tunnel.close);
    await expect(roundTrip(tunnel.address.port, "early")).resolves.toBe(
      "late:early"
    );
  });

  it("closes the client when the dial fails", async () => {
    const tunnel = await openTunnel(() =>
      Promise.reject(new RelayError("ECONNREFUSED"))
    );
    closers.push(tunnel.close);
    await closed(tunnel.address.port);
  });

  it("stops listening on close", async () => {
    const tunnel = await openTunnel(() => connectLocal(1));
    await tunnel.close();
    await expect(roundTrip(tunnel.address.port, "x")).rejects.toThrow();
  });
});

describe("Network.route", () => {
  function fakeGateway(): GatewayPort & {
    attach: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  } {
    return {
      attach: vi.fn(async () => {}),
      // Stands in for the gateway: "container ports" are local ports.
      connect: vi.fn(async (_ip: string, port: number) => connectLocal(port)),
    };
  }
  const container = { id: "c1", ip: "172.17.0.9", network: "bridge" };
  const track = (route: Route) => {
    closers.push(route.close);
    return route;
  };

  it("auto: goes direct when the container IP is reachable", async () => {
    const gateway = fakeGateway();
    const probe = vi.fn(async () => true);
    const route = await new Network({ gateway, probe }).route(
      container,
      () => {}
    );
    expect(route.kind).toBe("direct");
    expect(probe).toHaveBeenCalledWith("172.17.0.9", 4097);
    expect(gateway.attach).not.toHaveBeenCalled();
  });

  it("auto: uses the gateway when the container IP is not reachable, and says so", async () => {
    const gateway = fakeGateway();
    const logs: string[] = [];
    const route = track(
      await new Network({ gateway, probe: async () => false }).route(
        container,
        (l) => logs.push(l)
      )
    );
    expect(route.kind).toBe("gateway");
    expect(gateway.attach).toHaveBeenCalledWith(
      container,
      expect.any(Function)
    );
    expect(logs).toStrictEqual([
      "network: container IP 172.17.0.9 is not reachable from this machine, using the gateway container",
    ]);
  });

  it("direct: never probes or touches the gateway", async () => {
    const gateway = fakeGateway();
    const probe = vi.fn(async () => false);
    const route = await new Network({ gateway, probe, mode: "direct" }).route(
      container,
      () => {}
    );
    expect(route).toMatchObject({
      kind: "direct",
      opencode: { host: "172.17.0.9", port: 4096 },
    });
    expect(probe).not.toHaveBeenCalled();
    expect(gateway.attach).not.toHaveBeenCalled();
  });

  it("gateway: tunnels opencode and the relay through the gateway, and dials other ports", async () => {
    const gateway = fakeGateway();
    const probe = vi.fn(async () => true);
    const route = track(
      await new Network({ gateway, probe, mode: "gateway" }).route(
        container,
        () => {}
      )
    );
    expect(probe).not.toHaveBeenCalled();
    expect(route.opencode.host).toBe("127.0.0.1");
    expect(route.relay.host).toBe("127.0.0.1");
    expect(route.opencode.port).not.toBe(route.relay.port);

    // A connection to the opencode tunnel asks the gateway for <ip>:4096.
    await closed(route.opencode.port);
    expect(gateway.connect).toHaveBeenCalledWith("172.17.0.9", 4096);
    await closed(route.relay.port);
    expect(gateway.connect).toHaveBeenCalledWith("172.17.0.9", 4097);

    const app = await echo("app:");
    const socket = await route.dial!(app);
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(d.toString()));
      socket.write("x");
    });
    socket.destroy();
    expect(reply).toBe("app:x");
    expect(gateway.connect).toHaveBeenCalledWith("172.17.0.9", app);
  });

  it("gateway: close stops the tunnels", async () => {
    const route = await new Network({
      gateway: fakeGateway(),
      mode: "gateway",
    }).route(container, () => {});
    await route.close();
    await expect(roundTrip(route.opencode.port, "x")).rejects.toThrow();
  });

  it("gateway: fails when the gateway cannot be started", async () => {
    const gateway = fakeGateway();
    gateway.attach.mockRejectedValueOnce(new Error("docker run failed"));
    await expect(
      new Network({ gateway, mode: "gateway" }).route(container, () => {})
    ).rejects.toThrow("docker run failed");
  });
});
describe(sshRoute, () => {
  it("tunnels opencode and the relay through the host's dial to the container IP", async () => {
    const opencodeUp = await echo("oc:");
    const relayUp = await echo("relay:");
    const dials: [string, number][] = [];
    // Stands in for a node: container ports map to local echo servers.
    const host = {
      dial: async (ip: string, port: number) => {
        dials.push([ip, port]);
        return connectLocal(port === OPENCODE_PORT ? opencodeUp : relayUp);
      },
    };
    const route = await sshRoute(host, "172.18.0.4");
    closers.push(route.close);
    expect(route.kind).toBe("ssh");
    expect(route.opencode.host).toBe("127.0.0.1");
    await expect(roundTrip(route.opencode.port, "a")).resolves.toBe("oc:a");
    await expect(roundTrip(route.relay.port, "b")).resolves.toBe("relay:b");
    expect(dials).toStrictEqual([
      ["172.18.0.4", OPENCODE_PORT],
      ["172.18.0.4", RELAY_PORT],
    ]);
    expect(route.dial).toBeDefined();
    await route.dial!(8080).then((s) => s.destroy());
    expect(dials.at(-1)).toStrictEqual(["172.18.0.4", 8080]);
  });

  it("stops listening on close", async () => {
    const route = await sshRoute({ dial: () => connectLocal(1) }, "172.18.0.4");
    await route.close();
    await expect(roundTrip(route.opencode.port, "x")).rejects.toThrow();
  });
});
