import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Access } from "../../src/server/access";

/** An Access over a throwaway state folder, with the `Cookie` headers a granted browser would send. */
export const testAccess = (now?: () => number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-access-"));
  const access = new Access(dir, now);
  return {
    access,
    /** The dashboard's `Cookie` header. */
    cookie: `odh=${access.dashboardCookie()}`,
    /** An environment host's `Cookie` header. */
    envCookie: (envId: string) => `odh_env=${access.envCookie(envId)}`,
    dir,
  };
};
