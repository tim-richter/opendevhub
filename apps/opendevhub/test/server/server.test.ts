import http from "node:http";
import type { AddressInfo } from "node:net";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProxyTarget } from "../../src/server/network/proxy";
import { startServer } from "../../src/server/server";
import { testAccess } from "../helpers/access";

let upstream: http.Server;
let upstreamPort: number;
let upstreamHits: number;
let server: Awaited<ReturnType<typeof startServer>>;
let targets: Record<string, ProxyTarget>;
let grant: ReturnType<typeof testAccess>;
let created: ReturnType<typeof vi.fn<() => void>>;

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const request = (
  host: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {}
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        headers: { host, ...opts.headers },
        host: "127.0.0.1",
        method: opts.method ?? "GET",
        path,
        port: server.port,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ body, headers: res.headers, status: res.statusCode ?? 0 })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });

const dashboard = () => `localhost:${server.port}`;
const envHost = (id: string) => `${id}.localhost:${server.port}`;

beforeEach(async () => {
  upstreamHits = 0;
  upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.end(`upstream ${req.headers.authorization} ${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  targets = {
    "demo-abc123": { host: "127.0.0.1", port: upstreamPort, password: "pw" },
    "other-000000": { host: "127.0.0.1", port: upstreamPort, password: "pw2" },
  };
  grant = testAccess();
  created = vi.fn<() => void>();
  const app = new Hono()
    .get("/api/ping", (c) => c.text("pong"))
    .post("/api/projects/:id/tasks", (c) => {
      created();
      return c.json({ ok: true });
    })
    .get("/", (c) => c.html("<p>dashboard</p>"))
    .get("/assets/app.js", (c) => c.text("js"));
  server = await startServer({
    access: grant.access,
    app,
    port: 0,
    resolveTarget: (id) => targets[id],
  });
});
afterEach(async () => {
  await server.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
});

describe(startServer, () => {
  it("routes the dashboard host to the Hono app", async () => {
    const res = await request(dashboard(), "/api/ping", {
      headers: { cookie: grant.cookie },
    });
    expect(res).toMatchObject({ body: "pong", status: 200 });
    expect(server.url).toBe(`http://localhost:${server.port}/`);
  });

  it("rejects foreign hosts with 421 (DNS rebinding)", async () => {
    expect(
      (await request(`evil.example:${server.port}`, "/api/ping")).status
    ).toBe(421);
  });
});

describe("dashboard access", () => {
  it("answers 401 to an API call without the cookie, e.g. from a container", async () => {
    const res = await request(dashboard(), "/api/projects/demo/tasks", {
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(created).not.toHaveBeenCalled();
    expect(
      (
        await request(dashboard(), "/api/projects/demo/tasks", {
          headers: { cookie: "odh=forged" },
          method: "POST",
        })
      ).status
    ).toBe(401);
  });

  it("refuses the event stream without the cookie", async () => {
    expect((await request(dashboard(), "/api/events")).status).toBe(401);
  });

  it("exchanges the token on a page for the cookie and redirects without it", async () => {
    const token = grant.access.token();
    const res = await request(dashboard(), `/?token=${token}&tab=x`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?tab=x");
    const [cookie] = res.headers["set-cookie"] ?? [];
    expect(cookie).toMatch(/^odh=[0-9a-f]{64};/u);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
    expect(cookie).not.toMatch(/domain/iu);
    expect(cookie).not.toContain(token);
    const pair = cookie.split(";")[0];
    expect(
      (await request(dashboard(), "/api/ping", { headers: { cookie: pair } }))
        .status
    ).toBe(200);
  });

  it("serves the page without a cookie for a wrong token", async () => {
    const res = await request(dashboard(), "/?token=wrong");
    expect(res).toMatchObject({ body: "<p>dashboard</p>", status: 200 });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("serves pages and static files without the cookie", async () => {
    expect((await request(dashboard(), "/")).status).toBe(200);
    expect((await request(dashboard(), "/assets/app.js")).body).toBe("js");
  });

  it("reports access on /api/access", async () => {
    expect((await request(dashboard(), "/api/access")).status).toBe(401);
    expect(
      (
        await request(dashboard(), "/api/access", {
          headers: { cookie: grant.cookie },
        })
      ).status
    ).toBe(200);
  });
});

describe("environment access", () => {
  const enter = async (envId: string, next = "/") => {
    const res = await request(
      dashboard(),
      `/api/envs/${envId}/enter?next=${encodeURIComponent(next)}`,
      { headers: { cookie: grant.cookie } }
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location ?? "");
    expect(location.host).toBe(envHost(envId));
    return `${location.pathname}${location.search}`;
  };

  it("never proxies a request without the env's cookie", async () => {
    const res = await request(envHost("other-000000"), "/session", {
      headers: { cookie: grant.envCookie("demo-abc123") },
    });
    expect(res.status).toBe(401);
    expect(
      (
        await request(envHost("other-000000"), "/", {
          headers: { accept: "text/html" },
        })
      ).body
    ).toContain("Open this environment from the opendevhub dashboard");
    expect(upstreamHits).toBe(0);
  });

  it("proxies with injected auth once the cookie is set", async () => {
    const res = await request(envHost("Demo-ABC123"), "/", {
      headers: { cookie: grant.envCookie("demo-abc123") },
    });
    expect(res.body).toBe(
      `upstream Basic ${Buffer.from("opencode:pw").toString("base64")} /`
    );
  });

  it("returns 503 for stopped environments", async () => {
    expect(
      (
        await request(envHost("stopped-000000"), "/", {
          headers: { cookie: grant.envCookie("stopped-000000") },
        })
      ).status
    ).toBe(503);
  });

  it("refuses the enter route without the dashboard cookie", async () => {
    expect(
      (await request(dashboard(), "/api/envs/demo-abc123/enter")).status
    ).toBe(401);
  });

  it("exchanges a code once for the env's cookie and lands on next", async () => {
    const path = await enter("demo-abc123", "/server/abc/session/s1");
    const res = await request(envHost("demo-abc123"), path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/server/abc/session/s1");
    const cookie = (res.headers["set-cookie"] ?? [])[0];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toMatch(/domain/iu);
    const proxied = await request(envHost("demo-abc123"), "/x", {
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(proxied.status).toBe(200);
    expect(upstreamHits).toBe(1);

    const reused = await request(envHost("demo-abc123"), path);
    expect(reused.status).toBe(401);
    expect(reused.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a code on another env's host", async () => {
    const path = await enter("demo-abc123");
    expect((await request(envHost("other-000000"), path)).status).toBe(401);
  });

  it("never redirects to another host", async () => {
    const path = await enter("demo-abc123", "//evil.example/");
    const res = await request(envHost("demo-abc123"), path);
    expect(res.headers.location).toBe("/");
  });
});
