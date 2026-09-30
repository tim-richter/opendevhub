import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { LogEvent } from "../shared/types";
import { BusyError, NotFoundError, type Orchestrator } from "./orchestrator";
import type { StateStore } from "./state";

export type DashboardOrchestrator = Pick<
  Orchestrator,
  "start" | "stop" | "rebuild" | "restartOpencode" | "rescan" | "logLines" | "onLog"
>;

export interface DashboardDeps {
  store: StateStore;
  orchestrator: DashboardOrchestrator;
  webDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function createDashboardApp(deps: DashboardDeps): Hono {
  const { store, orchestrator } = deps;
  const app = new Hono();

  app.get("/api/projects", (c) => c.json(store.snapshot()));

  app.post("/api/projects/rescan", async (c) => {
    await orchestrator.rescan();
    return c.json(store.snapshot());
  });

  const actions = {
    start: (id: string) => orchestrator.start(id),
    stop: (id: string) => orchestrator.stop(id),
    rebuild: (id: string) => orchestrator.rebuild(id),
    "restart-opencode": (id: string) => orchestrator.restartOpencode(id),
  } as const;

  for (const [route, run] of Object.entries(actions)) {
    app.post(`/api/projects/:id/${route}`, (c) => {
      if (store.preflight().errors.length > 0) {
        return c.json({ error: store.preflight().errors.join("; ") }, 412);
      }
      try {
        run(c.req.param("id")).catch(() => {});
        return c.json({ accepted: true }, 202);
      } catch (err) {
        if (err instanceof BusyError) return c.json({ error: err.message }, 409);
        if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
        throw err;
      }
    });
  }

  app.get("/api/projects/:id/logs", (c) => c.json({ lines: orchestrator.logLines(c.req.param("id")) }));

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const sendSnapshot = () => stream.writeSSE({ event: "snapshot", data: JSON.stringify(store.snapshot()) });
      await sendSnapshot();
      let pending: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = store.subscribe(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = undefined;
          void sendSnapshot();
        }, 50);
      });
      const unlisten = orchestrator.onLog((projectId, line) => {
        const event: LogEvent = { projectId, line };
        void stream.writeSSE({ event: "log", data: JSON.stringify(event) });
      });
      const heartbeat = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      clearTimeout(pending);
      unsubscribe();
      unlisten();
    }),
  );

  const webDir = deps.webDir;
  if (!webDir) {
    app.get("*", (c) =>
      c.text("opendevhub UI is not built. Run `npm run build`, or `npm run dev:web` during development.", 503),
    );
    return app;
  }

  app.get("*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname);
    let file = path.join(webDir, path.normalize(rel));
    if (file !== webDir && !file.startsWith(webDir + path.sep)) return c.notFound();
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) file = path.join(webDir, "index.html");
    const body = await fs.readFile(file);
    return c.body(new Uint8Array(body), 200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    });
  });

  return app;
}
