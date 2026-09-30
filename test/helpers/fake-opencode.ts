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
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case "/api/info":
        return json({ version: state.version, pid: 1, urls: [], paths: {} });
      case "/api/session":
        return json({ data: state.sessions, cursor: {} });
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
      default:
        res.writeHead(404);
        res.end();
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
