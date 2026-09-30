import path from "node:path";
import type { Project } from "../shared/types";
import type { RunResult, Runner } from "./exec";

export const LABEL = "opendevhub.project";
const UP_TIMEOUT_MS = 15 * 60_000;
const EXEC_TIMEOUT_MS = 30_000;
const DOCKER_TIMEOUT_MS = 15_000;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly tail: string[] = [],
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export function tailLines(text: string, n = 20): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

export interface UpResult {
  containerId: string;
  remoteWorkspaceFolder: string;
}

export function parseUpOutput(result: RunResult, fallbackFolder: string): UpResult {
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(candidates[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.outcome === "success" && typeof parsed.containerId === "string") {
      return {
        containerId: parsed.containerId,
        remoteWorkspaceFolder:
          typeof parsed.remoteWorkspaceFolder === "string" ? parsed.remoteWorkspaceFolder : fallbackFolder,
      };
    }
    if (typeof parsed.outcome === "string") {
      const reason = parsed.message ?? parsed.description ?? "unknown error";
      throw new CommandError(`devcontainer up failed: ${String(reason)}`, tailLines(result.stderr));
    }
  }
  if (result.timedOut) throw new CommandError("devcontainer up timed out after 15 minutes", tailLines(result.stderr));
  throw new CommandError(
    `devcontainer up exited with code ${result.exitCode} without a result`,
    tailLines(`${result.stderr}\n${result.stdout}`),
  );
}

export interface ContainerInfo {
  id: string;
  running: boolean;
  ip?: string;
  projectId?: string;
}

export function parseInspect(json: string): ContainerInfo {
  const c = JSON.parse(json) as {
    Id: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> | null };
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  };
  const ip = Object.values(c.NetworkSettings?.Networks ?? {})
    .map((n) => n.IPAddress)
    .find((a): a is string => !!a);
  return { id: c.Id, running: c.State?.Running === true, ip, projectId: c.Config?.Labels?.[LABEL] };
}

export class Containers {
  constructor(private readonly run: Runner) {}

  private idArgs(project: Project): string[] {
    return ["--workspace-folder", project.path, "--id-label", `${LABEL}=${project.id}`];
  }

  async up(project: Project, opts: { rebuild: boolean; onLine: (line: string) => void }): Promise<UpResult> {
    const args = ["up", ...this.idArgs(project)];
    if (opts.rebuild) args.push("--remove-existing-container");
    const result = await this.run("devcontainer", args, { timeoutMs: UP_TIMEOUT_MS, onLine: opts.onLine });
    return parseUpOutput(result, `/workspaces/${path.basename(project.path)}`);
  }

  async inspect(containerId: string): Promise<ContainerInfo | undefined> {
    const r = await this.run("docker", ["inspect", "--type", "container", "--format", "{{json .}}", containerId], {
      timeoutMs: DOCKER_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) return undefined;
    return parseInspect(r.stdout.trim());
  }

  async listManaged(): Promise<ContainerInfo[]> {
    const r = await this.run("docker", ["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.ID}}"], {
      timeoutMs: DOCKER_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) throw new CommandError(`docker ps failed: ${r.stderr.trim()}`, tailLines(r.stderr));
    const ids = r.stdout.split(/\s+/).filter(Boolean);
    const infos = await Promise.all(ids.map((id) => this.inspect(id)));
    return infos.filter((i): i is ContainerInfo => i !== undefined);
  }

  async stop(containerId: string): Promise<void> {
    const r = await this.run("docker", ["stop", "-t", "10", containerId], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new CommandError(`docker stop failed: ${r.stderr.trim()}`, tailLines(r.stderr));
  }

  exec(
    project: Project,
    command: string[],
    opts: { env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const args = ["exec", ...this.idArgs(project)];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--remote-env", `${k}=${v}`);
    return this.run("devcontainer", [...args, ...command], { timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS });
  }
}
