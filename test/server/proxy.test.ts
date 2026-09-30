import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { basicAuth } from "../../src/server/opencode/client";
import { type ProxyTarget, proxyRequest, proxyUpgrade } from "../../src/server/proxy";

let upstream: http.Server;
let proxy: http.Server;
let target: ProxyTarget | undefined;
let proxyUrl: string;
let sseRes: http.ServerResponse | undefined;

const listen = (s: http.Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

beforeEach(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ host: req.headers.host, authorization: req.headers.authorization, origin: req.headers.origin }));
    } else if (req.url === "/challenge") {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Secure Area"' });
      res.end("nope");
    } else if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      sseRes = res;
    } else if (req.url === "/upload") {
      let n = 0;
      req.on("data", (c: Buffer) => (n += c.length));
      req.on("end", () => res.end(String(n)));
    } else if (req.url === "/xfo") {
      res.writeHead(200, { "x-frame-options": "ALLOW-FROM http://evil.example" });
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => {
    ws.send(`auth:${req.headers.authorization}`);
    ws.on("message", (m) => ws.send(`echo:${m.toString()}`));
  });
  const upstreamPort = await listen(upstream);
  target = { host: "127.0.0.1", port: upstreamPort, password: "pw" };
  const resolve = () => target;
  proxy = http.createServer((req, res) => proxyRequest(req, res, "demo", resolve, "http://localhost:7777/"));
  proxy.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, "demo", resolve));
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

afterEach(async () => {
  sseRes?.end();
  sseRes = undefined;
  for (const s of [proxy, upstream]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

describe("proxyRequest", () => {
  it("injects basic auth and rewrites host and origin", async () => {
    const res = await fetch(`${proxyUrl}/echo`, { headers: { authorization: "Bearer user-token", origin: proxyUrl } });
    const body = await res.json();
    expect(body).toEqual({
      host: `127.0.0.1:${target!.port}`,
      authorization: basicAuth("pw"),
      origin: `http://127.0.0.1:${target!.port}`,
    });
  });

  it("allows same-origin POST requests (Origin matches Host)", async () => {
    const res = await fetch(`${proxyUrl}/upload`, { method: "POST", headers: { origin: proxyUrl }, body: "hi" });
    expect(res.status).toBe(200);
  });

  it("rejects cross-site POST requests with a mismatched Origin", async () => {
    const res = await fetch(`${proxyUrl}/echo`, { method: "POST", headers: { origin: "http://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("sets X-Frame-Options: SAMEORIGIN on proxied responses, overriding the upstream's own value", async () => {
    const res = await fetch(`${proxyUrl}/xfo`, { headers: { origin: proxyUrl } });
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("strips www-authenticate so browsers never show a login dialog", async () => {
    const res = await fetch(`${proxyUrl}/challenge`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("streams SSE without waiting for the upstream to finish", async () => {
    const res = await fetch(`${proxyUrl}/sse`);
    const reader = res.body!.getReader();
    const { value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE was buffered")), 1000)),
    ]);
    expect(new TextDecoder().decode(value)).toContain("data: first");
    await reader.cancel();
  });

  it("streams request bodies", async () => {
    const res = await fetch(`${proxyUrl}/upload`, { method: "POST", body: "x".repeat(100_000) });
    expect(await res.text()).toBe("100000");
  });

  it("returns a 503 page when the project is not running", async () => {
    target = undefined;
    const res = await fetch(`${proxyUrl}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("http://localhost:7777/");
  });

  it("returns a 502 page when the upstream is unreachable", async () => {
    target = { host: "127.0.0.1", port: 1, password: "pw" };
    const res = await fetch(`${proxyUrl}/`);
    expect(res.status).toBe(502);
  });
});

describe("proxyUpgrade", () => {
  it("tunnels websockets with injected auth", async () => {
    const ws = new WebSocket(`${proxyUrl.replace("http", "ws")}/pty`);
    const messages: string[] = [];
    ws.on("message", (m) => messages.push(m.toString()));
    await new Promise((r) => ws.once("open", r));
    ws.send("hi");
    await expect.poll(() => messages).toEqual([`auth:${basicAuth("pw")}`, "echo:hi"]);
    ws.close();
  });

  it("rejects cross-site websocket upgrades with a mismatched Origin", async () => {
    const ws = new WebSocket(`${proxyUrl.replace("http", "ws")}/pty`, { headers: { origin: "http://evil.example" } });
    const status = await new Promise<number>((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("open", () => reject(new Error("connection should have been rejected")));
      ws.on("error", () => {});
    });
    expect(status).toBe(403);
  });
});
