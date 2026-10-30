import fs from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";

import type {
  Personalization,
  PersonalizationView,
  ProjectPersonalization,
  ProjectPersonalizationView,
} from "../shared/personalization";
import type { ProjectAppearance } from "../shared/project-appearance";
import type {
  AppPreferences,
  ProjectLinks,
  ProjectTeamView,
  SettingsScope,
} from "../shared/types";
import { createActivityRoutes } from "./api/activity";
import { createCoreRoutes } from "./api/core";
import { createForgejoRoutes } from "./api/forgejo";
import { errorResponse } from "./api/helpers";
import { createJiraRoutes } from "./api/jira";
import { createLinksRoutes } from "./api/links";
import { createOcrRoutes } from "./api/ocr";
import { createProjectsRoutes } from "./api/projects";
import type { EventStore } from "./db/events";
import type { ForgejoPresetStore, JiraPresetStore } from "./db/filter-presets";
import type { LinkStore } from "./db/links";
import type { ProvenanceStore } from "./db/provenance";
import type { TodoStore } from "./db/todos";
import type { Checks } from "./environments/checks";
import type { Environments } from "./environments/environments";
import type { BasePositions } from "./git/base-position";
import type { Checkouts } from "./git/checkouts";
import type { Cleanup } from "./git/cleanup";
import type { ReviewActions } from "./git/review-actions";
import type { GitSetupProbe } from "./git/setup";
import type { Forgejo } from "./integrations/forgejo";
import type { Jira } from "./integrations/jira";
import type { Nodes } from "./nodes/registry";
import type { Push } from "./notifications/push";
import type { OcrService } from "./ocr/service";
import type { OcrSettingsStore } from "./ocr/settings";
import type { OnboardingPort } from "./projects/onboarding";
import type { StateStore } from "./projects/state";
import type { Chat } from "./sessions/chat";
import type { SavedPermissions } from "./sessions/saved-permissions";
import type { Sessions } from "./sessions/sessions";
import type { UsageStore } from "./sessions/usage";
import type { Specs } from "./specs/specs";
import type { Tasks } from "./tasks/tasks";

/** The Hub modules the dashboard routes call. */
export interface DashboardHub {
  chat: Pick<
    Chat,
    "start" | "lookup" | "archive" | "brief" | "suggestions" | "makeTask"
  >;
  environments: Pick<
    Environments,
    | "start"
    | "stop"
    | "rebuild"
    | "restartOpencode"
    | "rescan"
    | "logLines"
    | "envLogs"
    | "onLog"
    | "createEnv"
    | "checkConfig"
    | "approveConfig"
    | "refuseConfig"
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
    | "startInCheckout"
    | "generateIn"
    | "replyPermission"
    | "replyForm"
    | "cancelForm"
    | "promptSession"
    | "sendMessage"
    | "composerCommands"
    | "composerAgents"
    | "findFiles"
    | "sessionDetail"
    | "removeSession"
    | "killShell"
    | "restoreCheckpoint"
    | "redoCheckpoint"
    | "startTaskConversation"
    | "archiveTaskConversation"
    | "models"
  >;
  reviews: Pick<
    ReviewActions,
    | "review"
    | "reviewImage"
    | "commitMessage"
    | "commit"
    | "stageView"
    | "stage"
    | "commitStaged"
    | "updateFromBase"
    | "createBranch"
    | "mergeIntoBase"
    | "publishInfo"
    | "publishSuggestion"
    | "publish"
  >;
  tasks: Pick<
    Tasks,
    | "startTask"
    | "dismissStarting"
    | "archiveTask"
    | "archivedTasks"
    | "restoreTask"
    | "deleteArchivedTask"
    | "pickVariant"
    | "createDraft"
    | "draftFromTicket"
    | "editDraft"
    | "startDraft"
  >;
  permissions: Pick<SavedPermissions, "list" | "update" | "remove">;
  bases: Pick<BasePositions, "position" | "pull">;
}

export type PushPort = Pick<
  Push,
  "publicKey" | "browsers" | "subscribe" | "unsubscribe" | "send"
>;

