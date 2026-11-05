import { Hono } from "hono";

import type { DashboardDeps } from "../dashboard-api";
import { UnavailableError } from "../errors";
import { LOCAL_NODE } from "../nodes/host";
import { json } from "./helpers";
import { queries, validateQuery } from "./validation";

/** What `opendevhub attach`/`exec`/`up`/`ls` ask the running server; the CLI runs `docker exec` itself. */
export const createCliRoutes = (deps: DashboardDeps) => {
  const { hub } = deps;
  return new Hono()
    .get("/api/cli/target", validateQuery(queries.cliTarget), (c) =>
      json(c, async () => {
        const { dir, name } = c.req.valid("query");
        const target = await hub.environments.cliTarget(dir, name);
        if (!target.exec || target.node === LOCAL_NODE) {
          return target;
        }
        const ssh = deps.nodeSsh?.(target.node);
        if (!ssh) {
          throw new UnavailableError(`node ${target.node} is offline`);
        }
        return { ...target, exec: { ...target.exec, ssh } };
      })
    )
    .get("/api/cli/envs", validateQuery(queries.cliEnvs), (c) =>
      json(c, () => hub.environments.cliEnvs(c.req.valid("query").dir))
    );
};
