import { randomBytes } from "node:crypto";
import type { Project } from "../../shared/types";
import { CommandError, type Containers, tailLines } from "../containers";
import type { OpencodeClient, OpencodeEndpoint } from "./client";

export const OPENCODE_PORT = 4096;
const LOG_FILE = "/tmp/opendevhub-opencode.log";
const KILL_SERVER = "pkill -f 'opencode [s]erve' || true";

export function parseOpencodeVersion(output: string): string | undefined {
  return output.match(/(\d+)\.(\d+)\.(\d+)/)?.[0];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RuntimeDeps {
  containers: Pick<Containers, "exec">;
  clientFor: (ep: OpencodeEndpoint) => OpencodeClient;
  port?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  generatePassword?: () => string;
}

export class OpencodeRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  endpoint(ip: string, password: string): OpencodeEndpoint {
    return { baseUrl: `http://${ip}:${this.deps.port ?? OPENCODE_PORT}`, password };
  }

  async isHealthy(ep: OpencodeEndpoint): Promise<boolean> {
    try {
      await this.deps.clientFor(ep).info();
      return true;
    } catch {
      return false;
    }
  }

  async ensureRunning(
    project: Project,
    args: { ip: string; password?: string; workspaceFolder: string; onLine: (line: string) => void },
  ): Promise<{ password: string; version: string }> {
    if (args.password) {
      try {
        const info = await this.deps.clientFor(this.endpoint(args.ip, args.password)).info();
        return { password: args.password, version: info.version };
      } catch {
        // not running or different password: relaunch below
      }
    }

    const { containers } = this.deps;
    const versionRun = await containers.exec(project, ["opencode", "--version"]);
    if (versionRun.exitCode !== 0) {
      throw new CommandError(
        "opencode is not installed in the devcontainer (expected opencode v2 on PATH)",
        tailLines(versionRun.stderr + versionRun.stdout),
      );
    }
    const version = parseOpencodeVersion(versionRun.stdout);
    if (!version || Number(version.split(".")[0]) < 2) {
      throw new CommandError(`opencode ${version ?? "(unknown version)"} found, but opendevhub requires opencode v2`);
    }
    args.onLine(`opencode ${version} found in container`);

    const password = this.deps.generatePassword?.() ?? randomBytes(32).toString("base64url");
    const port = this.deps.port ?? OPENCODE_PORT;
    await containers.exec(project, ["sh", "-c", KILL_SERVER]);
    const script =
      `cd ${shellQuote(args.workspaceFolder)} && ` +
      `nohup opencode serve --hostname 0.0.0.0 --port ${port} < /dev/null > ${LOG_FILE} 2>&1 &`;
    const launch = await containers.exec(project, ["sh", "-c", script], { env: { OPENCODE_PASSWORD: password } });
    if (launch.exitCode !== 0) {
      throw new CommandError("failed to launch opencode serve", tailLines(launch.stderr + launch.stdout));
    }
    args.onLine(`launched opencode serve on port ${port}; waiting for health`);

    const ep = this.endpoint(args.ip, password);
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (await this.isHealthy(ep)) return { password, version };
      await new Promise((r) => setTimeout(r, this.deps.healthIntervalMs ?? 500));
    }
    const log = await containers.exec(project, ["sh", "-c", `tail -n 20 ${LOG_FILE} 2>/dev/null`]);
    throw new CommandError("opencode did not become healthy within 30 s", tailLines(log.stdout));
  }

  async stopServer(project: Project): Promise<void> {
    await this.deps.containers.exec(project, ["sh", "-c", KILL_SERVER]);
  }
}
