import fs from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type {
  AiReviewResult,
  ForgejoInbox,
  ForgejoPullFilter,
} from "../shared/forgejo";
import { parseJiraQuery } from "../shared/jira";
import type { AddProjectResult, LogEvent, ReviewMode } from "../shared/types";
import { InvalidNodeError, InvalidRootError } from "./config";
import type { Checks } from "./environments/checks";
import { CommandError } from "./environments/containers";
import { EditorUnavailableError } from "./environments/editors";
import type { Environments } from "./environments/environments";
import {
  AlreadyAnsweredError,
  BusyError,
  NotFoundError,
  UnavailableError,
} from "./errors";
import type { Checkouts } from "./git/checkouts";
import { parseCleanupItems } from "./git/cleanup";
import type { Cleanup } from "./git/cleanup";
import type { ReviewActions } from "./git/review-actions";
import { InvalidRequestError } from "./git/worktrees";
import {
  AI_REVIEW_TIMEOUT_MS,
  aiFindingsPrompt,
  aiQuickReviewPrompt,
  aiReviewPrompt,
  aiReviewTitle,
  parseAiReview,
} from "./integrations/ai-review";
import { ForgejoError } from "./integrations/forgejo";
import type { Forgejo } from "./integrations/forgejo";
import type { Jira } from "./integrations/jira";
import { CredentialStoreError } from "./integrations/secrets";
import { IntegrationError } from "./integrations/settings";
import type { Nodes } from "./nodes/registry";
import { InvalidSubscriptionError } from "./notifications/push";
import type { Push } from "./notifications/push";
import { DevcontainerExistsError } from "./projects/onboarding";
import type { OnboardingPort } from "./projects/onboarding";
import type { StateStore } from "./projects/state";
import type { Sessions } from "./sessions/sessions";
import { localDay } from "./sessions/usage";
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
  tasks: Pick<Tasks, "startTask" | "dismissStarting" | "pickVariant">;
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
  specs?: Pick<Specs, "view">;
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
    Partial<Pick<Forgejo, "review" | "organizations" | "teams" | "image">>;
  jira?: Pick<
    Jira,
    "view" | "save" | "tickets" | "ticket" | "catalog" | "columns"
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

/** Maps the errors request handlers can expect to a status; anything else is a 500. */
const errorStatus = (err: unknown): 400 | 404 | 409 | 412 | 422 | 500 | 502 => {
  if (err instanceof IntegrationError) {
    return err.status;
  }
  if (err instanceof CredentialStoreError) {
    return 502;
  }
  if (
    err instanceof InvalidRequestError ||
    err instanceof EditorUnavailableError ||
    err instanceof InvalidSubscriptionError ||
    err instanceof InvalidNodeError ||
    err instanceof InvalidRootError
  ) {
    return 400;
  }
  if (err instanceof NotFoundError) {
    return 404;
  }
  if (
    err instanceof BusyError ||
    err instanceof AlreadyAnsweredError ||
    err instanceof DevcontainerExistsError
  ) {
    return 409;
  }
  if (err instanceof UnavailableError) {
    return 412;
  }
  if (err instanceof CommandError) {
    return 422;
  }
  return 500;
};

/** A real YYYY-MM-DD date. */
const isDay = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  localDay(new Date(`${value}T12:00:00`).getTime()) === value;

/** A path parameter of the matched route, which the route pattern guarantees. */
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const reviewMode = (c: Context): ReviewMode => {
  const mode = c.req.query("mode") ?? "working";
  if (mode !== "working" && mode !== "branch" && mode !== "turn") {
    throw new InvalidRequestError(`unknown review mode ${mode}`);
  }
  return mode;
};

/** Image bytes from a repository; `nosniff` keeps the browser from reading them as anything but the image type. */
const imageResponse = (c: Context, image: { bytes: Buffer; type: string }) =>
  c.body(new Uint8Array(image.bytes), 200, {
    "cache-control": "no-store",
    "content-type": image.type,
    "x-content-type-options": "nosniff",
  });

