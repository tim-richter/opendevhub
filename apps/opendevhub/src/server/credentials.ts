import os from "node:os";
import path from "node:path";
import { type Containers, type ExecTarget, tailLines } from "./containers";
import type { Runner } from "./exec";
import { AGENT_SOCKET, AGENT_SSH_COMMAND } from "./relay/agent";

const HOST_TIMEOUT_MS = 10_000;
const CONTAINER_TIMEOUT_MS = 30_000;

export interface GitIdentity {
  name?: string;
  email?: string;
}

/** Sets user.name / user.email globally for the remote user, each only when the container has none. Prints `set` when it wrote one. */
export const IDENTITY_SCRIPT = `command -v git >/dev/null 2>&1 || { echo no-git; exit 0; }
if [ -n "$ODH_GIT_NAME" ] && [ -z "$(git config --global --get user.name)" ]; then git config --global user.name "$ODH_GIT_NAME" && echo set; fi
if [ -n "$ODH_GIT_EMAIL" ] && [ -z "$(git config --global --get user.email)" ]; then git config --global user.email "$ODH_GIT_EMAIL" && echo set; fi
exit 0`;

/** Appends $ODH_LINES to ~/.ssh/known_hosts unless $ODH_HOST is already known there. Prints `added` when it wrote. */
export const KNOWN_HOSTS_SCRIPT = `mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || exit 1
f="$HOME/.ssh/known_hosts"
if command -v ssh-keygen >/dev/null 2>&1; then
  [ -f "$f" ] && ssh-keygen -F "$ODH_HOST" -f "$f" >/dev/null 2>&1 && exit 0
  printf "%s\\n" "$ODH_LINES" >> "$f" && echo added
  exit 0
fi
printf "%s\\n" "$ODH_LINES" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  grep -qxF -- "$line" "$f" 2>/dev/null || { printf "%s\\n" "$line" >> "$f" && echo added; }
done
exit 0`;

/** Points git's ssh at the forwarded agent unless the container has its own core.sshCommand (then prints `kept`). A value naming $ODH_AGENT_SOCK is opendevhub's, from this or an earlier version. */
export const SSH_COMMAND_ON = `command -v git >/dev/null 2>&1 || exit 0
current="$(git config --global --get core.sshCommand)"
case "$current" in
  "$ODH_SSH_COMMAND") ;;
  ""|*"$ODH_AGENT_SOCK"*) git config --global core.sshCommand "$ODH_SSH_COMMAND" ;;
  *) echo kept ;;
esac
exit 0`;

/** Removes core.sshCommand, but only when it is opendevhub's (it names $ODH_AGENT_SOCK). */
export const SSH_COMMAND_OFF = `command -v git >/dev/null 2>&1 || exit 0
case "$(git config --global --get core.sshCommand)" in
  *"$ODH_AGENT_SOCK"*) git config --global --unset core.sshCommand ;;
esac
exit 0`;

function sshHostOf(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if ((u.protocol !== "ssh:" && u.protocol !== "git+ssh:") || !u.hostname) return undefined;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return u.port && u.port !== "22" ? `[${host}]:${u.port}` : host;
  }
  return url.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/)?.[1];
}

