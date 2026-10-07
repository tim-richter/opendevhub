import fs from "node:fs/promises";
import path from "node:path";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AddProjectResult, LogEvent } from "../shared/types";
import type { ForgejoInbox, ForgejoPullFilter } from "../shared/forgejo";
import type { Checks } from "./checks";
import { type Cleanup, parseCleanupItems } from "./cleanup";
import { InvalidNodeError } from "./config";
import { CommandError } from "./containers";
import { EditorUnavailableError } from "./editors";
import { AlreadyAnsweredError, BusyError, NotFoundError, type Orchestrator, UnavailableError } from "./orchestrator";
import type { Nodes } from "./nodes";
import { localDay, type UsageStore } from "./usage";
import { InvalidRequestError } from "./worktrees";
import { DevcontainerExistsError, type OnboardingPort } from "./onboarding";
import { InvalidSubscriptionError, type Push } from "./push";
import type { StateStore } from "./state";
import { ForgejoError, type Forgejo } from "./forgejo";
import { IntegrationError } from "./integration-settings";
import type { Jira } from "./jira";
import { CredentialStoreError } from "./secrets";

export type DashboardOrchestrator = Pick<
  Orchestrator,
  | "start"
  | "stop"
  | "rebuild"
  | "restartOpencode"
  | "rescan"
  | "logLines"
  | "onLog"
  | "refreshWorktrees"
  | "createWorktree"
  | "removeWorktree"
  | "startSession"
  | "openInEditor"
  | "replyPermission"
  | "replyForm"
  | "cancelForm"
  | "review"
  | "promptSession"
  | "removeSession"
  | "commitMessage"
  | "commit"
  | "updateFromBase"
  | "mergeIntoBase"
  | "bringHome"
  | "publishInfo"
  | "publishSuggestion"
  | "publish"
  | "models"
  | "startTask"
  | "dismissStarting"
  | "pickVariant"
  | "createEnv"
  | "startEnv"
  | "stopEnv"
  | "rebuildEnv"
  | "restartEnvOpencode"
  | "removeEnv"
>;

export type PushPort = Pick<Push, "publicKey" | "subscribe" | "unsubscribe" | "send">;

export interface DashboardDeps {
  store: StateStore;
  orchestrator: DashboardOrchestrator;
  onboarding: OnboardingPort;
  push: PushPort;
  cleanup: Pick<Cleanup, "scan" | "apply">;
  checks: Pick<Checks, "view" | "latest" | "start" | "saveSettings">;
  /** Absent when the usage ledger couldn't be opened. */
  usage?: Pick<UsageStore, "report">;
  /** Absent in tests that don't need it. */
  nodes?: Pick<Nodes, "add" | "remove">;
  forgejo?: Pick<Forgejo, "view" | "save" | "pulls" | "diff" | "inbox" | "details" | "patch" | "comments" | "reviews" | "reviewComments" | "checks" | "test"> & Partial<Pick<Forgejo, "review">>;
  jira?: Pick<Jira, "view" | "save" | "tickets" | "ticket">;
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

/** Maps the errors request handlers can expect to a status; anything else is a 500. */
function errorStatus(err: unknown): 400 | 404 | 409 | 412 | 422 | 500 | 502 {
  if (err instanceof IntegrationError) return err.status;
  if (err instanceof CredentialStoreError) return 502;
  if (err instanceof InvalidRequestError || err instanceof EditorUnavailableError || err instanceof InvalidSubscriptionError || err instanceof InvalidNodeError) return 400;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof BusyError || err instanceof AlreadyAnsweredError || err instanceof DevcontainerExistsError) return 409;
  if (err instanceof UnavailableError) return 412;
  if (err instanceof CommandError) return 422;
  return 500;
}

