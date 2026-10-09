import fs from "node:fs/promises";
import path from "node:path";

import type { EnvId } from "../../shared/types";
import type { Host } from "../nodes/host";

const ENV_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** The generated devcontainer.json of each task environment, one folder per environment, here or on a node. */
export class EnvFiles {
  private readonly dir: string;
  private readonly host?: Pick<Host, "run" | "writeFile">;
  constructor(dir: string, host?: Pick<Host, "run" | "writeFile">) {
    this.dir = dir;
    this.host = host;
  }

  path(envId: EnvId): string {
    return path.posix.join(this.folder(envId), "devcontainer.json");
  }

  async write(envId: EnvId, config: Record<string, unknown>): Promise<string> {
    const file = this.path(envId);
    const content = `${JSON.stringify(config, null, 2)}\n`;
    if (this.host) {
      await this.host.writeFile(file, content);
      return file;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  }

  async remove(envId: EnvId): Promise<void> {
    const folder = this.folder(envId);
    if (!this.host) {
      await fs.rm(folder, { force: true, recursive: true });
      return;
    }
    const r = await this.host.run("rm", ["-rf", "--", folder], {
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `removing ${folder} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`
      );
    }
  }

  private folder(envId: EnvId): string {
    if (!ENV_ID.test(envId)) {
      throw new Error(`invalid environment id ${envId}`);
    }
    return path.posix.join(this.dir, envId);
  }
}
