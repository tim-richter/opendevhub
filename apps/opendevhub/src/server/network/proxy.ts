import http from "node:http";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { basicAuth } from "../opencode/client";

export interface ProxyTarget {
  host: string;
  port: number;
  password: string;
}

export type ResolveTarget = (envId: string) => ProxyTarget | undefined;

const DROPPED_RESPONSE_HEADERS = new Set([
  "www-authenticate",
  "connection",
  "keep-alive",
]);
const UPSTREAM_UPGRADE_TIMEOUT_MS = 10_000;

const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

const sendPage = (
  res: ServerResponse,
  status: number,
  title: string,
  message: string,
  dashboardUrl: string
): void => {
  const html =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
    `<p><a href="${escapeHtml(dashboardUrl)}">Back to the opendevhub dashboard</a></p></body>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
};

// The Host header is validated by classifyHost before proxyRequest/proxyUpgrade run. A request
// carrying an Origin header that doesn't match that Host is a cross-site request (e.g. a page on
// another site submitting a form or opening a WebSocket to us) and must be rejected before we
// touch the upstream — otherwise upstreamHeaders() below would silently rewrite Origin and the
// cross-site request would sail through as if it were same-origin.
const isCrossSite = (req: IncomingMessage): boolean => {
  const { origin } = req.headers;
  if (!origin) {
    return false;
  }
  const host = req.headers.host ?? "";
  return origin.toLowerCase() !== `http://${host.toLowerCase()}`;
};

const upstreamHeaders = (
  req: IncomingMessage,
  target: ProxyTarget
): OutgoingHttpHeaders => {
  const origin = `http://${target.host}:${target.port}`;
  const headers: OutgoingHttpHeaders = {
    ...req.headers,
    host: `${target.host}:${target.port}`,
    authorization: basicAuth(target.password),
  };
  if (headers.origin) {
    headers.origin = origin;
  }
  return headers;
};

export const proxyRequest = (
  req: IncomingMessage,
  res: ServerResponse,
  envId: string,
  resolve: ResolveTarget,
  dashboardUrl: string
): void => {
  if (isCrossSite(req)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden: cross-site request blocked");
    return;
  }
  const target = resolve(envId);
  if (!target) {
    sendPage(
      res,
      503,
      "Not running",
      "Start it from the dashboard, then reload this page.",
      dashboardUrl
    );
    return;
  }
  const upstream = http.request(
    {
      headers: upstreamHeaders(req, target),
      host: target.host,
      method: req.method,
      path: req.url,
      port: target.port,
    },
    (upRes) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined && !DROPPED_RESPONSE_HEADERS.has(k)) {
          headers[k] = v;
        }
      }
      headers["x-frame-options"] = "SAMEORIGIN";
      res.writeHead(upRes.statusCode ?? 502, headers);
      res.flushHeaders();
      upRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (res.headersSent) {
      res.destroy();
    } else {
      sendPage(res, 502, "opencode unreachable", err.message, dashboardUrl);
    }
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
};

export const proxyUpgrade = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  envId: string,
  resolve: ResolveTarget
): void => {
  if (isCrossSite(req)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const target = resolve(envId);
  if (!target) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  const upstream = http.request({
    headers: upstreamHeaders(req, target),
    host: target.host,
    method: req.method,
    path: req.url,
    port: target.port,
    timeout: UPSTREAM_UPGRADE_TIMEOUT_MS,
  });
  // Node hijacks `socket` for the upgrade and strips the server's own error handling from it, so
  // without a listener attached right away — before any async work — a client-side ECONNRESET
  // while the upstream is still pending/connecting has nowhere to go and crashes the process.
  // (upstream.destroy() also tears down its socket once the upgrade has happened, since that
  // socket is the same object as upstream.socket throughout.)
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("timeout", () => {
    upstream.destroy();
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
    }
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upHead.length) {
      socket.write(upHead);
    }
    if (head.length) {
      upSocket.write(head);
    }
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
  });
  upstream.on("response", (upRes) => {
    socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
};
