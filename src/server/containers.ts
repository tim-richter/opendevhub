import path from "node:path";
import type { RunResult, Runner } from "./exec";

export const LABEL = "opendevhub.project";

/** Task containers carry these instead of LABEL, so a project's own lookups never find them. */
export const ENV_LABEL = "opendevhub.env";
export const ENV_PROJECT_LABEL = "opendevhub.env-project";

export function envLabels(envId: string, projectId: string): string[] {
  return [`${ENV_LABEL}=${envId}`, `${ENV_PROJECT_LABEL}=${projectId}`];
}

/**
 * The container a devcontainer CLI call addresses. A Project is one: its main environment, found by
 * `opendevhub.project=<id>`. A task environment sets its own labels and the generated config.
 */
export interface ExecTarget {
  id: string;
  /** Host folder passed as --workspace-folder. */
  path: string;
  /** Defaults to `opendevhub.project=<id>`. */
  idLabels?: string[];
  /** A generated devcontainer.json that replaces the repo's (task environments). */
  overrideConfig?: string;
}
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
  remoteUser?: string;
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
        ...(typeof parsed.remoteUser === "string" ? { remoteUser: parsed.remoteUser } : {}),
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

export interface PortConfig {
  forwardPorts: unknown[];
  portsAttributes: Record<string, unknown>;
  /** The devcontainer.json as read, before features and the image label are merged in. */
  configuration?: Record<string, unknown>;
}

export interface ContainerInfo {
  id: string;
  name?: string;
  running: boolean;
  ip?: string;
  /** Name of the Docker network `ip` belongs to. */
  network?: string;
  projectId?: string;
  /** Bind mount targets inside the container, keyed by target with their host source. */
  binds?: Record<string, string>;
  /** Set on task containers. */
  envId?: string;
  envProjectId?: string;
  /** The image it was created from. */
  image?: string;
}

export function parseInspect(json: string): ContainerInfo {
  const c = JSON.parse(json) as {
    Id: string;
    Name?: string;
    State?: { Running?: boolean };
    Mounts?: { Type?: string; Source?: string; Destination?: string }[] | null;
    Config?: { Image?: string; Labels?: Record<string, string> | null };
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  };
  const [network, ip] =
    Object.entries(c.NetworkSettings?.Networks ?? {})
      .map(([name, n]) => [name, n.IPAddress] as const)
      .find(([, a]) => !!a) ?? [];
  const binds: Record<string, string> = {};
  for (const m of c.Mounts ?? []) if (m.Type === "bind" && m.Source && m.Destination) binds[m.Destination] = m.Source;
  const info: ContainerInfo = {
    id: c.Id,
    name: c.Name?.replace(/^\//, ""),
    running: c.State?.Running === true,
    ip,
    projectId: c.Config?.Labels?.[LABEL],
    envId: c.Config?.Labels?.[ENV_LABEL],
    envProjectId: c.Config?.Labels?.[ENV_PROJECT_LABEL],
    image: c.Config?.Image,
    binds,
  };
  for (const k of ["envId", "envProjectId", "image"] as const) if (info[k] === undefined) delete info[k];
  if (network) info.network = network;
  return info;
}

/** The last `{"outcome": …}` line the devcontainer CLI printed. */
function lastOutcome(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof parsed.outcome === "string") return parsed;
    } catch {
      // not JSON
    }
  }
  return undefined;
}

export class Containers {
  constructor(private readonly run: Runner) {}

  private idArgs(t: ExecTarget): string[] {
    const args = ["--workspace-folder", t.path];
    for (const label of t.idLabels ?? [`${LABEL}=${t.id}`]) args.push("--id-label", label);
    if (t.overrideConfig) args.push("--override-config", t.overrideConfig);
    return args;
  }

  async up(
    target: ExecTarget,
    opts: { rebuild: boolean; onLine: (line: string) => void; mounts?: string[] },
  ): Promise<UpResult> {
    const args = ["up", ...this.idArgs(target)];
    if (opts.rebuild) args.push("--remove-existing-container");
    // Only applied when the container is created; an existing container keeps its mounts.
    for (const m of opts.mounts ?? []) args.push("--mount", m);
    const result = await this.run("devcontainer", args, { timeoutMs: UP_TIMEOUT_MS, onLine: opts.onLine });
    return parseUpOutput(result, `/workspaces/${path.basename(target.path)}`);
  }

