import { Hono } from "hono";
import type { Context } from "hono";

import type { DashboardDeps } from "../dashboard-api";
import { NotFoundError, UnavailableError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import {
  AI_REVIEW_TIMEOUT_MS,
  aiFindingsPrompt,
  parseAiReview,
} from "../integrations/ai-review";
import { startOcrLog } from "../ocr/logs";
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

const todoId = (id: string): number => {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new NotFoundError(id, "to-do");
  }
  return n;
};

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
  const requireTodos = () => {
    if (!deps.todos) {
      throw new UnavailableError("To-do lists are not available");
    }
    return deps.todos;
  };
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

  /**
   * A container start or rebuild: fails at once (409) when the checkout's config needs approval, and approving it
   * runs the same action again; otherwise runs in the background like any action.
   */
  const startAction = async (
    c: Context,
    envId: string | undefined,
    run: () => Promise<void>
  ) => {
    if (store.preflight().errors.length > 0) {
      return action(c, run);
    }
    try {
      await hub.environments.checkConfig(
        param(c, "id"),
        envId,
        () => void run().catch(() => undefined)
      );
    } catch (error) {
      return errorResponse(c, error);
    }
    return action(c, run);
  };

  return new Hono()
    .post("/api/projects/:id/name", validateJson(bodies.projectName), (c) =>
      ok(c, async (id) => {
        if (!deps.renameProject) {
          throw new UnavailableError("Renaming projects is not available");
        }
        const { name, scope } = c.req.valid("json");
        await deps.renameProject(id, name, scope);
      })
    )
    .post(
      "/api/projects/:id/appearance",
      validateJson(bodies.projectAppearance),
      (c) =>
        json(c, (id) => {
          if (!deps.projectAppearance) {
            throw new UnavailableError("Project appearance is not available");
          }
          const appearance = c.req.valid("json");
          return deps.projectAppearance.save(
            id,
            {
              shortName: appearance.shortName || undefined,
              color: appearance.color || undefined,
            },
            appearance.scope
          );
        })
    )
    .get("/api/projects/:id/ports", (c) =>
      json(c, (id) => {
        if (!deps.projectPorts) {
          throw new UnavailableError("Project ports are not available");
        }
        return { ports: deps.projectPorts.get(id) };
      })
    )
    .post("/api/projects/:id/ports", validateJson(bodies.projectPorts), (c) =>
      json(c, async (id) => {
        if (!deps.projectPorts) {
          throw new UnavailableError("Project ports are not available");
        }
        const { ports, scope } = c.req.valid("json");
        await deps.projectPorts.save(id, ports, scope);
        return { ports: deps.projectPorts.get(id) };
      })
    )
    .get("/api/projects/:id/host-ports", (c) =>
      json(c, (id) => {
        if (!deps.projectHostPorts) {
          throw new UnavailableError("Project host ports are not available");
        }
        return { ports: deps.projectHostPorts.get(id) };
      })
    )
    .post(
      "/api/projects/:id/host-ports",
      validateJson(bodies.projectHostPorts),
      (c) =>
        json(c, async (id) => {
          if (!deps.projectHostPorts) {
            throw new UnavailableError("Project host ports are not available");
          }
          await deps.projectHostPorts.save(id, c.req.valid("json").ports);
          return { ports: deps.projectHostPorts.get(id) };
        })
    )
    .get("/api/settings/personalization", (c) =>
      json(c, () => {
        if (!deps.personalization) {
          throw new UnavailableError("Personalization is not available");
        }
        return deps.personalization.get();
      })
    )
    .put(
      "/api/settings/personalization",
      validateJson(bodies.personalization),
      (c) =>
        json(c, () => {
          if (!deps.personalization) {
            throw new UnavailableError("Personalization is not available");
          }
          return deps.personalization.save(c.req.valid("json"));
        })
    )
    .get("/api/projects/:id/personalization", (c) =>
      json(c, (id) => {
        if (!deps.projectPersonalization) {
          throw new UnavailableError("Personalization is not available");
        }
        return deps.projectPersonalization.get(id);
      })
    )
    .put(
      "/api/projects/:id/personalization",
      validateJson(bodies.projectPersonalization),
      (c) =>
        json(c, (id) => {
          if (!deps.projectPersonalization) {
            throw new UnavailableError("Personalization is not available");
          }
          return deps.projectPersonalization.save(id, c.req.valid("json"));
        })
    )
    .get("/api/projects/:id/links", (c) =>
      json(c, (id) => {
        if (!deps.projectLinks) {
          throw new UnavailableError("Project links are not available");
        }
        return deps.projectLinks.get(id);
      })
    )
    .post("/api/projects/:id/links", validateJson(bodies.projectLinks), (c) =>
      json(c, (id) => {
        if (!deps.projectLinks) {
          throw new UnavailableError("Project links are not available");
        }
        const { scope, ...links } = c.req.valid("json");
        deps.projectLinks.save(id, links, scope);
        return deps.projectLinks.get(id);
      })
    )
    .get("/api/projects/:id/team-settings", (c) =>
      json(c, (id) => {
        if (!deps.projectTeam) {
          throw new UnavailableError("Team settings are not available");
        }
        return deps.projectTeam.get(id);
      })
    )
    .get("/api/projects/:id/todos", (c) =>
      json(c, (id) => ({ todos: requireTodos().list(id) }))
    )
    .post("/api/projects/:id/todos", validateJson(bodies.todo), (c) =>
      json(c, (id) => requireTodos().add(id, c.req.valid("json").text))
    )
    .patch(
      "/api/projects/:id/todos/:todo",
      validateJson(bodies.todoUpdate),
      (c) =>
        json(c, (id) =>
          requireTodos().update(
            id,
            todoId(param(c, "todo")),
            c.req.valid("json")
          )
        )
    )
    .delete("/api/projects/:id/todos/:todo", (c) =>
      ok(c, (id) => requireTodos().remove(id, todoId(param(c, "todo"))))
    )
    .post("/api/projects/:id/rebuild", (c) =>
      startAction(c, undefined, () => actions["rebuild"](param(c, "id")))
    )
    .post("/api/projects/:id/rebuild-no-cache", (c) =>
      startAction(c, undefined, () =>
        actions["rebuild-no-cache"](param(c, "id"))
      )
    )
    .post("/api/projects/:id/restart-opencode", (c) =>
      action(c, () => actions["restart-opencode"](param(c, "id")))
    )
    .post("/api/projects/:id/start", (c) =>
      startAction(c, undefined, () => actions["start"](param(c, "id")))
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
    .post(
      "/api/projects/:id/config-approvals",
      validateJson(bodies.configApproval),
      (c) =>
        ok(c, (id) =>
          hub.environments.approveConfig(id, c.req.valid("json").fingerprint)
        )
    )
    .delete("/api/projects/:id/config-approvals/:fingerprint", (c) =>
      ok(c, (id) => hub.environments.refuseConfig(id, param(c, "fingerprint")))
    )
    .post("/api/projects/:id/envs", validateJson(bodies.environment), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.environments.createEnv(id, str(b.path) ?? "");
      })
    )
    .post("/api/projects/:id/envs/:env/rebuild", (c) =>
      startAction(c, param(c, "env"), () =>
        envActions["rebuild"](param(c, "id"), param(c, "env"))
      )
    )
    .post("/api/projects/:id/envs/:env/rebuild-no-cache", (c) =>
      startAction(c, param(c, "env"), () =>
        envActions["rebuild-no-cache"](param(c, "id"), param(c, "env"))
      )
    )
    .post("/api/projects/:id/envs/:env/restart-opencode", (c) =>
      action(c, () =>
        envActions["restart-opencode"](param(c, "id"), param(c, "env"))
      )
    )
    .post("/api/projects/:id/envs/:env/start", (c) =>
      startAction(c, param(c, "env"), () =>
        envActions["start"](param(c, "id"), param(c, "env"))
      )
    )
    .post("/api/projects/:id/envs/:env/stop", (c) =>
      action(c, () => envActions["stop"](param(c, "id"), param(c, "env")))
    )
    .get(
      "/api/projects/:id/envs/:env/logs",
      validateQuery(queries.envLogs),
      (c) =>
        json(c, (id) => {
          const q = c.req.valid("query");
          return hub.environments.envLogs(
            id,
            param(c, "env"),
            q.source,
            q.lines
          );
        })
    )
    .post("/api/projects/:id/envs/:env/remove", (c) =>
      ok(c, (id) => hub.environments.removeEnv(id, c.req.param("env") ?? ""))
    )
    .post("/api/projects/:id/sessions", validateJson(bodies.session), (c) =>
      json(c, (id) => {
        const b = c.req.valid("json");
        return hub.sessions.startSession(
          id,
          str(b.directory) ?? "",
          str(b.title),
          str(b.prompt)
        );
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
    .delete("/api/projects/:id/sessions/:sid/shells/:shid", (c) =>
      ok(c, (id) =>
        hub.sessions.killShell(
          id,
          c.req.param("sid") ?? "",
          c.req.param("shid") ?? ""
        )
      )
    )
    .post("/api/projects/:id/sessions/:sid/task-conversation", (c) =>
      json(c, (id) =>
        hub.sessions.startTaskConversation(id, c.req.param("sid") ?? "")
      )
    )
    .post("/api/projects/:id/sessions/:sid/archive", (c) =>
      ok(c, (id) =>
        hub.sessions.archiveTaskConversation(id, c.req.param("sid") ?? "")
      )
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
    .post(
      "/api/projects/:id/sessions/:sid/send",
      validateJson(bodies.composerSend),
      (c) =>
        json(c, (id) =>
          hub.sessions.sendMessage(
            id,
            c.req.param("sid") ?? "",
            c.req.valid("json")
          )
        )
    )
    .post("/api/projects/:id/chat", validateJson(bodies.chat), (c) =>
      json(c, (id) => hub.chat.start(id, c.req.valid("json")))
    )
    .get("/api/projects/:id/chats/:chat", (c) =>
      json(c, (id) => hub.chat.lookup(id, c.req.param("chat") ?? ""))
    )
    .post("/api/projects/:id/chats/:chat/archive", (c) =>
      ok(c, (id) => hub.chat.archive(id, c.req.param("chat") ?? ""))
    )
    .get("/api/projects/:id/chats/:chat/brief", (c) =>
      json(c, (id) => hub.chat.brief(id, c.req.param("chat") ?? ""))
    )
    .get("/api/projects/:id/chats/:chat/suggestions", (c) =>
      json(c, (id) => hub.chat.suggestions(id, c.req.param("chat") ?? ""))
    )
    .post(
      "/api/projects/:id/chats/:chat/task",
      validateJson(bodies.makeTask),
      (c) =>
        json(c, (id) =>
          hub.chat.makeTask(id, c.req.param("chat") ?? "", c.req.valid("json"))
        )
    )
    .get(
      "/api/projects/:id/composer/commands",
      validateQuery(queries.directory),
      (c) =>
        json(c, async (id) => ({
          commands: await hub.sessions.composerCommands(
            id,
            c.req.valid("query").directory ?? ""
          ),
        }))
    )
    .get(
      "/api/projects/:id/composer/agents",
      validateQuery(queries.directory),
      (c) =>
        json(c, async (id) => ({
          agents: await hub.sessions.composerAgents(
            id,
            c.req.valid("query").directory ?? ""
          ),
        }))
    )
    .get(
      "/api/projects/:id/composer/files",
      validateQuery(queries.files),
      (c) =>
        json(c, async (id) => ({
          files: await hub.sessions.findFiles(
            id,
            c.req.valid("query").directory ?? "",
            c.req.valid("query").query
          ),
        }))
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
    .post("/api/projects/:id/drafts", validateJson(bodies.task), (c) =>
      json(c, (id) => hub.tasks.createDraft(id, c.req.valid("json")))
    )
    .post(
      "/api/projects/:id/drafts/ticket",
      validateJson(bodies.draftFromTicket),
      (c) => json(c, (id) => hub.tasks.draftFromTicket(id, c.req.valid("json")))
    )
    .put(
      "/api/projects/:id/tasks/:task/draft",
      validateJson(bodies.task),
      (c) =>
        ok(c, (id) =>
          hub.tasks.editDraft(
            id,
            c.req.param("task") ?? "",
            c.req.valid("json")
          )
        )
    )
    .post(
      "/api/projects/:id/tasks/:task/start",
      validateJson(bodies.task),
      (c) =>
        json(c, (id) =>
          hub.tasks.startDraft(
            id,
            c.req.param("task") ?? "",
            c.req.valid("json")
          )
        )
    )
    .delete("/api/projects/:id/tasks/:task/starting", (c) =>
      ok(c, (id) => hub.tasks.dismissStarting(id, c.req.param("task") ?? ""))
    )
    .post("/api/projects/:id/tasks/:task/archive", (c) =>
      ok(c, (id) => hub.tasks.archiveTask(id, c.req.param("task") ?? ""))
    )
    .get("/api/projects/:id/tasks/archived", (c) =>
      json(c, (id) => hub.tasks.archivedTasks(id))
    )
    .post("/api/projects/:id/tasks/:task/restore", (c) =>
      ok(c, (id) => hub.tasks.restoreTask(id, c.req.param("task") ?? ""))
    )
    .delete("/api/projects/:id/tasks/:task", (c) =>
      ok(c, (id) => hub.tasks.deleteArchivedTask(id, c.req.param("task") ?? ""))
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
    .post(
      "/api/projects/:id/review/ai-session",
      validateJson(bodies.localAiReview),
      (c) =>
        json(c, async (id) => {
          const input = c.req.valid("json");
          const data = await hub.reviews.review(id, input.directory, {
            base: input.base,
            mode: input.mode,
          });
          if (!data.files.length) {
            throw new InvalidRequestError("There are no changes to review.");
          }
          const scope =
            data.mode === "branch"
              ? `all changes compared with ${data.base?.name ?? input.base}`
              : "uncommitted changes, including new files";
          const prompt = [
            `Review ${scope} in this checkout before a pull request is created.`,
            "Read the diff and surrounding code. Run relevant tests if useful. Do not edit, commit, or push anything.",
            "Look for bugs, regressions, unhandled edge cases, security problems, and missing tests for risky logic. Skip formatter and linter issues. Do not praise.",
            "For each finding, note severity and a short actionable comment. Include a file and line only for a specific line; otherwise use a general comment. End with a short summary.",
          ].join("\n\n");
          return hub.sessions.startInCheckout(
            id,
            input.directory,
            "Review changes",
            prompt,
            input.sessionId
          );
        })
    )
    .post(
      "/api/projects/:id/review/ai-findings",
      validateJson(bodies.localAiFindings),
      (c) =>
        json(c, async (id) => {
          const { directory, sessionId } = c.req.valid("json");
          const generated = await hub.sessions.generateIn(
            id,
            directory,
            aiFindingsPrompt(),
            {
              sessionId,
              timeoutMs: AI_REVIEW_TIMEOUT_MS,
              title: "Review findings",
            }
          );
          return {
            ...parseAiReview(generated.text),
            sessionId: generated.sessionId,
          };
        })
    )
    .post(
      "/api/projects/:id/review/ocr",
      validateJson(bodies.localAiReview),
      (c) =>
        json(c, async (id) => {
          if (!deps.ocr) {
            throw new UnavailableError("Open Code Review is not available");
          }
          const input = c.req.valid("json");
          if (input.runId) {
            startOcrLog(input.runId);
          }
          const data = await hub.reviews.review(id, input.directory, {
            base: input.base,
            mode: input.mode,
          });
          if (!data.files.length) {
            throw new InvalidRequestError("There are no changes to review.");
          }
          return deps.ocr.service.reviewLocal({
            projectId: id,
            directory: input.directory,
            mode: data.mode === "branch" ? "branch" : "working",
            base: data.base?.name,
            runId: input.runId,
          });
        })
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
          return checks.saveSettings(id, b.checks, b.scope);
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
    .post(
      "/api/projects/:id/checks/cancel",
      validateJson(bodies.cancelCheck),
      (c) =>
        json(c, (id) => {
          const b = c.req.valid("json");
          return checks.cancel(id, str(b.directory) ?? "", b.name);
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
            c.req.valid("query").change || undefined,
            c.req.valid("query").session || undefined
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
            b.feedback,
            b.session
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
            b.force ?? false,
            b.newConversation ?? true,
            b.session
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
            b.force ?? false,
            b.session
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
          return deps.specs.archive(
            id,
            str(b.directory) ?? "",
            b.change,
            b.session
          );
        })
    )
    .get("/api/projects/:id/logs", (c) =>
      c.json({ lines: hub.environments.logLines(c.req.param("id")) }, 200)
    );
};
