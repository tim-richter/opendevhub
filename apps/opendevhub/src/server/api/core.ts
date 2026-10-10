import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { AddProjectResult, LogEvent } from "../../shared/types";
import type { DashboardDeps } from "../dashboard-api";
import { UnavailableError } from "../errors";
import { localDay } from "../sessions/usage";
import { errorStatus, isDay, json, ok, str } from "./helpers";
import { bodies, queries, validateJson, validateQuery } from "./validation";

export const createCoreRoutes = (deps: DashboardDeps) => {
  const { store, hub, onboarding, push, usage, cleanup, nodes, gitSetup } =
    deps;
  const requireNodes = () => {
    if (!nodes) {
      throw new UnavailableError("remote nodes are not available");
    }
    return nodes;
  };
  const requireGitSetup = () => {
    if (!gitSetup) {
      throw new UnavailableError("git settings are not available");
    }
    return gitSetup;
  };
  return new Hono()
    .get("/api/projects", (c) => c.json(store.snapshot(), 200))
    .post("/api/projects/rescan", async (c) => {
      await hub.environments.rescan();
      return c.json(store.snapshot(), 200);
    })
    .post("/api/settings/roots", validateJson(bodies.roots), (c) =>
      json(c, async (_id) => {
        const b = c.req.valid("json");
        if (!deps.saveRoots) {
          throw new UnavailableError("Saving roots is not available");
        }
        deps.saveRoots(b.roots);
        await hub.environments.rescan();
        return store.snapshot();
      })
    )
    .get("/api/settings/git", (c) => json(c, (_id) => requireGitSetup().view()))
    .post("/api/settings/git/test", validateJson(bodies.sshTest), (c) =>
      json(c, (_id) => requireGitSetup().test(c.req.valid("json").host))
    )
    .get("/api/onboarding/candidates", async (c) =>
      c.json(await onboarding.list(), 200)
    )
    .post("/api/onboarding", validateJson(bodies.onboarding), (c) =>
      json(c, async (_id): Promise<AddProjectResult> => {
        const b = c.req.valid("json");
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
    )
    .get("/api/usage", validateQuery(queries.usage), (c) => {
      if (!usage) {
        return c.json({ error: "usage tracking is off" }, 412);
      }
      const today = localDay(Date.now());
      const day = c.req.valid("query").day ?? today;
      if (!isDay(day)) {
        return c.json({ error: `not a date: ${day}` }, 400);
      }
      return c.json(usage.report(day, today), 200);
    })
    .get("/api/cleanup", async (c) => {
      try {
        return c.json(await cleanup.scan(), 200);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          errorStatus(error)
        );
      }
    })
    .post("/api/cleanup", validateJson(bodies.cleanup), (c) =>
      json(c, (_id) => {
        const b = c.req.valid("json");
        return cleanup.apply(b.items);
      })
    )
    .post("/api/nodes", validateJson(bodies.node), (c) =>
      json(c, (_id) => {
        const b = c.req.valid("json");
        return requireNodes().add({ label: b.label, ssh: b.ssh });
      })
    )
    .delete("/api/nodes/:id", (c) =>
      ok(c, async (id) => void (await requireNodes().remove(id)))
    )
    .get("/api/push/key", (c) => c.json({ publicKey: push.publicKey() }, 200))
    .post("/api/push/subscribe", validateJson(bodies.subscription), (c) =>
      ok(c, (_id) => {
        const b = c.req.valid("json");
        return push.subscribe(b);
      })
    )
    .post("/api/push/unsubscribe", validateJson(bodies.unsubscribe), (c) =>
      ok(c, (_id) => {
        const b = c.req.valid("json");
        return push.unsubscribe(str(b.endpoint) ?? "");
      })
    )
    .post("/api/push/test", (c) =>
      json(c, async () => ({
        sent: await push.send({
          body: "Notifications work.",
          tag: "test",
          title: "opendevhub",
          url: "/",
        }),
      }))
    )
    .get("/api/events", (c) =>
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
};