export interface DashboardDeps {
  store: StateStore;
  hub: DashboardHub;
  onboarding: OnboardingPort;
  /** Validates and persists the scan roots; throws InvalidRootError for a bad list. */
  saveRoots?: (input: unknown) => void;
  /** Shows the project under `name`, or its folder name again when `name` is blank; `team` saves it to devcontainer.json. */
  renameProject?: (
    id: string,
    name: string,
    scope?: SettingsScope
  ) => Promise<void>;
  projectAppearance?: {
    save: (
      id: string,
      appearance: ProjectAppearance,
      scope?: SettingsScope
    ) => ProjectAppearance;
  };
  /**
   * Ports a project forwards on top of devcontainer.json's `forwardPorts`; saving forwards them right away.
   * With `team`, saving replaces devcontainer.json's own instead.
   */
  projectPorts?: {
    get: (id: string) => number[];
    save: (id: string, ports: number[], scope?: SettingsScope) => Promise<void>;
  };
  /** The shareable settings per layer: the team's devcontainer.json and the user's config.json. */
  projectTeam?: { get: (id: string) => ProjectTeamView };
  /** Ports on this machine the project's containers reach at the same localhost port; saving applies them right away. */
  projectHostPorts?: {
    get: (id: string) => number[];
    save: (id: string, ports: number[]) => Promise<void>;
  };
  /** What the user adds to every project's containers; applied as containers start. */
  personalization?: {
    get: () => PersonalizationView;
    save: (p: Personalization) => PersonalizationView;
  };
  /** Settings for the whole app. */
  preferences?: {
    get: () => AppPreferences;
    save: (p: AppPreferences) => AppPreferences;
  };
  /** A project's own additions to the personalization, and whether its container needs a rebuild for them. */
  projectPersonalization?: {
    get: (id: string) => ProjectPersonalizationView;
    save: (id: string, p: ProjectPersonalization) => ProjectPersonalizationView;
  };
  /** The Jira board and Forgejo repository each project is linked to. */
  projectLinks?: {
    get: (id: string) => ProjectLinks;
    save: (id: string, links: ProjectLinks, scope?: SettingsScope) => void;
  };
  /** This machine's git identity and ssh keys; absent in tests that don't need it. */
  gitSetup?: Pick<GitSetupProbe, "view" | "test">;
  push: PushPort;
  cleanup: Pick<Cleanup, "scan" | "apply">;
  checks: Pick<Checks, "view" | "latest" | "start" | "cancel" | "saveSettings">;
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
      Pick<
        Forgejo,
        "review" | "organizations" | "teams" | "users" | "image" | "pullUrl"
      >
    >;
  /** Saved pull request inbox views; absent in tests that don't need them. */
  forgejoPresets?: Pick<
    ForgejoPresetStore,
    "list" | "create" | "update" | "remove"
  >;
  /** Saved Tickets page views; absent in tests that don't need them. */
  jiraPresets?: Pick<JiraPresetStore, "list" | "create" | "update" | "remove">;
  /** Each project's to-do list; absent in tests that don't need it. */
  todos?: Pick<TodoStore, "list" | "add" | "update" | "remove">;
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
  /** Open Code Review settings and runs; absent in tests that don't need them. */
  ocr?: {
    settings: Pick<
      OcrSettingsStore,
      "view" | "save" | "projectView" | "saveProject" | "importHost"
    >;
    service: Pick<OcrService, "test" | "review" | "reviewLocal" | "install">;
  };
  /** The event feed; absent in tests that don't need it. */
  activity?: Pick<EventStore, "page">;
  /** Where entities came from; absent in tests that don't need it. */
  provenance?: Pick<ProvenanceStore, "of">;
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
    .route("/", createActivityRoutes(deps))
    .route("/", createCoreRoutes(deps))
    .route("/", createForgejoRoutes(deps))
    .route("/", createJiraRoutes(deps))
    .route("/", createLinksRoutes(deps))
    .route("/", createOcrRoutes(deps))
    .route("/", createProjectsRoutes(deps));
  // An unknown API path must fail loudly, not answer 200 with the page (the client would take HTML for data).
  app.all("/api/*", (c) =>
    c.json({ error: `no such API route: ${c.req.method} ${c.req.path}` }, 404)
  );
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
