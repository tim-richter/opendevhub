import { Hono } from "hono";
import type { Context } from "hono";

import type { DashboardDeps } from "../dashboard-api";
import { UnavailableError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import {
  errorStatus,
  errorResponse,
  imageResponse,
  json,
  ok,
  param,
  reviewMode,
  str,
} from "./helpers";
import { bodies, queries, validateJson, validateQuery } from "./validation";

export const createProjectsRoutes = (deps: DashboardDeps) => {
  const { store, hub, checks } = deps;
  const actions = {
    rebuild: (id: string) => hub.environments.rebuild(id),
    "rebuild-no-cache": (id: string) => hub.environments.rebuild(id, true),
    "restart-opencode": (id: string) => hub.environments.restartOpencode(id),
    start: (id: string) => hub.environments.start(id),
    stop: (id: string) => hub.environments.stop(id),
  } as const;
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
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : undefined;
  const action = (c: Context, run: () => Promise<void>) => {
    if (store.preflight().errors.length > 0) {
      return c.json({ error: store.preflight().errors.join("; ") }, 412);
    }
    try {
      run().catch(() => undefined);
      return c.json({ accepted: true }, 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  };

  return new Hono()
    .post("/api/projects/:id/name", validateJson(bodies.projectName), (c) =>
      ok(c, async (id) => {
        if (!deps.renameProject) {
          throw new UnavailableError("Renaming projects is not available");
        }
        await deps.renameProject(id, c.req.valid("json").name);
      })
    )
    .post("/api/projects/:id/rebuild", (c) =>
      action(c, () => actions["rebuild"](param(c, "id")))
    )
    .post("/api/projects/:id/rebuild-no-cache", (c) =>
      action(c, () => actions["rebuild-no-cache"](param(c, "id")))
    )
    .post("/api/projects/:id/restart-opencode", (c) =>
      action(c, () => actions["restart-opencode"](param(c, "id")))
    )
    .post("/api/projects/:id/start", (c) =>
      action(c, () => actions["start"](param(c, "id")))
    )
    .post("/api/projects/:id/stop", (c) =>
      action(c, () => actions["stop"](param(c, "id")))
    )
    .get("/api/projects/:id/branches", (c) =>
      json(c, (id) => ({ branches: hub.checkouts.branches(id) }))
    )
    .post("/api/projects/:id/worktrees/refresh", (c) =>
      json(c, async (id) => ({
        worktrees: await hub.checkouts.refreshWorktrees(id),
      }))
    )
    .post("/api/projects/:id/worktrees", validateJson(bodies.worktree), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.checkouts.createWorktree(id, {
          base: str(b.base),
          branch: str(b.branch) ?? "",
          prompt: str(b.prompt),
          startSession: b.startSession === true,
        });
      })
    )
    .post(
      "/api/projects/:id/worktrees/remove",
      validateJson(bodies.removeWorktree),
      (c) =>
        ok(c, (id) => {
          const b = c.req.valid("json");
          return hub.checkouts.removeWorktree(
            id,
            str(b.path) ?? "",
            b.force === true,
            b.deleteBranch === true
          );
        })
    )
    .post("/api/projects/:id/envs", validateJson(bodies.environment), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.environments.createEnv(id, str(b.path) ?? "");
      })
    )
    .post("/api/projects/:id/envs/:env/rebuild", (c) =>
      action(c, () => envActions["rebuild"](param(c, "id"), param(c, "env")))
    )
    .post("/api/projects/:id/envs/:env/rebuild-no-cache", (c) =>
      action(c, () =>
        envActions["rebuild-no-cache"](param(c, "id"), param(c, "env"))
      )
    )
    .post("/api/projects/:id/envs/:env/restart-opencode", (c) =>
      action(c, () =>
        envActions["restart-opencode"](param(c, "id"), param(c, "env"))
      )
    )
    .post("/api/projects/:id/envs/:env/start", (c) =>
      action(c, () => envActions["start"](param(c, "id"), param(c, "env")))
    )
    .post("/api/projects/:id/envs/:env/stop", (c) =>
      action(c, () => envActions["stop"](param(c, "id"), param(c, "env")))
    )
    .post("/api/projects/:id/envs/:env/remove", (c) =>
      ok(c, (id) => hub.environments.removeEnv(id, c.req.param("env") ?? ""))
    )
    .post("/api/projects/:id/sessions", validateJson(bodies.session), (c) =>
      json(c, async (id) => {
        const b = c.req.valid("json");
        return {
          sessionId: await hub.sessions.startSession(
            id,
            str(b.directory) ?? "",
            str(b.title),
            str(b.prompt)
          ),
        };
      })
    )
    .get("/api/projects/:id/sessions/:sid", async (c) => {
      try {
        return c.json(
          await hub.sessions.sessionDetail(
            c.req.param("id"),
            c.req.param("sid") ?? ""
          ),
          200
        );
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          errorStatus(error)
        );
      }
    })
    .delete("/api/projects/:id/sessions/:sid", (c) =>
      ok(c, (id) => hub.sessions.removeSession(id, c.req.param("sid") ?? ""))
    )
    .post(
      "/api/projects/:id/sessions/:sid/prompt",
      validateJson(bodies.prompt),
      (c) =>
        ok(c, (id) => {
          const b = c.req.valid("json");
          return hub.sessions.promptSession(
            id,
            c.req.param("sid") ?? "",
            str(b.text) ?? ""
          );
        })
    )
    .post("/api/projects/:id/open", validateJson(bodies.editor), (c) =>
      ok(c, (id) => {
        const b = c.req.valid("json");
        return hub.checkouts.openInEditor(
          id,
          str(b.editor) ?? "",
          str(b.directory) ?? ""
        );
      })
    )
    .get("/api/projects/:id/models", async (c) => {
      try {
        return c.json(await hub.sessions.models(c.req.param("id")), 200);
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          errorStatus(error)
        );
      }
    })
    .post("/api/projects/:id/tasks", validateJson(bodies.task), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.tasks.startTask(id, b);
      })
    )
    .delete("/api/projects/:id/tasks/:task/starting", (c) =>
      ok(c, (id) => hub.tasks.dismissStarting(id, c.req.param("task") ?? ""))
    )
    .post("/api/projects/:id/tasks/:task/archive", (c) =>
      ok(c, (id) => hub.tasks.archiveTask(id, c.req.param("task") ?? ""))
    )
    .post(
      "/api/projects/:id/tasks/:task/pick",
      validateJson(bodies.pick),
      (c) =>
        json(c, (id) => {
          const b = c.req.valid("json");
          return hub.tasks.pickVariant(
            id,
            c.req.param("task") ?? "",
            str(b.sessionId) ?? "",
            b.removeWorktrees === true
          );
        })
    )
    .post(
      "/api/projects/:id/permissions/:rid",
      validateJson(bodies.permission),
      (c) =>
        ok(c, (id) => {
          const b = c.req.valid("json");
          return hub.sessions.replyPermission(id, c.req.param("rid") ?? "", {
            decision: str(b.decision) ?? "",
            ...(str(b.message) ? { message: str(b.message) } : {}),
          });
        })
    )
    .post("/api/projects/:id/forms/:fid", validateJson(bodies.form), (c) =>
      ok(c, (id) => {
        const b = c.req.valid("json");
        return hub.sessions.replyForm(id, c.req.param("fid") ?? "", b.answer);
      })
    )
    .delete("/api/projects/:id/forms/:fid", (c) =>
      ok(c, (id) => hub.sessions.cancelForm(id, c.req.param("fid") ?? ""))
    )
    .get(
      "/api/projects/:id/review",
      validateQuery(queries.review),
      async (c) => {
        try {
          const mode = reviewMode(c);
          const data = await hub.reviews.review(
            c.req.param("id"),
            c.req.valid("query").directory ?? "",
            {
              base: c.req.valid("query").base,
              file: c.req.valid("query").file,
              from: c.req.valid("query").from,
              mode,
              session: c.req.valid("query").session,
            }
          );
          return c.json(data, 200);
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            errorStatus(error)
          );
        }
      }
    )
    .get(
      "/api/projects/:id/review/image",
      validateQuery(queries.reviewImage),
      async (c) => {
        try {
          const { side } = c.req.valid("query");
          if (side !== "old" && side !== "new") {
            throw new InvalidRequestError(`unknown image side ${side}`);
          }
          const image = await hub.reviews.reviewImage(
            c.req.param("id"),
            c.req.valid("query").directory ?? "",
            {
              base: c.req.valid("query").base,
              file: c.req.valid("query").file ?? "",
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
      }
    )
    .post(
      "/api/projects/:id/review/commit-message",
      validateJson(bodies.directory),
      (c) =>
        json(c, async (id) => {
          const b = c.req.valid("json");
          return {
            message: await hub.reviews.commitMessage(
              id,
              str(b.directory) ?? ""
            ),
          };
        })
    )
    .post("/api/projects/:id/review/commit", validateJson(bodies.commit), (c) =>
      ok(c, (id) => {
        const b = c.req.valid("json");
        return hub.reviews.commit(
          id,
          str(b.directory) ?? "",
          str(b.message) ?? ""
        );
      })
    )
    .post("/api/projects/:id/review/update", validateJson(bodies.update), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.reviews.updateFromBase(
          id,
          str(b.directory) ?? "",
          str(b.base) ?? ""
        );
      })
    )
    .post("/api/projects/:id/review/merge", validateJson(bodies.merge), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.reviews.mergeIntoBase(
          id,
          str(b.directory) ?? "",
          str(b.base) ?? "",
          b.ffOnly === true
        );
      })
    )
    .post(
      "/api/projects/:id/review/bring-home",
      validateJson(bodies.directory),
      (c) =>
        json(c, (id) => {
          const b = c.req.valid("json");
          return hub.checkouts.bringHome(id, str(b.directory) ?? "");
        })
    )
    .get(
      "/api/projects/:id/publish",
      validateQuery(queries.publish),
      async (c) => {
        try {
          return c.json(
            await hub.reviews.publishInfo(
              c.req.param("id"),
              c.req.valid("query").directory ?? "",
              c.req.valid("query").remote
            ),
            200
          );
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            errorStatus(error)
          );
        }
      }
    )
    .post(
      "/api/projects/:id/publish/suggest",
      validateJson(bodies.directory),
      (c) =>
        json(c, (id) => {
          const b = c.req.valid("json");
          return hub.reviews.publishSuggestion(id, str(b.directory) ?? "");
        })
    )
    .post("/api/projects/:id/publish", validateJson(bodies.publish), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.reviews.publish(id, str(b.directory) ?? "", {
          base: str(b.base) ?? "",
          description: str(b.description) ?? "",
          remote: str(b.remote) ?? "",
          strategy: str(b.strategy) ?? "",
          title: str(b.title) ?? "",
        });
      })
    )
    .get(
      "/api/projects/:id/checks",
      validateQuery(queries.directory),
      async (c) => {
        try {
          return c.json(
            await checks.view(
              c.req.param("id"),
              c.req.valid("query").directory
            ),
            200
          );
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            errorStatus(error)
          );
        }
      }
    )
    .post(
      "/api/projects/:id/checks/settings",
      validateJson(bodies.checks),
      (c) =>
        json(c, (id) => {
          const b = c.req.valid("json");
          return checks.saveSettings(id, b.checks);
        })
    )
    .post("/api/projects/:id/checks/run", validateJson(bodies.runChecks), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        const names = strings(b.names);
        const approve = strings(b.approve);
        return checks.start(id, str(b.directory) ?? "", {
          ...(names ? { names } : {}),
          ...(approve ? { approve } : {}),
        });
      })
    )
    .get(
      "/api/projects/:id/checks/run",
      validateQuery(queries.directory),
      (c) => {
        try {
          return c.json(
            checks.latest(
              c.req.param("id"),
              c.req.valid("query").directory ?? ""
            ),
            200
          );
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            errorStatus(error)
          );
        }
      }
    )
    .get("/api/projects/:id/spec", validateQuery(queries.spec), async (c) => {
      try {
        if (!deps.specs) {
          throw new UnavailableError("the spec view isn't set up");
        }
        return c.json(
          await deps.specs.view(
            c.req.param("id"),
            c.req.valid("query").directory ?? "",
            c.req.valid("query").change || undefined
          ),
          200
        );
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          errorStatus(error)
        );
      }
    })
    .post(
      "/api/projects/:id/spec/revise",
      validateJson(bodies.reviseSpec),
      (c) =>
        ok(c, (id) => {
          if (!deps.specs) {
            throw new UnavailableError("the spec view isn't set up");
          }
          const b = c.req.valid("json");
          return deps.specs.revise(
            id,
            str(b.directory) ?? "",
            b.change,
            b.feedback
          );
        })
    )
    .post(
      "/api/projects/:id/spec/approve",
      validateJson(bodies.approveSpec),
      (c) =>
        ok(c, (id) => {
          if (!deps.specs) {
            throw new UnavailableError("the spec view isn't set up");
          }
          const b = c.req.valid("json");
          return deps.specs.approve(
            id,
            str(b.directory) ?? "",
            b.change,
            b.force ?? false
          );
        })
    )
    .post(
      "/api/projects/:id/spec/implement",
      validateJson(bodies.implementSpec),
      (c) =>
        json(c, (id) => {
          if (!deps.specs) {
            throw new UnavailableError("the spec view isn't set up");
          }
          const b = c.req.valid("json");
          return deps.specs.implement(
            id,
            str(b.directory) ?? "",
            b.change,
            b.variants,
            b.force ?? false
          );
        })
    )
    .post(
      "/api/projects/:id/spec/archive",
      validateJson(bodies.archiveSpec),
      (c) =>
        ok(c, (id) => {
          if (!deps.specs) {
            throw new UnavailableError("the spec view isn't set up");
          }
          const b = c.req.valid("json");
          return deps.specs.archive(id, str(b.directory) ?? "", b.change);
        })
    )
    .get("/api/projects/:id/logs", (c) =>
      c.json({ lines: hub.environments.logLines(c.req.param("id")) }, 200)
    );
};
