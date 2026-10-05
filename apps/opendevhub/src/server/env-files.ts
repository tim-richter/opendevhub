import fs from "node:fs/promises";
import path from "node:path";
import type { EnvId } from "../shared/types";

const ENV_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The generated devcontainer.json of each task environment, one folder per environment. */
export class EnvFiles {
  constructor(private readonly dir: string) {}

  path(envId: EnvId): string {
    return path.join(this.folder(envId), "devcontainer.json");
  }

  async write(envId: EnvId, config: Record<string, unknown>): Promise<string> {
    const file = this.path(envId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n");
    return file;
  }

  async remove(envId: EnvId): Promise<void> {
    await fs.rm(this.folder(envId), { recursive: true, force: true });
  }

  private folder(envId: EnvId): string {
    if (!ENV_ID.test(envId)) throw new Error(`invalid environment id ${envId}`);
    return path.join(this.dir, envId);
  }
}
