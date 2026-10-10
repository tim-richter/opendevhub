import { Hono } from "hono";

import { ACTIVITY_PAGE_SIZE, OBJECT_TYPES } from "../../shared/activity";
import type {
  ActivityPage,
  ObjectType,
  Provenance,
} from "../../shared/activity";
import type { DashboardDeps } from "../dashboard-api";
import { NotFoundError, UnavailableError } from "../errors";
import { json, param } from "./helpers";
import { queries, validateQuery } from "./validation";

const isObjectType = (value: string): value is ObjectType =>
  (OBJECT_TYPES as readonly string[]).includes(value);

/** The event feed, and where each entity came from. */
export const createActivityRoutes = (deps: DashboardDeps) =>
  new Hono()
    .get("/api/activity", validateQuery(queries.activity), (c) =>
      json(c, (): ActivityPage => {
        if (!deps.activity) {
          throw new UnavailableError("the activity log is not available");
        }
        const q = c.req.valid("query");
        const colon = q.entity?.indexOf(":") ?? -1;
        const entityType = q.entity?.slice(0, colon) ?? "";
        return deps.activity.page(
          {
            ...(q.project ? { projectId: q.project } : {}),
            ...(q.task ? { taskId: q.task } : {}),
            ...(q.entity && isObjectType(entityType)
              ? { entity: { id: q.entity.slice(colon + 1), type: entityType } }
              : {}),
          },
          q.before === undefined ? undefined : Number(q.before),
          q.limit === undefined ? ACTIVITY_PAGE_SIZE : Number(q.limit)
        );
      })
    )
    .get("/api/provenance/:type/:id", (c) =>
      json(c, (): Provenance => {
        if (!deps.provenance) {
          throw new UnavailableError("provenance is not available");
        }
        const type = param(c, "type");
        if (!isObjectType(type)) {
          throw new NotFoundError(type, "entity type");
        }
        return deps.provenance.of(type, param(c, "id"));
      })
    );