export const createDashboardApp = (deps: DashboardDeps): Hono => {
  const { store, hub, onboarding, push, usage, cleanup, checks, nodes } = deps;
  const app = new Hono();

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

  app.get("/api/projects", (c) => c.json(store.snapshot()));

  // Worktrees, sessions and editors answer with a result, so these wait for the work to finish.
  const json = async (
    c: Context,
    fn: (id: string, body: Record<string, unknown>) => unknown
  ) => {
    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // no or invalid body: handlers validate the fields they need
    }
    try {
      return c.json((await fn(c.req.param("id") ?? "", body)) ?? { ok: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  };

  // No Forgejo credentials enter the dashboard snapshot, logs or browser storage.
  app.use("/api/forgejo/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const requireForgejo = () => {
    if (!deps.forgejo) {
      throw new UnavailableError("Forgejo is not available");
    }
    return deps.forgejo;
  };
  app.get("/api/forgejo/settings", (c) =>
    json(c, () => requireForgejo().view())
  );
  app.post("/api/forgejo/settings", (c) =>
    json(c, (_id, b) => requireForgejo().save(b))
  );
  app.post("/api/forgejo/test", (c) =>
    json(c, (_id, b) => requireForgejo().test(b, c.req.raw.signal))
  );
  app.get("/api/forgejo/pulls", (c) =>
    json(c, () =>
      requireForgejo().inbox(
        {
          inbox: (c.req.query("inbox") ?? "authored") as ForgejoInbox,
          page: Number(c.req.query("page") ?? 1),
          org: c.req.query("org"),
          q: c.req.query("q"),
          repository: c.req.query("repository"),
          team: c.req.query("team"),
          state: (c.req.query("state") ?? "all") as ForgejoPullFilter,
        },
        c.req.raw.signal
      )
    )
  );
  app.get("/api/forgejo/orgs", (c) =>
    json(c, () => {
      const forgejo = requireForgejo();
      if (!forgejo.organizations) {
        throw new UnavailableError("Forgejo organizations are not available");
      }
      return forgejo.organizations(c.req.raw.signal);
    })
  );
  app.get("/api/forgejo/orgs/:org/teams", (c) =>
    json(c, () => {
      const forgejo = requireForgejo();
      if (!forgejo.teams) {
        throw new UnavailableError("Forgejo teams are not available");
      }
      return forgejo.teams(c.req.param("org"), c.req.raw.signal);
    })
  );
  app.post("/api/forgejo/pulls/:owner/:repo/:number/reviews", (c) =>
    json(c, (_id, b) => {
      const forgejo = requireForgejo();
      if (!forgejo.review) {
        throw new UnavailableError("Forgejo reviews are not available");
      }
      return forgejo.review(
        param(c, "owner"),
        param(c, "repo"),
        param(c, "number"),
        b
      );
    })
  );
  /** The pull request at the head commit the page shows; a moved head means the page is out of date. */
  const pullAt = async (c: Context, commitId: unknown) => {
    const details = await requireForgejo().details(
      param(c, "owner"),
      param(c, "repo"),
      param(c, "number")
    );
    if (!details.headSha || details.headSha !== commitId) {
      throw new ForgejoError(
        "The PR changed. Refresh it before starting an AI review."
      );
    }
    return details;
  };
  app.post("/api/forgejo/pulls/:owner/:repo/:number/ai-review/session", (c) =>
    json(c, async (_id, b) => {
      const details = await pullAt(c, b.commitId);
      return {
        sessionId: await hub.sessions.startSession(
          str(b.projectId) ?? "",
          str(b.directory) ?? "",
          aiReviewTitle(details),
          aiReviewPrompt(details)
        ),
      };
    })
  );
  app.post("/api/forgejo/pulls/:owner/:repo/:number/ai-review", (c) =>
    json(c, async (_id, b): Promise<AiReviewResult> => {
      const details = await pullAt(c, b.commitId);
      const sessionId = str(b.sessionId);
      let prompt = aiFindingsPrompt();
      if (!sessionId) {
        const diff = await requireForgejo().patch(
          param(c, "owner"),
          param(c, "repo"),
          param(c, "number")
        );
        prompt = aiQuickReviewPrompt(details, diff.patch);
      }
      const generated = await hub.sessions.generateIn(
        str(b.projectId) ?? "",
        str(b.directory) ?? "",
        prompt,
        {
          sessionId,
          timeoutMs: AI_REVIEW_TIMEOUT_MS,
          title: aiReviewTitle(details),
        }
      );
      try {
        return {
          sessionId: generated.sessionId,
          ...parseAiReview(generated.text),
        };
      } catch (error) {
        throw new ForgejoError(
          error instanceof Error ? error.message : String(error),
          502
        );
      }
    })
  );
  app.post("/api/forgejo/pulls/:owner/:repo/:number/worktree", (c) =>
    json(c, async (_id, b) => {
      const diff = await requireForgejo().diff(
        param(c, "owner"),
        param(c, "repo"),
        param(c, "number")
      );
      if (diff.pull.state !== "open") {
        throw new ForgejoError("This pull request is no longer open.");
      }
      if (!diff.commitId || diff.commitId !== b.commitId) {
        throw new ForgejoError(
          "The PR changed. Refresh its diff before creating a worktree."
        );
      }
      return hub.checkouts.createWorktree(str(b.projectId) ?? "", {
        branch: str(b.branch) ?? "",
        pull: {
          commitId: diff.commitId ?? "",
          number: diff.pull.number,
          url: diff.pull.url,
        },
      });
    })
  );
  app.get("/api/forgejo/pulls/:owner/:repo/:number", (c) =>
    json(c, () =>
      requireForgejo().details(
        param(c, "owner"),
        param(c, "repo"),
        param(c, "number"),
        c.req.raw.signal
      )
    )
  );
  app.get("/api/forgejo/pulls/:owner/:repo/:number/approvals", (c) =>
    json(c, () =>
      requireForgejo().approvals(
        param(c, "owner"),
        param(c, "repo"),
        param(c, "number"),
        c.req.raw.signal
      )
    )
  );
  app.get("/api/forgejo/pulls/:owner/:repo/:number/image", async (c) => {
    try {
      const side = c.req.query("side");
      if (side !== "old" && side !== "new") {
        throw new InvalidRequestError(`unknown image side ${side}`);
      }
      const forgejo = requireForgejo();
      if (!forgejo.image) {
        throw new UnavailableError("Forgejo images are not available");
      }
      const image = await forgejo.image(
        param(c, "owner"),
        param(c, "repo"),
        param(c, "number"),
        c.req.query("file") ?? "",
        side,
        c.req.raw.signal
      );
      if (!image) {
        return c.json({ error: "no such version of the image" }, 404);
      }
      return imageResponse(c, image);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  for (const resource of ["patch", "comments", "reviews"] as const) {
    app.get(`/api/forgejo/pulls/:owner/:repo/:number/${resource}`, (c) =>
      json(c, () => {
        const f = requireForgejo();
        const args = [
          param(c, "owner"),
          param(c, "repo"),
          param(c, "number"),
        ] as const;
        return resource === "patch"
          ? f.patch(...args, c.req.raw.signal)
          : f[resource](
              ...args,
              Number(c.req.query("page") ?? 1),
              c.req.raw.signal
            );
      })
    );
  }
  app.get(
    "/api/forgejo/pulls/:owner/:repo/:number/reviews/:review/comments",
    (c) =>
      json(c, () =>
        requireForgejo().reviewComments(
          param(c, "owner"),
          param(c, "repo"),
          param(c, "number"),
          param(c, "review"),
          c.req.raw.signal
        )
      )
  );
  app.get("/api/forgejo/checks/:owner/:repo/:sha", (c) =>
    json(c, () =>
      requireForgejo().checks(
        param(c, "owner"),
        param(c, "repo"),
        param(c, "sha"),
        Number(c.req.query("page") ?? 1),
        c.req.raw.signal
      )
    )
  );

  app.use("/api/jira/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const requireJira = () => {
    if (!deps.jira) {
      throw new UnavailableError("Jira is not available");
    }
    return deps.jira;
  };
  app.get("/api/jira/settings", (c) => json(c, () => requireJira().view()));
  app.post("/api/jira/settings", (c) =>
    json(c, (_id, b) => requireJira().save(b))
  );
  app.get("/api/jira/tickets", (c) =>
    json(c, () => {
      const query = parseJiraQuery(new URL(c.req.url).searchParams);
      if (!query) {
        throw new InvalidRequestError("Invalid Jira search or page.");
      }
      return requireJira().tickets(query);
    })
  );
  app.get("/api/jira/catalog", (c) => json(c, () => requireJira().catalog()));
  app.get("/api/jira/boards/:id/columns", (c) =>
    json(c, () => {
      const id = param(c, "id");
      if (!/^[1-9]\d{0,14}$/u.test(id)) {
        throw new InvalidRequestError("Invalid Jira board.");
      }
      return requireJira().columns(Number(id));
    })
  );
  app.get("/api/jira/tickets/:key", (c) =>
    json(c, () => requireJira().ticket(param(c, "key")))
  );

  app.post("/api/projects/rescan", async (c) => {
    await hub.environments.rescan();
    return c.json(store.snapshot());
  });

  app.post("/api/settings/roots", (c) =>
    json(c, async (_id, b) => {
      if (!deps.saveRoots) {
        throw new UnavailableError("Saving roots is not available");
      }
      deps.saveRoots(b.roots);
      await hub.environments.rescan();
      return store.snapshot();
    })
  );

  // Add project: repos under the roots without a devcontainer.
  app.get("/api/onboarding/candidates", async (c) =>
    c.json(await onboarding.list())
  );
  app.post("/api/onboarding", (c) =>
    json(c, async (_id, b): Promise<AddProjectResult> => {
      const added = await onboarding.add(str(b.path) ?? "", b.stack);
      await hub.environments.rescan();
      const project = store.projects().find((p) => p.path === added.path);
      if (!project) {
        throw new Error(
          `${added.path} was not discovered after writing its devcontainer.json`
        );
      }
      const { errors } = store.preflight();
      if (errors.length > 0) {
        return {
          error: errors.join("; "),
          projectId: project.id,
          started: false,
        };
      }
      hub.environments.start(project.id).catch(() => undefined);
      return { projectId: project.id, started: true };
    })
  );

  app.get("/api/usage", (c) => {
    if (!usage) {
      return c.json({ error: "usage tracking is off" }, 412);
    }
    const today = localDay(Date.now());
    const day = c.req.query("day") ?? today;
    if (!isDay(day)) {
      return c.json({ error: `not a date: ${day}` }, 400);
    }
    return c.json(usage.report(day, today));
  });

  // Cleanup scans on demand: it fetches every project's remote, so it never runs in the snapshot.
  app.get("/api/cleanup", async (c) => {
    try {
      return c.json(await cleanup.scan());
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  app.post("/api/cleanup", (c) =>
    json(c, (_id, b) => cleanup.apply(parseCleanupItems(b.items)))
  );

  const requireNodes = () => {
    if (!nodes) {
      throw new UnavailableError("remote nodes are not available");
    }
    return nodes;
  };
  app.post("/api/nodes", (c) =>
    json(c, (_id, b) => requireNodes().add({ label: b.label, ssh: b.ssh }))
  );
  app.delete("/api/nodes/:id", (c) =>
    json(c, async (id) => void (await requireNodes().remove(id)))
  );

  // Web Push: the worker's subscription, and a test notification.
  app.get("/api/push/key", (c) => c.json({ publicKey: push.publicKey() }));
  app.post("/api/push/subscribe", (c) =>
    json(c, (_id, b) => push.subscribe(b))
  );
  app.post("/api/push/unsubscribe", (c) =>
    json(c, (_id, b) => push.unsubscribe(str(b.endpoint) ?? ""))
  );
  app.post("/api/push/test", (c) =>
    json(c, async () => ({
      sent: await push.send({
        body: "Notifications work.",
        tag: "test",
        title: "opendevhub",
        url: "/",
      }),
    }))
  );

  const actions = {
    rebuild: (id: string) => hub.environments.rebuild(id),
    "rebuild-no-cache": (id: string) => hub.environments.rebuild(id, true),
    "restart-opencode": (id: string) => hub.environments.restartOpencode(id),
    start: (id: string) => hub.environments.start(id),
    stop: (id: string) => hub.environments.stop(id),
  } as const;

  for (const [route, run] of Object.entries(actions)) {
    app.post(`/api/projects/:id/${route}`, (c) => {
      if (store.preflight().errors.length > 0) {
        return c.json({ error: store.preflight().errors.join("; ") }, 412);
      }
      try {
        run(c.req.param("id")).catch(() => undefined);
        return c.json({ accepted: true }, 202);
      } catch (error) {
        if (error instanceof BusyError) {
          return c.json({ error: error.message }, 409);
        }
        if (error instanceof NotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        throw error;
      }
    });
  }

  app.post("/api/projects/:id/worktrees/refresh", (c) =>
    json(c, async (id) => ({
      worktrees: await hub.checkouts.refreshWorktrees(id),
    }))
  );
  app.post("/api/projects/:id/worktrees", (c) =>
    json(c, (id, b) =>
      hub.checkouts.createWorktree(id, {
        base: str(b.base),
        branch: str(b.branch) ?? "",
        prompt: str(b.prompt),
        startSession: b.startSession === true,
      })
    )
  );
  app.post("/api/projects/:id/worktrees/remove", (c) =>
    json(c, (id, b) =>
      hub.checkouts.removeWorktree(
        id,
        str(b.path) ?? "",
        b.force === true,
        b.deleteBranch === true
      )
    )
  );
  // A worktree's own container.
  app.post("/api/projects/:id/envs", (c) =>
    json(c, (id, b) => hub.environments.createEnv(id, str(b.path) ?? ""))
  );
  const envActions = {
    rebuild: (id: string, envId: string) =>
      hub.environments.rebuildEnv(id, envId),
    "rebuild-no-cache": (id: string, envId: string) =>
      hub.environments.rebuildEnv(id, envId, true),
    "restart-opencode": (id: string, envId: string) =>
      hub.environments.restartEnvOpencode(id, envId),
    start: (id: string, envId: string) => hub.environments.startEnv(id, envId),
    stop: (id: string, envId: string) => hub.environments.stopEnv(id, envId),
  } as const;
  for (const [route, run] of Object.entries(envActions)) {
    app.post(`/api/projects/:id/envs/:env/${route}`, (c) => {
      if (store.preflight().errors.length > 0) {
        return c.json({ error: store.preflight().errors.join("; ") }, 412);
      }
      try {
        run(c.req.param("id"), c.req.param("env")).catch(() => undefined);
        return c.json({ accepted: true }, 202);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          errorStatus(error)
        );
      }
    });
  }
  app.post("/api/projects/:id/envs/:env/remove", (c) =>
    json(c, (id) => hub.environments.removeEnv(id, c.req.param("env") ?? ""))
  );
  app.post("/api/projects/:id/sessions", (c) =>
    json(c, async (id, b) => ({
      sessionId: await hub.sessions.startSession(
        id,
        str(b.directory) ?? "",
        str(b.title),
        str(b.prompt)
      ),
    }))
  );
  app.get("/api/projects/:id/sessions/:sid", async (c) => {
    try {
      return c.json(
        await hub.sessions.sessionDetail(
          c.req.param("id"),
          c.req.param("sid") ?? ""
        )
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  app.delete("/api/projects/:id/sessions/:sid", (c) =>
    json(c, (id) => hub.sessions.removeSession(id, c.req.param("sid") ?? ""))
  );
  app.post("/api/projects/:id/sessions/:sid/prompt", (c) =>
    json(c, (id, b) =>
      hub.sessions.promptSession(
        id,
        c.req.param("sid") ?? "",
        str(b.text) ?? ""
      )
    )
  );
  app.post("/api/projects/:id/open", (c) =>
    json(c, (id, b) =>
      hub.checkouts.openInEditor(
        id,
        str(b.editor) ?? "",
        str(b.directory) ?? ""
      )
    )
  );

  // Tasks: one prompt run in one or more sessions, each usually in its own worktree.
  app.get("/api/projects/:id/models", async (c) => {
    try {
      return c.json(await hub.sessions.models(c.req.param("id")));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  // Answers once the request is checked; the snapshot's `starting` shows the setup.
  app.post("/api/projects/:id/tasks", (c) =>
    json(c, (id, b) => hub.tasks.startTask(id, b))
  );
  app.delete("/api/projects/:id/tasks/:task/starting", (c) =>
    json(c, (id) => hub.tasks.dismissStarting(id, c.req.param("task") ?? ""))
  );
  app.post("/api/projects/:id/tasks/:task/pick", (c) =>
    json(c, (id, b) =>
      hub.tasks.pickVariant(
        id,
        c.req.param("task") ?? "",
        str(b.sessionId) ?? "",
        b.removeWorktrees === true
      )
    )
  );

  // Answers to what an agent is waiting on. Sessions only forwards ids it listed itself.
  app.post("/api/projects/:id/permissions/:rid", (c) =>
    json(c, (id, b) =>
      hub.sessions.replyPermission(id, c.req.param("rid") ?? "", {
        decision: str(b.decision) ?? "",
        ...(str(b.message) ? { message: str(b.message) } : {}),
      })
    )
  );
  app.post("/api/projects/:id/forms/:fid", (c) =>
    json(c, (id, b) =>
      hub.sessions.replyForm(id, c.req.param("fid") ?? "", b.answer)
    )
  );
  app.delete("/api/projects/:id/forms/:fid", (c) =>
    json(c, (id) => hub.sessions.cancelForm(id, c.req.param("fid") ?? ""))
  );

  // Review: what a checkout changed, and the local git actions on it.
  app.get("/api/projects/:id/review", async (c) => {
    try {
      const mode = reviewMode(c);
      const data = await hub.reviews.review(
        c.req.param("id"),
        c.req.query("directory") ?? "",
        {
          base: c.req.query("base"),
          file: c.req.query("file"),
          from: c.req.query("from"),
          mode,
          session: c.req.query("session"),
        }
      );
      return c.json(data);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  // One version of a changed image, for showing it in the review instead of "binary".
  app.get("/api/projects/:id/review/image", async (c) => {
    try {
      const side = c.req.query("side");
      if (side !== "old" && side !== "new") {
        throw new InvalidRequestError(`unknown image side ${side}`);
      }
      const image = await hub.reviews.reviewImage(
        c.req.param("id"),
        c.req.query("directory") ?? "",
        {
          base: c.req.query("base"),
          file: c.req.query("file") ?? "",
          mode: reviewMode(c),
          side,
        }
      );
      if (!image) {
        return c.json({ error: "no such version of the image" }, 404);
      }
      return imageResponse(c, image);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  app.post("/api/projects/:id/review/commit-message", (c) =>
    json(c, async (id, b) => ({
      message: await hub.reviews.commitMessage(id, str(b.directory) ?? ""),
    }))
  );
  app.post("/api/projects/:id/review/commit", (c) =>
    json(c, (id, b) =>
      hub.reviews.commit(id, str(b.directory) ?? "", str(b.message) ?? "")
    )
  );
  app.post("/api/projects/:id/review/update", (c) =>
    json(c, (id, b) =>
      hub.reviews.updateFromBase(id, str(b.directory) ?? "", str(b.base) ?? "")
    )
  );
  app.post("/api/projects/:id/review/merge", (c) =>
    json(c, (id, b) =>
      hub.reviews.mergeIntoBase(
        id,
        str(b.directory) ?? "",
        str(b.base) ?? "",
        b.ffOnly === true
      )
    )
  );
  app.post("/api/projects/:id/review/bring-home", (c) =>
    json(c, (id, b) => hub.checkouts.bringHome(id, str(b.directory) ?? ""))
  );

  // Publish: push the branch and open its pull request.
  app.get("/api/projects/:id/publish", async (c) => {
    try {
      return c.json(
        await hub.reviews.publishInfo(
          c.req.param("id"),
          c.req.query("directory") ?? "",
          c.req.query("remote")
        )
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  app.post("/api/projects/:id/publish/suggest", (c) =>
    json(c, (id, b) =>
      hub.reviews.publishSuggestion(id, str(b.directory) ?? "")
    )
  );
  app.post("/api/projects/:id/publish", (c) =>
    json(c, (id, b) =>
      hub.reviews.publish(id, str(b.directory) ?? "", {
        base: str(b.base) ?? "",
        description: str(b.description) ?? "",
        remote: str(b.remote) ?? "",
        strategy: str(b.strategy) ?? "",
        title: str(b.title) ?? "",
      })
    )
  );

  // Checks: the commands a change must pass, run on one checkout.
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : undefined;
  app.get("/api/projects/:id/checks", async (c) => {
    try {
      return c.json(
        await checks.view(c.req.param("id"), c.req.query("directory"))
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });
  app.post("/api/projects/:id/checks/settings", (c) =>
    json(c, (id, b) => checks.saveSettings(id, b.checks))
  );
  app.post("/api/projects/:id/checks/run", (c) =>
    json(c, (id, b) => {
      const names = strings(b.names);
      const approve = strings(b.approve);
      return checks.start(id, str(b.directory) ?? "", {
        ...(names ? { names } : {}),
        ...(approve ? { approve } : {}),
      });
    })
  );
  app.get("/api/projects/:id/checks/run", (c) => {
    try {
      return c.json(
        checks.latest(c.req.param("id"), c.req.query("directory") ?? "")
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });

  // Spec: a checkout's OpenSpec changes, for spec-first tasks.
  app.get("/api/projects/:id/spec", async (c) => {
    try {
      if (!deps.specs) {
        throw new UnavailableError("the spec view isn't set up");
      }
      return c.json(
        await deps.specs.view(
          c.req.param("id"),
          c.req.query("directory") ?? "",
          c.req.query("change") || undefined
        )
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error)
      );
    }
  });

  app.get("/api/projects/:id/logs", (c) =>
    c.json({ lines: hub.environments.logLines(c.req.param("id")) })
  );

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const sendSnapshot = () =>
        stream.writeSSE({
          data: JSON.stringify(store.snapshot()),
          event: "snapshot",
        });
      await sendSnapshot();
      let pending: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = store.subscribe(() => {
        if (pending) {
          return;
        }
        pending = setTimeout(() => {
          pending = undefined;
          void sendSnapshot();
        }, 50);
      });
      const unlisten = hub.environments.onLog((projectId, line) => {
        const event: LogEvent = { line, projectId };
        void stream.writeSSE({ data: JSON.stringify(event), event: "log" });
      });
      const heartbeat = setInterval(
        () => void stream.writeSSE({ data: "", event: "ping" }),
        15_000
      );
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
      clearInterval(heartbeat);
      clearTimeout(pending);
      unsubscribe();
      unlisten();
    })
  );

  const { webDir } = deps;
  if (!webDir) {
    app.get("*", (c) =>
      c.text(
        "opendevhub UI is not built. Run `npm run build`, or `npm run dev:web` during development.",
        503
      )
    );
    return app;
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

  return app;
};
