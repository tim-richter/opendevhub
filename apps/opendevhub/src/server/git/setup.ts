import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  GitIdentityView,
  GitSetup,
  SshHostView,
  SshKeyView,
  SshTestResult,
} from "../../shared/git-setup";
import type { Project } from "../../shared/types";
import { NotFoundError } from "../errors";
import type { Runner } from "../nodes/exec";

const TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 15_000;
const SSH_ERROR_EXIT = 255;
const DEFAULT_SSH_PORT = "22";

/** `256 SHA256:abc… comment (ED25519)`, as `ssh-add -l` and `ssh-keygen -l` print a key. */
const KEY_LINE =
  /^(?<bits>\d+)\s+(?<fingerprint>\S+)\s+(?<comment>.*?)\s*\((?<type>[^()]+)\)$/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SCP_LIKE = /^(?:(?<user>[^@/\s]+)@)?(?<host>[^:/\s]+):(?!\/)/u;

interface SshRemote {
  user?: string;
  hostname: string;
  port: string;
}

/** The ssh user, host and port of a git remote URL; undefined for https and local remotes. */
export const sshRemote = (url: string): SshRemote | undefined => {
  if (SCHEME.test(url)) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if ((u.protocol !== "ssh:" && u.protocol !== "git+ssh:") || !u.hostname) {
      return undefined;
    }
    return {
      hostname: u.hostname.replaceAll(/^\[|\]$/gu, ""),
      port: u.port || DEFAULT_SSH_PORT,
      ...(u.username ? { user: decodeURIComponent(u.username) } : {}),
    };
  }
  const m = url.match(SCP_LIKE)?.groups;
  if (!m?.host) {
    return undefined;
  }
  return {
    hostname: m.host,
    port: DEFAULT_SSH_PORT,
    ...(m.user ? { user: m.user } : {}),
  };
};

/** How known_hosts names a host: `host`, or `[host]:port` off port 22. */
const knownHostsName = (r: SshRemote): string =>
  r.port === DEFAULT_SSH_PORT ? r.hostname : `[${r.hostname}]:${r.port}`;

export const parseKeyLines = (out: string): SshKeyView[] =>
  out
    .split("\n")
    .map((line) => line.trim().match(KEY_LINE)?.groups)
    .filter((g) => g !== undefined)
    .map((g) => ({
      bits: Number(g.bits),
      comment: g.comment ?? "",
      fingerprint: g.fingerprint ?? "",
      type: g.type ?? "",
    }));

