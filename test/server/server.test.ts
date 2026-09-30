import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProxyTarget } from "../../src/server/proxy";
import { startServer } from "../../src/server/server";

let upstream: http.Server;
let upstreamPort: number;
let server: Awaited<ReturnType<typeof startServer>>;
let targets: Record<string, ProxyTarget>;

function get(port: number, host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  upstream = http.createServer((req, res) => res.end(`upstream ${req.headers.authorization}`));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  targets = { "demo-abc123": { host: "127.0.0.1", port: upstreamPort, password: "pw" } };
  const app = new Hono().get("/api/ping", (c) => c.text("pong"));
  server = await startServer({ port: 0, app, resolveTarget: (id) => targets[id] });
});
afterEach(async () => {
  await server.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
});

describe("startServer", () => {
  it("routes the dashboard host to the Hono app", async () => {
    expect(await get(server.port, `localhost:${server.port}`, "/api/ping")).toEqual({ status: 200, body: "pong" });
    expect(server.url).toBe(`http://localhost:${server.port}/`);
  });

  it("proxies project subdomains with injected auth", async () => {
    const res = await get(server.port, `Demo-ABC123.localhost:${server.port}`, "/");
    expect(res.body).toBe(`upstream Basic ${Buffer.from("opencode:pw").toString("base64")}`);
  });

  it("returns 503 for unknown or stopped projects", async () => {
    expect((await get(server.port, `other-000000.localhost:${server.port}`, "/")).status).toBe(503);
  });

  it("rejects foreign hosts with 421 (DNS rebinding)", async () => {
    expect((await get(server.port, `evil.example:${server.port}`, "/api/ping")).status).toBe(421);
  });
});
