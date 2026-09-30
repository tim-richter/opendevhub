import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PortForwarder } from "../../src/server/port-forwarder";
import type { ForwardedPort } from "../../src/shared/types";

const servers: net.Server[] = [];
let forwarder: PortForwarder;

afterEach(async () => {
  await forwarder?.closeAll();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

/** Echo server on 127.0.0.2 that prefixes replies, so we know which upstream answered. */
async function echoUpstream(prefix = "echo:"): Promise<number> {
  const server = net.createServer((s) => s.on("data", (d) => s.write(prefix + d.toString())));
  servers.push(server);
  return listen(server, 0, "127.0.0.2");
}

async function blocker(port: number): Promise<void> {
  const server = net.createServer();
  servers.push(server);
  await listen(server, port, "127.0.0.1");
}

function roundTrip(port: number, message: string, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => socket.write(message));
    socket.once("data", (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

function closedOrReset(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

const hostPort = (p: ForwardedPort) => (p.status === "forwarded" ? p.hostPort : -1);

describe("PortForwarder", () => {
  it("forwards the same port number and pipes bytes both ways", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    const [result] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port, label: "web" }]);
    expect(result).toEqual({ status: "forwarded", containerPort: port, label: "web", hostPort: port });
    expect(await roundTrip(port, "hi")).toBe("echo:hi");
  });

  it("moves to the next free port when the host port is taken", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    await blocker(port);
    const [result] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    expect(result.status).toBe("forwarded");
    expect(hostPort(result)).toBeGreaterThan(port);
    expect(await roundTrip(hostPort(result), "x")).toBe("echo:x");
  });

  it("gives a second project with the same port the next free port", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    const [a] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    const [b] = await forwarder.open("p2", "127.0.0.2", [{ containerPort: port }]);
    expect(hostPort(a)).toBe(port);
    expect(hostPort(b)).toBeGreaterThan(port);
  });

  it("also listens on ::1, so http://localhost:<port> reaches the forward", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    const [result] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    expect(hostPort(result)).toBe(port);
    expect(await roundTrip(port, "v6", "::1")).toBe("echo:v6");
  });

  it("treats a port held by another app on ::1 as taken", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    const hostApp = net.createServer();
    servers.push(hostApp);
    await listen(hostApp, port, "::1");
    const [result] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    expect(hostPort(result)).toBeGreaterThan(port);
    expect(await roundTrip(hostPort(result), "x", "::1")).toBe("echo:x");
  });

  it("reports failed when no candidate is free", async () => {
    forwarder = new PortForwarder({ maxOffset: 0 });
    const port = await echoUpstream();
    await blocker(port);
    const [result] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    expect(result).toEqual({ status: "failed", containerPort: port, reason: `no free host port in ${port}–${port}` });
  });

  it("reports non-EADDRINUSE listen errors as failed without trying more ports", async () => {
    forwarder = new PortForwarder({ bindHost: "192.0.2.1" });
    const [result] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: 45123 }]);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toMatch(/EADDRNOTAVAIL/);
  });

  it("survives an upstream that is not listening yet and logs once", async () => {
    forwarder = new PortForwarder({ logIntervalMs: 60_000 });
    const probe = net.createServer();
    const port = await listen(probe, 0, "127.0.0.2");
    await new Promise((r) => probe.close(r));
    const logs: string[] = [];
    const [result] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }], (l) => logs.push(l));
    await closedOrReset(hostPort(result));
    await closedOrReset(hostPort(result));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(new RegExp(`^ports: ${port}: `));
    expect(logs[0]).toMatch(/is the app listening on 0\.0\.0\.0/);
    const upstream = net.createServer((s) => s.on("data", (d) => s.write("late:" + d.toString())));
    servers.push(upstream);
    await listen(upstream, port, "127.0.0.2");
    expect(await roundTrip(hostPort(result), "x")).toBe("late:x");
  });

  it("close frees the port and ends open connections; reopening gets the same port", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    const ended = new Promise((r) => socket.once("close", r));
    await forwarder.close("p1");
    await ended;
    await closedOrReset(port);
    const [again] = await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    expect(hostPort(again)).toBe(port);
  });

  it("open replaces a project's previous forwards", async () => {
    forwarder = new PortForwarder();
    const first = await echoUpstream("one:");
    const second = await echoUpstream("two:");
    await forwarder.open("p1", "127.0.0.2", [{ containerPort: first }]);
    await forwarder.open("p1", "127.0.0.2", [{ containerPort: second }]);
    await closedOrReset(first);
    expect(await roundTrip(second, "x")).toBe("two:x");
  });
});
