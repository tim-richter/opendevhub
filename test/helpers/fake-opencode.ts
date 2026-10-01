import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RawForm, RawPermissionRequest, RawSession } from "../../src/server/opencode/client";

export interface FakeState {
  version: string;
  cwd: string;
  sessions: RawSession[];
  active: string[];
  permissions: Record<string, RawPermissionRequest[]>;
  forms: Record<string, RawForm[]>;
  fail: boolean;
  /** Directories opencode can't open (missing in the container): their scoped routes answer 500. */
  missingDirectories?: string[];
  /** Emulates opencode's default page size for `GET /api/session`. */
  listLimit?: number;
}

export async function startFakeOpencode(password = "pw", init: Partial<FakeState> = {}) {
  const state: FakeState = {
    version: "2.0.20",
    cwd: "/workspaces/demo",
    sessions: [],
    active: [],
    permissions: {},
    forms: {},
    fail: false,
    ...init,
  };
  const sseClients = new Set<http.ServerResponse>();
  const requests: string[] = [];
  const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="Secure Area"' });
      res.end('{"_tag":"UnauthorizedError"}');
      return;
    }
    if (state.fail) {
      res.writeHead(500);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const dir = (req.headers["x-opencode-directory"] as string | undefined) ?? state.cwd;
    if (state.missingDirectories?.includes(dir)) {
      res.writeHead(500);
      res.end();
      return;
    }
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case "/api/info":
        return json({ version: state.version, pid: 1, urls: [], paths: {} });
      case "/api/session":
        if (req.method === "POST") {
          let raw = "";
          req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
          req.on("end", () => {
            const body = JSON.parse(raw) as { title?: string; location: { directory: string } };
            const created: RawSession = {
              id: `ses_created${state.sessions.length}`,
              title: body.title,
              time: { created: 2, updated: 2 },
              location: body.location,
            };
            state.sessions.unshift(created);
            json({ data: created });
          });
          return;
        }
        return json({ data: state.sessions.slice(0, state.listLimit), cursor: {} });
      case "/api/session/active":
        return json({ data: Object.fromEntries(state.active.map((id) => [id, { type: "running" }])) });
      case "/api/permission/request":
        return json({ location: { directory: dir }, data: state.permissions[dir] ?? [] });
      case "/api/form":
        return json({ location: { directory: dir }, data: state.forms[dir] ?? [] });
      case "/api/event":
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
        res.write(": heartbeat\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      default: {
        const one = url.pathname.match(/^\/api\/session\/(ses[^/]+)$/);
        const found = one && state.sessions.find((s) => s.id === one[1]);
        if (found) return json({ data: found });
        res.writeHead(404);
        res.end();
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    state,
    requests,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    emit(event: object) {
      for (const c of sseClients) c.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    dropStreams() {
      for (const c of sseClients) c.destroy();
      sseClients.clear();
    },
    sseClientCount: () => sseClients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of sseClients) c.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type FakeOpencode = Awaited<ReturnType<typeof startFakeOpencode>>;

export function rawSession(id: string, over: Partial<RawSession> = {}): RawSession {
  return {
    id,
    title: `Session ${id}`,
    time: { created: 1, updated: 1 },
    location: { directory: "/workspaces/demo" },
    ...over,
  };
}
