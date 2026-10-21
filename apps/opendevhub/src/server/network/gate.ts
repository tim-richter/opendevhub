import type { IncomingMessage, ServerResponse } from "node:http";

import { DASHBOARD_COOKIE, ENV_COOKIE, setCookie } from "../access";
import type { Access } from "../access";
import { isEnvLabel } from "./hosts";

/**
 * Where an environment host sends its code back to; the redirect then lands on `next`. Under `/api/` because
 * opencode's service worker answers every other navigation with its own cached page, so the request would
 * never reach the gate.
 */
export const ENV_ENTER_PATH = "/api/__odh/enter";
const ENTER_ROUTE = /^\/api\/envs\/(?<env>[^/?]+)\/enter$/u;

const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

const parse = (req: IncomingMessage): URL =>
  new URL(req.url ?? "/", "http://localhost");

/** A same-host path to land on: `/…` but never `//…`, which a browser reads as another host. */
const safeNext = (next: string | null): string =>
  next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/";

const wantsPage = (req: IncomingMessage): boolean =>
  req.method === "GET" && (req.headers.accept ?? "").includes("text/html");

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
};

const noAccessPage = (dashboardUrl: string): string =>
  `<!doctype html><meta charset="utf-8"><title>No access</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
  `<h1>No access</h1><p>Open this environment from the opendevhub dashboard.</p>` +
  `<p><a href="${escapeHtml(dashboardUrl)}">Open the dashboard</a></p></body>`;

const NO_ACCESS = { error: "no dashboard access: run `opendevhub open`" };

/**
 * The dashboard host's side of access: `?token=` on a page is exchanged for the cookie, `/api/access`
 * answers whether the cookie is valid, `/api/envs/:env/enter` hands out a one-time code, and every other
 * `/api` request needs the cookie. Returns true when it answered the request itself.
 */
export const gateDashboard = (
  access: Access,
  req: IncomingMessage,
  res: ServerResponse,
  port: number
): boolean => {
  const url = parse(req);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const token = url.searchParams.get("token");
  if (!isApi && token !== null && req.method === "GET") {
    if (!access.validToken(token)) {
      // Served as usual: the page finds no access and explains how to get it.
      return false;
    }
    url.searchParams.delete("token");
    res.writeHead(302, {
      "cache-control": "no-store",
      location: `${url.pathname}${url.search}${url.hash}`,
      "set-cookie": setCookie(
        DASHBOARD_COOKIE,
        access.dashboardCookie(),
        "Strict"
      ),
    });
    res.end();
    return true;
  }
  if (!isApi) {
    return false;
  }
  const allowed = access.dashboardAllowed(req.headers.cookie);
  if (url.pathname === "/api/access") {
    sendJson(res, allowed ? 200 : 401, allowed ? { ok: true } : NO_ACCESS);
    return true;
  }
  if (!allowed) {
    sendJson(res, 401, NO_ACCESS);
    return true;
  }
  const enter = ENTER_ROUTE.exec(url.pathname);
  if (enter && req.method === "GET") {
    const envId = decodeURIComponent(enter.groups?.env ?? "").toLowerCase();
    if (!isEnvLabel(envId)) {
      sendJson(res, 404, { error: `unknown environment ${envId}` });
      return true;
    }
    const target = new URL(
      `http://${envId}.localhost:${port}${ENV_ENTER_PATH}`
    );
    target.searchParams.set("code", access.mintCode(envId));
    target.searchParams.set("next", safeNext(url.searchParams.get("next")));
    res.writeHead(302, { "cache-control": "no-store", location: target.href });
    res.end();
    return true;
  }
  return false;
};

/**
 * An environment host's side: `/__odh/enter?code=` sets its own cookie, everything else needs that cookie.
 * Returns true when it answered the request itself, so the proxy never sees it.
 */
export const gateEnv = (
  access: Access,
  envId: string,
  req: IncomingMessage,
  res: ServerResponse,
  dashboardUrl: string
): boolean => {
  const url = parse(req);
  if (url.pathname === ENV_ENTER_PATH) {
    if (!access.redeemCode(envId, url.searchParams.get("code"))) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      res.end(noAccessPage(dashboardUrl));
      return true;
    }
    res.writeHead(302, {
      "cache-control": "no-store",
      location: safeNext(url.searchParams.get("next")),
      // Lax: links from the dashboard (another site, `localhost`) are top-level navigations that must carry it.
      "set-cookie": setCookie(ENV_COOKIE, access.envCookie(envId), "Lax"),
    });
    res.end();
    return true;
  }
  if (access.envAllowed(envId, req.headers.cookie)) {
    return false;
  }
  if (wantsPage(req)) {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    res.end(noAccessPage(dashboardUrl));
  } else {
    sendJson(res, 401, { error: "no access to this environment" });
  }
  return true;
};
