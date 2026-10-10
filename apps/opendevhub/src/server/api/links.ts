import { Hono } from "hono";

import type { PullLinks, TicketLinks } from "../../shared/types";
import type { DashboardDeps } from "../dashboard-api";
import { json } from "./helpers";
import { queries, validateQuery } from "./validation";

/** What opendevhub links to a pull request or a ticket; empty for one it never touched. */
export const createLinksRoutes = (deps: DashboardDeps) =>
  new Hono()
    .get("/api/links/pull", validateQuery(queries.linkPull), (c) =>
      json(
        c,
        (): PullLinks =>
          deps.links?.forPull(c.req.valid("query").url) ?? {
            branches: [],
            reviewTasks: [],
            reviews: [],
          }
      )
    )
    .get("/api/links/ticket", validateQuery(queries.linkTicket), (c) =>
      json(c, (): TicketLinks => {
        const { instance, key } = c.req.valid("query");
        return deps.links?.forTicket(instance, key) ?? { tasks: [] };
      })
    );