/** The ssh hosts of `git remote -v` output, named as known_hosts names them: `host`, or `[host]:port` off port 22. */
export function sshHosts(remotes: string): string[] {
  const out: string[] = [];
  for (const line of remotes.split("\n")) {
    const url = line.trim().split(/\s+/)[1];
    const host = url ? sshHostOf(url) : undefined;
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/** How to verify a known_hosts name by hand. */
function sshHint(host: string): { label: string; command: string } {
  const m = host.match(/^\[(.+)\]:(\d+)$/);
  return m ? { label: `${m[1]} (port ${m[2]})`, command: `ssh -p ${m[2]} ${m[1]}` } : { label: host, command: `ssh ${host}` };
}

function failure(what: string, r: { stdout: string; stderr: string; exitCode: number }): Error {
  return new Error(`${what} (${tailLines(`${r.stderr}\n${r.stdout}`, 1).at(-1) ?? `exit ${r.exitCode}`})`);
}

export interface CredentialsDeps {
  run: Runner;
  containers: Pick<Containers, "exec">;
  /** This machine's known_hosts; defaults to ~/.ssh/known_hosts. */
  knownHostsFile?: string;
}

/** Git identity, known_hosts and git's ssh command in a container, from this machine's git and ssh setup. */
export class Credentials {
  constructor(private readonly deps: CredentialsDeps) {}

  /** Never throws: each step logs what it did, or why it couldn't. */
  async prepare(target: ExecTarget, projectPath: string, opts: { sshAgent: boolean; onLine: (line: string) => void }): Promise<void> {
    const steps = [
      () => this.identity(target, projectPath, opts.onLine),
      () => this.knownHosts(target, projectPath, opts.onLine),
      () => this.sshCommand(target, opts.sshAgent, opts.onLine),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        opts.onLine(`credentials: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** user.name and user.email as git sees them in the project folder, so includeIf identities apply. */
  async hostIdentity(projectPath: string): Promise<GitIdentity> {
    const read = async (key: string) => {
      const r = await this.deps.run("git", ["-C", projectPath, "config", "--get", key], { timeoutMs: HOST_TIMEOUT_MS });
      return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
    };
    const name = await read("user.name");
    const email = await read("user.email");
    return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
  }

  /** This machine's known_hosts entries for one host (hashed entries too). */
  async hostKnownHosts(host: string): Promise<string[]> {
    const file = this.deps.knownHostsFile ?? path.join(os.homedir(), ".ssh", "known_hosts");
    const r = await this.deps.run("ssh-keygen", ["-F", host, "-f", file], { timeoutMs: HOST_TIMEOUT_MS });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  private async identity(target: ExecTarget, projectPath: string, onLine: (line: string) => void): Promise<void> {
    const id = await this.hostIdentity(projectPath);
    if (!id.name && !id.email) {
      onLine("git: no user.name/user.email on this machine; commits in the container will fail");
      return;
    }
    const r = await this.deps.containers.exec(target, ["sh", "-c", IDENTITY_SCRIPT], {
      env: { ODH_GIT_NAME: id.name ?? "", ODH_GIT_EMAIL: id.email ?? "" },
      timeoutMs: CONTAINER_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) throw failure("could not set the git identity", r);
    if (r.stdout.includes("no-git")) onLine("git: not found in the container");
    else if (/^set$/m.test(r.stdout)) onLine(`git: identity set (${[id.name, id.email && `<${id.email}>`].filter(Boolean).join(" ")})`);
    else onLine("git: identity already set in the container");
  }

  private async knownHosts(target: ExecTarget, projectPath: string, onLine: (line: string) => void): Promise<void> {
    const remotes = await this.deps.run("git", ["-C", projectPath, "remote", "-v"], { timeoutMs: HOST_TIMEOUT_MS });
    if (remotes.exitCode !== 0) return;
    const added: string[] = [];
    for (const host of sshHosts(remotes.stdout)) {
      const lines = await this.hostKnownHosts(host);
      if (lines.length === 0) {
        const hint = sshHint(host);
        onLine(`ssh: ${hint.label} is not in known_hosts on this machine; run "${hint.command}" once to verify it`);
        continue;
      }
      const r = await this.deps.containers.exec(target, ["sh", "-c", KNOWN_HOSTS_SCRIPT], {
        env: { ODH_HOST: host, ODH_LINES: lines.join("\n") },
        timeoutMs: CONTAINER_TIMEOUT_MS,
      });
      if (r.exitCode !== 0) throw failure("could not update known_hosts in the container", r);
      if (r.stdout.includes("added")) added.push(host);
    }
    if (added.length > 0) onLine(`ssh: added known_hosts for ${added.join(", ")}`);
  }

  private async sshCommand(target: ExecTarget, sshAgent: boolean, onLine: (line: string) => void): Promise<void> {
    const r = await this.deps.containers.exec(target, ["sh", "-c", sshAgent ? SSH_COMMAND_ON : SSH_COMMAND_OFF], {
      env: { ODH_SSH_COMMAND: AGENT_SSH_COMMAND, ODH_AGENT_SOCK: AGENT_SOCKET },
      timeoutMs: CONTAINER_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) throw failure("could not set git's ssh command", r);
    if (r.stdout.includes("kept")) onLine("git: the container sets its own core.sshCommand; leaving it as is");
  }
}