  async readConfiguration(target: ExecTarget): Promise<PortConfig> {
    const r = await this.run(
      "devcontainer",
      ["read-configuration", ...this.idArgs(target), "--include-merged-configuration"],
      { timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) {
      throw new CommandError(`devcontainer read-configuration failed (exit ${r.exitCode})`, tailLines(r.stderr));
    }
    let parsed: { configuration?: Record<string, unknown>; mergedConfiguration?: Record<string, unknown> };
    try {
      parsed = JSON.parse(r.stdout.trim()) as typeof parsed;
    } catch {
      throw new CommandError("devcontainer read-configuration returned invalid JSON", tailLines(r.stdout));
    }
    const cfg = parsed.mergedConfiguration ?? parsed.configuration ?? {};
    const attrs = cfg.portsAttributes;
    return {
      forwardPorts: Array.isArray(cfg.forwardPorts) ? cfg.forwardPorts : [],
      portsAttributes: attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : {},
      ...(parsed.configuration ? { configuration: parsed.configuration } : {}),
    };
  }

  /** The workspace folder `up` will use, read before the container exists (undefined if it can't be read). */
  async workspaceFolder(target: ExecTarget): Promise<string | undefined> {
    const r = await this.run("devcontainer", ["read-configuration", ...this.idArgs(target)], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) return undefined;
    try {
      const parsed = JSON.parse(r.stdout.trim()) as { workspace?: { workspaceFolder?: unknown } };
      const folder = parsed.workspace?.workspaceFolder;
      return typeof folder === "string" && folder.startsWith("/") ? folder : undefined;
    } catch {
      return undefined;
    }
  }

  async inspect(containerId: string): Promise<ContainerInfo | undefined> {
    const r = await this.run("docker", ["inspect", "--type", "container", "--format", "{{json .}}", containerId], {
      timeoutMs: DOCKER_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) return undefined;
    return parseInspect(r.stdout.trim());
  }

  async listManaged(): Promise<ContainerInfo[]> {
    const ids: string[] = [];
    for (const label of [LABEL, ENV_LABEL]) {
      const r = await this.run("docker", ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.ID}}"], {
        timeoutMs: DOCKER_TIMEOUT_MS,
      });
      if (r.exitCode !== 0) throw new CommandError(`docker ps failed: ${r.stderr.trim()}`, tailLines(r.stderr));
      for (const id of r.stdout.split(/\s+/).filter(Boolean)) if (!ids.includes(id)) ids.push(id);
    }
    const infos = await Promise.all(ids.map((id) => this.inspect(id)));
    return infos.filter((i): i is ContainerInfo => i !== undefined);
  }

  /** The devcontainer.json a folder would use, with the CLI's variables filled in, and where it would mount the folder. */
  async readConfig(folder: string): Promise<{ configuration: Record<string, unknown>; workspaceFolder?: string }> {
    const r = await this.run("devcontainer", ["read-configuration", "--workspace-folder", folder], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      throw new CommandError(`devcontainer read-configuration failed (exit ${r.exitCode})`, tailLines(r.stderr));
    }
    let parsed: { configuration?: Record<string, unknown>; workspace?: { workspaceFolder?: unknown } };
    try {
      parsed = JSON.parse(r.stdout.trim()) as typeof parsed;
    } catch {
      throw new CommandError("devcontainer read-configuration returned invalid JSON", tailLines(r.stdout));
    }
    const { configFilePath: _file, ...configuration } = parsed.configuration ?? {};
    const workspaceFolder = parsed.workspace?.workspaceFolder;
    return { configuration, ...(typeof workspaceFolder === "string" ? { workspaceFolder } : {}) };
  }

  /** Builds the image a folder's config describes (Dockerfile and features), without a container or lifecycle commands. */
  async build(folder: string, imageName: string, onLine: (line: string) => void): Promise<void> {
    const r = await this.run("devcontainer", ["build", "--workspace-folder", folder, "--image-name", imageName], {
      timeoutMs: UP_TIMEOUT_MS,
      onLine,
    });
    const outcome = lastOutcome(r.stdout);
    if (r.exitCode === 0 && outcome?.outcome === "success") return;
    const reason = outcome?.message ?? outcome?.description ?? (r.timedOut ? "timed out after 15 minutes" : `exit ${r.exitCode}`);
    throw new CommandError(`devcontainer build failed: ${String(reason)}`, tailLines(`${r.stderr}\n${r.stdout}`));
  }

  async imageExists(ref: string): Promise<boolean> {
    const r = await this.run("docker", ["image", "inspect", "--format", "{{.Id}}", ref], { timeoutMs: DOCKER_TIMEOUT_MS });
    return r.exitCode === 0;
  }

  /** Removes a container, stopping it first. One that is already gone counts as removed. */
  async remove(containerId: string): Promise<void> {
    const r = await this.run("docker", ["rm", "-f", containerId], { timeoutMs: 30_000 });
    if (r.exitCode !== 0 && !/No such container/i.test(r.stderr)) {
      throw new CommandError(`docker rm failed: ${r.stderr.trim()}`, tailLines(r.stderr));
    }
  }

  /** Best effort: false when the image is in use or gone. */
  async removeImage(ref: string): Promise<boolean> {
    const r = await this.run("docker", ["image", "rm", ref], { timeoutMs: 30_000 });
    return r.exitCode === 0;
  }

  async stop(containerId: string): Promise<void> {
    const r = await this.run("docker", ["stop", "-t", "10", containerId], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new CommandError(`docker stop failed: ${r.stderr.trim()}`, tailLines(r.stderr));
  }

  exec(
    target: ExecTarget,
    command: string[],
    opts: { env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const args = ["exec", ...this.idArgs(target)];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--remote-env", `${k}=${v}`);
    return this.run("devcontainer", [...args, ...command], { timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS });
  }
}