/** A real YYYY-MM-DD date. */
function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && localDay(new Date(`${value}T12:00:00`).getTime()) === value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createDashboardApp(deps: DashboardDeps): Hono {
  const { store, orchestrator, onboarding, push, usage, cleanup, checks, nodes } = deps;
  const app = new Hono();

  // X-Frame-Options blocks the dashboard from being framed by another site. The Origin check
  // blocks cross-site state-changing requests (e.g. a form on another page POSTing to our
  // actions) — safe methods are exempt since they don't mutate state and top-level navigations
  // don't send an Origin header at all.
  app.use("*", async (c, next) => {
    c.header("X-Frame-Options", "DENY");
    const method = c.req.method;
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
  const json = async (c: Context, fn: (id: string, body: Record<string, unknown>) => Promise<unknown>) => {
    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      // no or invalid body: handlers validate the fields they need
    }
    try {
      return c.json((await fn(c.req.param("id") ?? "", body)) ?? { ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
    }
  };

  // No Forgejo credentials enter the dashboard snapshot, logs or browser storage.
  app.use("/api/forgejo/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const requireForgejo = () => {
    if (!deps.forgejo) throw new UnavailableError("Forgejo is not available");
    return deps.forgejo;
  };
  app.get("/api/forgejo/settings", (c) => json(c, async () => requireForgejo().view()));
  app.post("/api/forgejo/settings", (c) => json(c, async (_id, b) => requireForgejo().save(b)));
  app.post("/api/forgejo/test", (c) => json(c, (_id, b) => requireForgejo().test(b, c.req.raw.signal)));
  app.get("/api/forgejo/pulls", (c) => json(c, () => requireForgejo().inbox({
    state: (c.req.query("state") ?? "all") as ForgejoPullFilter, inbox: (c.req.query("inbox") ?? "authored") as ForgejoInbox,
    q: c.req.query("q"), repository: c.req.query("repository"), page: Number(c.req.query("page") ?? 1),
  }, c.req.raw.signal)));
  app.post("/api/forgejo/pulls/:owner/:repo/:number/reviews", (c) => json(c, async (_id, b) => {
    const forgejo = requireForgejo();
    if (!forgejo.review) throw new UnavailableError("Forgejo reviews are not available");
    return forgejo.review(c.req.param("owner")!, c.req.param("repo")!, c.req.param("number")!, b);
  }));
  app.post("/api/forgejo/pulls/:owner/:repo/:number/worktree", (c) => json(c, async (_id, b) => {
    const diff = await requireForgejo().diff(c.req.param("owner")!, c.req.param("repo")!, c.req.param("number")!);
    if (diff.pull.state !== "open") throw new ForgejoError("This pull request is no longer open.");
    if (!diff.commitId || diff.commitId !== b.commitId) throw new ForgejoError("The PR changed. Refresh its diff before creating a worktree.");
    return orchestrator.createWorktree(str(b.projectId) ?? "", {
      branch: str(b.branch) ?? "",
      pull: { url: diff.pull.url, number: diff.pull.number, commitId: diff.commitId ?? "" },
    });
  }));
  app.get("/api/forgejo/pulls/:owner/:repo/:number", (c) => json(c, () =>
    requireForgejo().details(c.req.param("owner")!, c.req.param("repo")!, c.req.param("number")!, c.req.raw.signal),
  ));
  for (const resource of ["patch", "comments", "reviews"] as const) {
    app.get(`/api/forgejo/pulls/:owner/:repo/:number/${resource}`, (c) => json(c, () => {
      const f = requireForgejo();
      const args = [c.req.param("owner")!, c.req.param("repo")!, c.req.param("number")!] as const;
      return resource === "patch" ? f.patch(...args, c.req.raw.signal) : f[resource](...args, Number(c.req.query("page") ?? 1), c.req.raw.signal);
    }));
  }
  app.get("/api/forgejo/pulls/:owner/:repo/:number/reviews/:review/comments", (c) => json(c, () =>
    requireForgejo().reviewComments(c.req.param("owner")!, c.req.param("repo")!, c.req.param("number")!, c.req.param("review")!, c.req.raw.signal),
  ));
  app.get("/api/forgejo/checks/:owner/:repo/:sha", (c) => json(c, () =>
    requireForgejo().checks(c.req.param("owner")!, c.req.param("repo")!, c.req.param("sha")!, Number(c.req.query("page") ?? 1), c.req.raw.signal),
  ));

  app.use("/api/jira/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const requireJira = () => {
    if (!deps.jira) throw new UnavailableError("Jira is not available");
    return deps.jira;
  };
  app.get("/api/jira/settings", (c) => json(c, async () => requireJira().view()));
  app.post("/api/jira/settings", (c) => json(c, async (_id, b) => requireJira().save(b)));
  app.get("/api/jira/tickets", (c) => json(c, async () => {
    const page = c.req.query("startAt") ?? "0";
    if (!/^\d+$/.test(page)) throw new InvalidRequestError("Invalid Jira page.");
    return requireJira().tickets(c.req.query("search") ?? "", Number(page));
  }));
  app.get("/api/jira/tickets/:key", (c) => json(c, async () => requireJira().ticket(c.req.param("key")!)));

  app.post("/api/projects/rescan", async (c) => {
    await orchestrator.rescan();
    return c.json(store.snapshot());
  });

  // Add project: repos under the roots without a devcontainer.
  app.get("/api/onboarding/candidates", async (c) => c.json(await onboarding.list()));
  app.post("/api/onboarding", (c) =>
    json(c, async (_id, b): Promise<AddProjectResult> => {
      const added = await onboarding.add(str(b.path) ?? "", b.stack);
      await orchestrator.rescan();
      const project = store.projects().find((p) => p.path === added.path);
      if (!project) throw new Error(`${added.path} was not discovered after writing its devcontainer.json`);
      const errors = store.preflight().errors;
      if (errors.length > 0) return { projectId: project.id, started: false, error: errors.join("; ") };
      orchestrator.start(project.id).catch(() => {});
      return { projectId: project.id, started: true };
    }),
  );

  app.get("/api/usage", (c) => {
    if (!usage) return c.json({ error: "usage tracking is off" }, 412);
    const today = localDay(Date.now());
    const day = c.req.query("day") ?? today;
    if (!isDay(day)) return c.json({ error: `not a date: ${day}` }, 400);
    return c.json(usage.report(day, today));
  });

  // Cleanup scans on demand: it fetches every project's remote, so it never runs in the snapshot.
  app.get("/api/cleanup", async (c) => {
    try {
      return c.json(await cleanup.scan());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
    }
  });
  app.post("/api/cleanup", (c) => json(c, (_id, b) => cleanup.apply(parseCleanupItems(b.items))));

  const requireNodes = () => {
    if (!nodes) throw new UnavailableError("remote nodes are not available");
    return nodes;
  };
  app.post("/api/nodes", (c) => json(c, (_id, b) => requireNodes().add({ ssh: b.ssh, label: b.label })));
  app.delete("/api/nodes/:id", (c) => json(c, async (id) => void (await requireNodes().remove(id))));

  // Web Push: the worker's subscription, and a test notification.
  app.get("/api/push/key", (c) => c.json({ publicKey: push.publicKey() }));
  app.post("/api/push/subscribe", (c) => json(c, async (_id, b) => push.subscribe(b)));
  app.post("/api/push/unsubscribe", (c) => json(c, async (_id, b) => push.unsubscribe(str(b.endpoint) ?? "")));
  app.post("/api/push/test", (c) =>
    json(c, async () => ({ sent: await push.send({ tag: "test", title: "opendevhub", body: "Notifications work.", url: "/" }) })),
  );

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

  app.post("/api/projects/:id/worktrees/refresh", (c) =>
    json(c, async (id) => ({ worktrees: await orchestrator.refreshWorktrees(id) })),
  );
  app.post("/api/projects/:id/worktrees", (c) =>
    json(c, (id, b) =>
      orchestrator.createWorktree(id, {
        branch: str(b.branch) ?? "",
        base: str(b.base),
        startSession: b.startSession === true,
        prompt: str(b.prompt),
      }),
    ),
  );
  app.post("/api/projects/:id/worktrees/remove", (c) =>
    json(c, (id, b) => orchestrator.removeWorktree(id, str(b.path) ?? "", b.force === true, b.deleteBranch === true)),
  );
  // A worktree's own container.
  app.post("/api/projects/:id/envs", (c) => json(c, (id, b) => orchestrator.createEnv(id, str(b.path) ?? "")));
  const envActions = {
    start: (id: string, envId: string) => orchestrator.startEnv(id, envId),
    stop: (id: string, envId: string) => orchestrator.stopEnv(id, envId),
    rebuild: (id: string, envId: string) => orchestrator.rebuildEnv(id, envId),
    "restart-opencode": (id: string, envId: string) => orchestrator.restartEnvOpencode(id, envId),
  } as const;
  for (const [route, run] of Object.entries(envActions)) {
    app.post(`/api/projects/:id/envs/:env/${route}`, (c) => {
      if (store.preflight().errors.length > 0) {
        return c.json({ error: store.preflight().errors.join("; ") }, 412);
      }
      try {
        run(c.req.param("id"), c.req.param("env")).catch(() => {});
        return c.json({ accepted: true }, 202);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
      }
    });
  }
  app.post("/api/projects/:id/envs/:env/remove", (c) => json(c, (id) => orchestrator.removeEnv(id, c.req.param("env") ?? "")));
  app.post("/api/projects/:id/sessions", (c) =>
    json(c, async (id, b) => ({
      sessionId: await orchestrator.startSession(id, str(b.directory) ?? "", str(b.title), str(b.prompt)),
    })),
  );
  app.delete("/api/projects/:id/sessions/:sid", (c) => json(c, (id) => orchestrator.removeSession(id, c.req.param("sid") ?? "")));
  app.post("/api/projects/:id/sessions/:sid/prompt", (c) =>
    json(c, (id, b) => orchestrator.promptSession(id, c.req.param("sid") ?? "", str(b.text) ?? "")),
  );
  app.post("/api/projects/:id/open", (c) =>
    json(c, (id, b) => orchestrator.openInEditor(id, str(b.editor) ?? "", str(b.directory) ?? "")),
  );

  // Tasks: one prompt run in one or more sessions, each usually in its own worktree.
  app.get("/api/projects/:id/models", async (c) => {
    try {
      return c.json(await orchestrator.models(c.req.param("id")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
    }
  });
  // Answers once the request is checked; the snapshot's `starting` shows the setup.
  app.post("/api/projects/:id/tasks", (c) => json(c, (id, b) => orchestrator.startTask(id, b)));
  app.delete("/api/projects/:id/tasks/:task/starting", (c) =>
    json(c, async (id) => orchestrator.dismissStarting(id, c.req.param("task") ?? "")),
  );
  app.post("/api/projects/:id/tasks/:task/pick", (c) =>
    json(c, (id, b) => orchestrator.pickVariant(id, c.req.param("task") ?? "", str(b.sessionId) ?? "", b.removeWorktrees === true)),
  );

  // Answers to what an agent is waiting on. The orchestrator only forwards ids it listed itself.
  app.post("/api/projects/:id/permissions/:rid", (c) =>
    json(c, (id, b) =>
      orchestrator.replyPermission(id, c.req.param("rid") ?? "", {
        decision: str(b.decision) ?? "",
        ...(str(b.message) ? { message: str(b.message) } : {}),
      }),
    ),
  );
  app.post("/api/projects/:id/forms/:fid", (c) => json(c, (id, b) => orchestrator.replyForm(id, c.req.param("fid") ?? "", b.answer)));
  app.delete("/api/projects/:id/forms/:fid", (c) => json(c, (id) => orchestrator.cancelForm(id, c.req.param("fid") ?? "")));

  // Review: what a checkout changed, and the local git actions on it.
  app.get("/api/projects/:id/review", async (c) => {
    try {
      const mode = c.req.query("mode") ?? "working";
      if (mode !== "working" && mode !== "branch") throw new InvalidRequestError(`unknown review mode ${mode}`);
      const data = await orchestrator.review(c.req.param("id"), c.req.query("directory") ?? "", {
        base: c.req.query("base"),
        mode,
        file: c.req.query("file"),
      });
      return c.json(data);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
    }
  });
  app.post("/api/projects/:id/review/commit-message", (c) =>
    json(c, async (id, b) => ({ message: await orchestrator.commitMessage(id, str(b.directory) ?? "") })),
  );
  app.post("/api/projects/:id/review/commit", (c) =>
    json(c, (id, b) => orchestrator.commit(id, str(b.directory) ?? "", str(b.message) ?? "")),
  );
  app.post("/api/projects/:id/review/update", (c) =>
    json(c, (id, b) => orchestrator.updateFromBase(id, str(b.directory) ?? "", str(b.base) ?? "")),
  );
  app.post("/api/projects/:id/review/merge", (c) =>
    json(c, (id, b) => orchestrator.mergeIntoBase(id, str(b.directory) ?? "", str(b.base) ?? "", b.ffOnly === true)),
  );
  app.post("/api/projects/:id/review/bring-home", (c) => json(c, (id, b) => orchestrator.bringHome(id, str(b.directory) ?? "")));

  // Publish: push the branch and open its pull request.
  app.get("/api/projects/:id/publish", async (c) => {
    try {
      return c.json(await orchestrator.publishInfo(c.req.param("id"), c.req.query("directory") ?? "", c.req.query("remote")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
    }
  });
  app.post("/api/projects/:id/publish/suggest", (c) =>
    json(c, (id, b) => orchestrator.publishSuggestion(id, str(b.directory) ?? "")),
  );
  app.post("/api/projects/:id/publish", (c) =>
    json(c, (id, b) =>
      orchestrator.publish(id, str(b.directory) ?? "", {
        remote: str(b.remote) ?? "",
        base: str(b.base) ?? "",
        strategy: str(b.strategy) ?? "",
        title: str(b.title) ?? "",
        description: str(b.description) ?? "",
      }),
    ),
  );

  // Checks: the commands a change must pass, run on one checkout.
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined);
  app.get("/api/projects/:id/checks", async (c) => {
    try {
      return c.json(await checks.view(c.req.param("id"), c.req.query("directory")));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
    }
  });
  app.post("/api/projects/:id/checks/settings", (c) => json(c, (id, b) => checks.saveSettings(id, b.checks)));
  app.post("/api/projects/:id/checks/run", (c) =>
    json(c, (id, b) => {
      const names = strings(b.names);
      const approve = strings(b.approve);
      return checks.start(id, str(b.directory) ?? "", { ...(names ? { names } : {}), ...(approve ? { approve } : {}) });
    }),
  );
  app.get("/api/projects/:id/checks/run", (c) => {
    try {
      return c.json(checks.latest(c.req.param("id"), c.req.query("directory") ?? ""));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errorStatus(err));
    }
  });

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
