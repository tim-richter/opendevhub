import http from "node:http";
import type { AddressInfo } from "node:net";
import type { RawFileDiff, RawFileStatus, RawForm, RawPermissionRequest, RawSession } from "../../src/server/opencode/client";

export interface FakeVcs {
  current?: string;
  default?: string;
  /** "ambiguous" answers 503 like opencode does after a plain `git checkout -b`. */
  base?: string | null | "ambiguous";
  status?: RawFileStatus[];
  /** Keyed by mode. */
  diff?: Record<string, RawFileDiff[]>;
}

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
  /** Every reply or cancel opendevhub sent. */
  replies: Array<{ method: string; path: string; body?: unknown }>;
  /** When set, form replies answer 400 FormInvalidAnswerError with this message. */
  invalidAnswer?: string;
  /** Form ids that answer 409 FormAlreadySettledError (as opencode 2.0.22 does). */
  settledForms?: string[];
  /** Answer errors with plain text instead of opencode's JSON. */
  plainErrors?: boolean;
  vcs: Record<string, FakeVcs>;
  diffQueries: Array<{ directory: string; mode: string; base?: string }>;
  prompts: Array<{ sessionId: string; body: unknown; directory?: string }>;
  generated?: string;
  generateFails?: boolean;
  /** `GET /api/model` data, in opencode's Model.Info shape (may include settings with an apiKey). */
  models?: Array<Record<string, unknown>>;
  defaultModel?: Record<string, unknown> | null;
  agents?: Array<Record<string, unknown>>;
  /** Model ids `POST /api/session` rejects with 400 ModelNotFoundError. */
  rejectModels?: string[];
  /** Every `PATCH /api/session/:id` body. */
  patches: Array<{ sessionId: string; body: unknown }>;
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
    replies: [],
    vcs: {},
    diffQueries: [],
    prompts: [],
    patches: [],
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
    const fail = (status: number, tag: string, message?: string) => {
      if (state.plainErrors) {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end("error");
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ _tag: tag, ...(message ? { message } : {}) }));
    };
    const settle = (kind: "permission" | "form", sessionId: string, itemId: string, body: unknown) => {
      state.replies.push({ method: req.method ?? "", path: `${url.pathname}${url.search}`, body });
      if (kind === "form" && state.settledForms?.includes(itemId)) return fail(409, "FormAlreadySettledError");
      const lists: Record<string, Array<{ id: string; sessionID: string }>> =
        kind === "permission" ? state.permissions : state.forms;
      for (const items of Object.values(lists)) {
        const idx = items.findIndex((i) => i.id === itemId && i.sessionID === sessionId);
        if (idx < 0) continue;
        if (kind === "form" && req.method === "POST" && state.invalidAnswer) {
          return fail(400, "FormInvalidAnswerError", state.invalidAnswer);
        }
        items.splice(idx, 1);
        return json(true);
      }
      return fail(404, kind === "permission" ? "PermissionNotFoundError" : "FormNotFoundError");
    };
    switch (url.pathname) {
      case "/api/info":
        return json({ version: state.version, pid: 1, urls: [], paths: {} });
      case "/api/session":
        if (req.method === "POST") {
          let raw = "";
          req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
          req.on("end", () => {
            const body = JSON.parse(raw) as Pick<RawSession, "title" | "location" | "model" | "agent" | "metadata">;
            if (body.model && state.rejectModels?.includes(body.model.id)) {
              return fail(400, "ModelNotFoundError", `unknown model ${body.model.id}`);
            }
            const created: RawSession = {
              id: `ses_created${state.sessions.length}`,
              title: body.title,
              time: { created: 2, updated: 2 },
              location: body.location,
              cost: 0,
              ...(body.model ? { model: body.model } : {}),
              ...(body.agent ? { agent: body.agent } : {}),
              ...(body.metadata ? { metadata: body.metadata } : {}),
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
      case "/api/vcs":
        return json({ location: { directory: dir }, data: { branch: { current: state.vcs[dir]?.current, default: state.vcs[dir]?.default } } });
      case "/api/vcs/base": {
        const base = state.vcs[dir]?.base;
        if (base === "ambiguous") return fail(503, "ServiceUnavailable", "Choose a review base");
        return json({ location: { directory: dir }, data: base ? { name: base, ref: base, source: "reflog" } : null });
      }
      case "/api/vcs/status":
        return json({ location: { directory: dir }, data: state.vcs[dir]?.status ?? [] });
      case "/api/vcs/diff": {
        const mode = url.searchParams.get("mode") ?? "working";
        const base = url.searchParams.get("base") ?? undefined;
        state.diffQueries.push({ directory: dir, mode, ...(base ? { base } : {}) });
        return json({ location: { directory: dir }, data: state.vcs[dir]?.diff?.[mode] ?? [] });
      }
      case "/api/model":
        return json({ location: { directory: dir }, data: state.models ?? [] });
      case "/api/model/default":
        return json({ location: { directory: dir }, data: state.defaultModel ?? null });
      case "/api/agent":
        return json({ location: { directory: dir }, data: state.agents ?? [] });
      case "/api/event":
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
        res.write(": heartbeat\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      default: {
        const patch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
        if (patch && req.method === "PATCH") {
          let raw = "";
          req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
          req.on("end", () => {
            const sessionId = decodeURIComponent(patch[1]);
            const body = JSON.parse(raw) as { title?: string; metadata?: Record<string, unknown> };
            const session = state.sessions.find((s) => s.id === sessionId);
            if (!session) return fail(404, "SessionNotFoundError");
            state.patches.push({ sessionId, body });
            if (body.title !== undefined) session.title = body.title;
            // opencode 2.0.22 replaces metadata as a whole; it does not merge.
            if (body.metadata !== undefined) session.metadata = body.metadata;
            res.writeHead(204);
            res.end();
          });
          return;
        }
        const sessionCall = url.pathname.match(/^\/api\/session\/([^/]+)\/(prompt|generate)$/);
        if (sessionCall && req.method === "POST") {
          let raw = "";
          req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
          req.on("end", () => {
            const body = raw ? JSON.parse(raw) : undefined;
            const sessionId = decodeURIComponent(sessionCall[1]);
            if (sessionCall[2] === "prompt") {
              state.prompts.push({ sessionId, body, directory: req.headers["x-opencode-directory"] as string | undefined });
              return json({ data: { id: "msg_1", sessionID: sessionId, type: "user" } });
            }
            if (state.generateFails) return fail(500, "GenerateError", "no model");
            return json({ data: { text: state.generated ?? "chore: update" } });
          });
          return;
        }
        const reply = url.pathname.match(/^\/api\/session\/([^/]+)\/(permission|form)\/([^/]+?)(\/reply)?$/);
        if (reply && (req.method === "POST" || req.method === "DELETE")) {
          let raw = "";
          req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
          req.on("end", () =>
            settle(
              reply[2] as "permission" | "form",
              decodeURIComponent(reply[1]),
              decodeURIComponent(reply[3]),
              raw ? JSON.parse(raw) : undefined,
            ),
          );
          return;
        }
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