/** The values of `key` in `ssh -G` output, in order. */
export const sshOption = (out: string, key: string): string[] =>
  out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${key} `))
    .map((line) => line.slice(key.length + 1).trim());

export interface GitSetupDeps {
  run: Runner;
  projects: () => Project[];
  /** Defaults to the user's home directory. */
  home?: string;
}

/** Reads this machine's git identity and ssh keys, and which key each project's git host would get. */
export class GitSetupProbe {
  private readonly deps: GitSetupDeps;
  private readonly home: string;
  constructor(deps: GitSetupDeps) {
    this.deps = deps;
    this.home = deps.home ?? os.homedir();
  }

  async view(): Promise<GitSetup> {
    const [version, identity, signing, agent, keyFiles] = await Promise.all([
      this.version(),
      this.identity(this.home),
      this.signing(),
      this.agent(),
      this.keyFiles(),
    ]);
    const projects = this.deps.projects();
    const [remotes, identities] = await Promise.all([
      this.remotes(projects),
      Promise.all(projects.map((p) => this.identity(p.path))),
    ]);
    const agentPrints = new Set(agent.keys.map((k) => k.fingerprint));
    const filePrints = new Map(
      keyFiles.flatMap((k) => (k.path ? [[k.path, k.fingerprint]] : []))
    );
    const hosts = await Promise.all(
      [...remotes.values()].map((h) =>
        this.host(h.remote, h.projects, agentPrints, filePrints)
      )
    );
    return {
      agent,
      hosts: hosts.toSorted((a, b) => a.host.localeCompare(b.host)),
      identity,
      keyFiles,
      projects: projects.flatMap((p, i) => {
        const own = identities[i] ?? {};
        return own.name === identity.name && own.email === identity.email
          ? []
          : [{ identity: own, project: p.name, projectId: p.id }];
      }),
      signing,
      ...(version ? { version } : {}),
    };
  }

  /** Connects to a project's git host with `ssh -T`, as git would, without prompting. */
  async test(host: string): Promise<SshTestResult> {
    const remotes = await this.remotes(this.deps.projects());
    const found = remotes.get(host);
    if (!found) {
      throw new NotFoundError(host, "git host");
    }
    const { remote } = found;
    const r = await this.deps.run(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-p",
        remote.port,
        ...(remote.user ? ["-l", remote.user] : []),
        "--",
        remote.hostname,
      ],
      { detached: true, timeoutMs: TEST_TIMEOUT_MS }
    );
    const message =
      `${r.stderr}\n${r.stdout}`
        .split("\n")
        .map((l) => l.trim())
        .findLast(Boolean) ?? "";
    if (r.timedOut) {
      return { message: "Timed out connecting", ok: false };
    }
    // ssh exits 255 for its own errors; forges answer a shell-less login with 0 or 1.
    return {
      message: message || `exit ${r.exitCode}`,
      ok: r.exitCode !== SSH_ERROR_EXIT,
    };
  }

  private async git(args: string[], cwd: string): Promise<string | undefined> {
    const r = await this.deps.run("git", args, { cwd, timeoutMs: TIMEOUT_MS });
    return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
  }

  private async version(): Promise<string | undefined> {
    const out = await this.git(["--version"], this.home);
    return out?.replace(/^git version\s+/u, "");
  }

  /** user.name and user.email as git sees them in `dir`, so a repo's own config and includeIf apply. */
  private async identity(dir: string): Promise<GitIdentityView> {
    const [name, email] = await Promise.all([
      this.git(["config", "--get", "user.name"], dir),
      this.git(["config", "--get", "user.email"], dir),
    ]);
    return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
  }

  private async signing(): Promise<GitSetup["signing"]> {
    const [sign, format, key] = await Promise.all([
      this.git(["config", "--get", "commit.gpgsign"], this.home),
      this.git(["config", "--get", "gpg.format"], this.home),
      this.git(["config", "--get", "user.signingkey"], this.home),
    ]);
    return {
      enabled: sign === "true",
      ...(format ? { format } : {}),
      ...(key ? { key } : {}),
    };
  }

  private async agent(): Promise<GitSetup["agent"]> {
    const r = await this.deps.run("ssh-add", ["-l"], { timeoutMs: TIMEOUT_MS });
    // 0: keys listed, 1: an agent without keys, 2: no agent to talk to.
    if (r.exitCode === 0) {
      return { keys: parseKeyLines(r.stdout), running: true };
    }
    if (r.exitCode === 1) {
      return { keys: [], running: true };
    }
    return {
      error: (r.stderr || r.stdout).trim() || "No ssh agent is running",
      keys: [],
      running: false,
    };
  }

  private async keyFiles(): Promise<SshKeyView[]> {
    const dir = path.join(this.home, ".ssh");
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const keys = await Promise.all(
      names
        .filter((n) => n.endsWith(".pub"))
        .toSorted()
        .map(async (n) => {
          const file = path.join(dir, n);
          const r = await this.deps.run("ssh-keygen", ["-l", "-f", file], {
            timeoutMs: TIMEOUT_MS,
          });
          const [key] = r.exitCode === 0 ? parseKeyLines(r.stdout) : [];
          return key
            ? { ...key, path: file.slice(0, -".pub".length) }
            : undefined;
        })
    );
    return keys.filter((k) => k !== undefined);
  }

  /** The ssh hosts of every project's remotes, keyed as known_hosts names them. */
  private async remotes(
    projects: Project[]
  ): Promise<Map<string, { remote: SshRemote; projects: string[] }>> {
    const lists = await Promise.all(
      projects.map((p) => this.git(["remote", "-v"], p.path))
    );
    const out = new Map<string, { remote: SshRemote; projects: string[] }>();
    for (const [i, list] of lists.entries()) {
      const project = projects[i];
      for (const line of (list ?? "").split("\n")) {
        const [, url] = line.trim().split(/\s+/u);
        const remote = url ? sshRemote(url) : undefined;
        if (!remote || !project) {
          continue;
        }
        const key = knownHostsName(remote);
        const entry = out.get(key) ?? { projects: [], remote };
        if (!entry.projects.includes(project.name)) {
          entry.projects.push(project.name);
        }
        out.set(key, entry);
      }
    }
    return out;
  }

  private async host(
    remote: SshRemote,
    projects: string[],
    agentPrints: Set<string>,
    filePrints: Map<string, string>
  ): Promise<SshHostView> {
    const host = knownHostsName(remote);
    const [config, known] = await Promise.all([
      this.deps.run(
        "ssh",
        [
          "-G",
          "-p",
          remote.port,
          ...(remote.user ? ["-l", remote.user] : []),
          "--",
          remote.hostname,
        ],
        { timeoutMs: TIMEOUT_MS }
      ),
      this.deps.run(
        "ssh-keygen",
        ["-F", host, "-f", path.join(this.home, ".ssh", "known_hosts")],
        { timeoutMs: TIMEOUT_MS }
      ),
    ]);
    const options = config.exitCode === 0 ? config.stdout : "";
    const files = await Promise.all(
      sshOption(options, "identityfile")
        .map((f) => (f.startsWith("~/") ? path.join(this.home, f.slice(2)) : f))
        .map(async (file) => {
          const exists = await fs
            .access(file)
            .then(() => true)
            .catch(() => false);
          const print = filePrints.get(file);
          return {
            exists,
            inAgent: print !== undefined && agentPrints.has(print),
            path: file,
          };
        })
    );
    return {
      host,
      identityFiles: files.filter((f) => f.exists),
      known: known.exitCode === 0 && known.stdout.trim() !== "",
      projects,
      user: remote.user ?? sshOption(options, "user")[0] ?? "",
    };
  }
}
