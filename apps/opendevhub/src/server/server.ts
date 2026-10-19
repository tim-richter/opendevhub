import http from "node:http";
import type { AddressInfo } from "node:net";

import { getRequestListener } from "@hono/node-server";

import type { Access } from "./access";
import { Terminals } from "./environments/terminals";
import type { TerminalTarget } from "./environments/terminals";
import { gateDashboard, gateEnv } from "./network/gate";
import { classifyHost } from "./network/hosts";
import { proxyRequest, proxyUpgrade } from "./network/proxy";
import type { ResolveTarget } from "./network/proxy";
import type { DevUi } from "./vite-dev";

export interface ServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

export const startServer = async (opts: {
  port: number;
  app: FetchApp;
  /** Who may use the dashboard and environment hosts; see `gateDashboard` and `gateEnv`. */
  access: Access;
  resolveTarget: ResolveTarget;
  /** Serves every non-API dashboard request in development; see `startDevUi`. */
  devUi?: DevUi;
  terminalTarget?: (
    project: string,
    directory: string
  ) => TerminalTarget | Promise<TerminalTarget>;
}): Promise<ServerHandle> => {
  const terminals = opts.terminalTarget
    ? new Terminals(opts.terminalTarget)
    : undefined;
  const dashboard = getRequestListener(opts.app.fetch);
  let { port } = opts;
  const dashboardUrl = () => `http://localhost:${port}/`;

  const server = http.createServer((req, res) => {
    const route = classifyHost(req.headers.host, port);
    if (route.kind === "dashboard") {
      if (gateDashboard(opts.access, req, res, port)) {
        return;
      }
      if (opts.devUi && !req.url?.startsWith("/api/")) {
        return opts.devUi.handle(req, res, () => void dashboard(req, res));
      }
      return void dashboard(req, res);
    }
    if (route.kind === "env") {
      if (gateEnv(opts.access, route.envId, req, res, dashboardUrl())) {
        return;
      }
      return proxyRequest(
        req,
        res,
        route.envId,
        opts.resolveTarget,
        dashboardUrl()
      );
    }
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("Misdirected Request");
  });
  server.on("upgrade", (req, socket, head) => {
    const route = classifyHost(req.headers.host, port);
    if (
      route.kind === "dashboard" &&
      terminals &&
      req.url?.startsWith("/api/terminal?")
    ) {
      if (!opts.access.dashboardAllowed(req.headers.cookie)) {
        return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      }
      return terminals.upgrade(req, socket, head);
    }
    if (route.kind === "env") {
      if (!opts.access.envAllowed(route.envId, req.headers.cookie)) {
        return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      }
      return proxyUpgrade(req, socket, head, route.envId, opts.resolveTarget);
    }
    socket.end("HTTP/1.1 421 Misdirected Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`port ${opts.port} is already in use — pass --port <n>`)
          : err
      )
    );
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  ({ port } = server.address() as AddressInfo);

  return {
    close: async () => {
      terminals?.close();
      await opts.devUi?.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
    port,
    url: dashboardUrl(),
  };
};
