import { Hono } from "hono";

import { parseJiraQuery } from "../../shared/jira";
import type { DashboardDeps } from "../dashboard-api";
import { UnavailableError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import { json, param } from "./helpers";
import { bodies, queries, validateJson, validateQuery } from "./validation";

export const createJiraRoutes = (deps: DashboardDeps) => {
  const requireJira = () => {
    if (!deps.jira) {
      throw new UnavailableError("Jira is not available");
    }
    return deps.jira;
  };
  return new Hono()
    .use("/api/jira/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/api/jira/settings", (c) => json(c, () => requireJira().view()))
    .post("/api/jira/settings", validateJson(bodies.integration), (c) =>
      json(c, (_id) => {
        const b = c.req.valid("json");
        return requireJira().save(b);
      })
    )
    .get("/api/jira/tickets", validateQuery(queries.jira), (c) =>
      json(c, () => {
        const query = parseJiraQuery(new URL(c.req.url).searchParams);
        if (!query) {
          throw new InvalidRequestError("Invalid Jira search or page.");
        }
        return requireJira().tickets(query);
      })
    )
    .get("/api/jira/catalog", (c) => json(c, () => requireJira().catalog()))
    .get("/api/jira/boards/:id/columns", (c) =>
      json(c, () => {
        const id = param(c, "id");
        if (!/^[1-9]\d{0,14}$/u.test(id)) {
          throw new InvalidRequestError("Invalid Jira board.");
        }
        return requireJira().columns(Number(id));
      })
    )
    .get("/api/jira/tickets/:key", (c) =>
      json(c, () => requireJira().ticket(param(c, "key")))
    );
};
