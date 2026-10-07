import http from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { classifyHost } from "./hosts";
import { Terminals, type TerminalTarget } from "./terminals";
import { type ResolveTarget, proxyRequest, proxyUpgrade } from "./proxy";

export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

export async function startServer(opts: {
  port: number;
  app: FetchApp;
  resolveTarget: ResolveTarget;
  terminalTarget?: (project: string, directory: string) => TerminalTarget | Promise<TerminalTarget>;
}): Promise<ServerHandle> {
  const terminals = opts.terminalTarget ? new Terminals(opts.terminalTarget) : undefined;
  const dashboard = getRequestListener(opts.app.fetch);
  let port = opts.port;
  const dashboardUrl = () => `http://localhost:${port}/`;

  const server = http.createServer((req, res) => {
    const route = classifyHost(req.headers.host, port);
    if (route.kind === "dashboard") return void dashboard(req, res);
    if (route.kind === "env") return proxyRequest(req, res, route.envId, opts.resolveTarget, dashboardUrl());
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("Misdirected Request");
  });
  server.on("upgrade", (req, socket, head) => {
    const route = classifyHost(req.headers.host, port);
    if (route.kind === "dashboard" && terminals && req.url?.startsWith("/api/terminal?")) return terminals.upgrade(req, socket, head);
    if (route.kind === "env") return proxyUpgrade(req, socket, head, route.envId, opts.resolveTarget);
    socket.end("HTTP/1.1 421 Misdirected Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`port ${opts.port} is already in use — pass --port <n>`) : err),
    );
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: dashboardUrl(),
    port,
    close: () =>
      new Promise<void>((resolve) => {
        terminals?.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
