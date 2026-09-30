import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { basicAuth } from "./opencode/client";

export interface ProxyTarget {
  host: string;
  port: number;
  password: string;
}

export type ResolveTarget = (projectId: string) => ProxyTarget | undefined;

const DROPPED_RESPONSE_HEADERS = new Set(["www-authenticate", "connection", "keep-alive"]);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendPage(res: ServerResponse, status: number, title: string, message: string, dashboardUrl: string): void {
  const html =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
    `<p><a href="${escapeHtml(dashboardUrl)}">Back to the opendevhub dashboard</a></p></body>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function upstreamHeaders(req: IncomingMessage, target: ProxyTarget): OutgoingHttpHeaders {
  const origin = `http://${target.host}:${target.port}`;
  const headers: OutgoingHttpHeaders = { ...req.headers };
  headers.host = `${target.host}:${target.port}`;
  headers.authorization = basicAuth(target.password);
  if (headers.origin) headers.origin = origin;
  return headers;
}

export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  resolve: ResolveTarget,
  dashboardUrl: string,
): void {
  const target = resolve(projectId);
  if (!target) {
    sendPage(res, 503, "Project not running", "Start it from the dashboard, then reload this page.", dashboardUrl);
    return;
  }
  const upstream = http.request(
    { host: target.host, port: target.port, method: req.method, path: req.url, headers: upstreamHeaders(req, target) },
    (upRes) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined && !DROPPED_RESPONSE_HEADERS.has(k)) headers[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, headers);
      res.flushHeaders();
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) sendPage(res, 502, "opencode unreachable", err.message, dashboardUrl);
    else res.destroy();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  projectId: string,
  resolve: ResolveTarget,
): void {
  const target = resolve(projectId);
  if (!target) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  const upstream = http.request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, target),
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
    socket.on("close", () => upSocket.destroy());
  });
  upstream.on("response", (upRes) => {
    socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
}
