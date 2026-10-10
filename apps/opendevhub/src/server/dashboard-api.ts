import fs from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";

import { createCoreRoutes } from "./api/core";
import { createForgejoRoutes } from "./api/forgejo";
import { errorResponse } from "./api/helpers";
import { createJiraRoutes } from "./api/jira";
import { createLinksRoutes } from "./api/links";
import { createProjectsRoutes } from "./api/projects";
import type { LinkStore } from "./db/links";
import type { Checks } from "./environments/checks";
import type { Environments } from "./environments/environments";
import type { Checkouts } from "./git/checkouts";
import type { Cleanup } from "./git/cleanup";
import type { ReviewActions } from "./git/review-actions";
import type { Forgejo } from "./integrations/forgejo";
import type { Jira } from "./integrations/jira";
import type { Nodes } from "./nodes/registry";
import type { Push } from "./notifications/push";
import type { OnboardingPort } from "./projects/onboarding";
import type { StateStore } from "./projects/state";
import type { Sessions } from "./sessions/sessions";
import type { UsageStore } from "./sessions/usage";
import type { Specs } from "./specs/specs";
import type { Tasks } from "./tasks/tasks";

/** The Hub modules the dashboard routes call. */
export interface DashboardHub {
  environments: Pick<
    Environments,
    | "start"
    | "stop"
    | "rebuild"
    | "restartOpencode"
    | "rescan"
    | "logLines"
    | "onLog"
    | "createEnv"
    | "startEnv"
    | "stopEnv"
    | "rebuildEnv"
    | "restartEnvOpencode"
    | "removeEnv"
  >;
  checkouts: Pick<
    Checkouts,
    | "branches"
    | "refreshWorktrees"
    | "createWorktree"
    | "removeWorktree"
    | "openInEditor"
    | "bringHome"
  >;
  sessions: Pick<
    Sessions,
    | "startSession"
    | "generateIn"
    | "replyPermission"
    | "replyForm"
    | "cancelForm"
    | "promptSession"
    | "sessionDetail"
    | "removeSession"
    | "models"
  >;
  reviews: Pick<
    ReviewActions,
    | "review"
    | "reviewImage"
    | "commitMessage"
    | "commit"
    | "updateFromBase"
    | "mergeIntoBase"
    | "publishInfo"
    | "publishSuggestion"
    | "publish"
  >;
  tasks: Pick<
    Tasks,
    "startTask" | "dismissStarting" | "archiveTask" | "pickVariant"
  >;
}

export type PushPort = Pick<
  Push,
  "publicKey" | "subscribe" | "unsubscribe" | "send"
>;

export interface DashboardDeps {
  store: StateStore;
  hub: DashboardHub;
  onboarding: OnboardingPort;
  /** Validates and persists the scan roots; throws InvalidRootError for a bad list. */
  saveRoots?: (input: unknown) => void;
  push: PushPort;
  cleanup: Pick<Cleanup, "scan" | "apply">;
  checks: Pick<Checks, "view" | "latest" | "start" | "saveSettings">;
  /** Absent in tests that don't need it. */
  specs?: Pick<Specs, "view" | "revise" | "approve" | "implement" | "archive">;
  /** Absent when the usage ledger couldn't be opened. */
  usage?: Pick<UsageStore, "report">;
  /** Absent in tests that don't need it. */
  nodes?: Pick<Nodes, "add" | "remove">;
  forgejo?: Pick<
    Forgejo,
    | "view"
    | "save"
    | "pulls"
    | "diff"
    | "inbox"
    | "details"
    | "patch"
    | "comments"
    | "reviews"
    | "reviewComments"
    | "approvals"
    | "checks"
    | "test"
  > &
    Partial<
      Pick<Forgejo, "review" | "organizations" | "teams" | "image" | "pullUrl">
    >;
  jira?: Pick<
    Jira,
    "view" | "save" | "tickets" | "ticket" | "catalog" | "columns"
  >;
  /** Tickets, pull requests and AI reviews; absent in tests that don't need them. */
  links?: Pick<
    LinkStore,
    | "ensurePull"
    | "refreshPulls"
    | "refreshTickets"
    | "insertReview"
    | "reviewsOf"
    | "forPull"
    | "forTicket"
  >;
  webDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export const createDashboardApp = (deps: DashboardDeps) => {
  const app = new Hono();
  app.onError((error, c) => errorResponse(c, error));
  // X-Frame-Options blocks the dashboard from being framed by another site. The Origin check
  // blocks cross-site state-changing requests (e.g. a form on another page POSTing to our
  // actions) — safe methods are exempt since they don't mutate state and top-level navigations
  // don't send an Origin header at all.
  app.use("*", async (c, next) => {
    c.header("X-Frame-Options", "DENY");
    const { method } = c.req;
    if (method !== "GET" && method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin) {
        const host = c.req.header("host") ?? "";
        if (origin.toLowerCase() !== `http://${host.toLowerCase()}`) {
          return c.text("Forbidden: cross-site request blocked", 403);
        }
      }
    }
    await next();
  });

  const api = app
    .route("/", createCoreRoutes(deps))
    .route("/", createForgejoRoutes(deps))
    .route("/", createJiraRoutes(deps))
    .route("/", createLinksRoutes(deps))
    .route("/", createProjectsRoutes(deps));
  const { webDir } = deps;
  if (!webDir) {
    app.get("*", (c) =>
      c.text(
        "opendevhub UI is not built. Run `npm run build`, or `npm run dev:web` during development.",
        503
      )
    );
    return api;
  }

  app.get("*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname);
    let file = path.join(webDir, path.normalize(rel));
    if (file !== webDir && !file.startsWith(webDir + path.sep)) {
      return c.notFound();
    }
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) {
      file = path.join(webDir, "index.html");
    }
    const body = await fs.readFile(file);
    return c.body(new Uint8Array(body), 200, {
      "content-type":
        CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    });
  });

  return api;
};

export type DashboardApi = ReturnType<typeof createDashboardApp>;
