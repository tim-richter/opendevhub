import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { Duplex } from "node:stream";
import type { NodeId } from "../shared/types";
import { type Runner, spawnRunner } from "./exec";
import type { Host } from "./host";

/** Quotes a word for a POSIX shell; safe words stay readable. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The single string ssh hands to the remote shell for `cmd args`, with `env` set for it. */
export function remoteCommand(cmd: string, args: string[], env: Record<string, string> = {}): string {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return [...(vars.length > 0 ? ["env", ...vars] : []), cmd, ...args].map(shellQuote).join(" ");
}

export interface SshTarget {
  /** As the user's ssh config knows it: `host`, `user@host` or an alias. */
  dest: string;
  /** The ControlMaster socket. */
  control: string;
}

/** Every client call: go through the master, never prompt. */
export function clientArgs(t: SshTarget): string[] {
  return ["-S", t.control, "-o", "BatchMode=yes"];
}

/** The master, in the foreground: a daemonized ssh (-f) keeps captured stdio open, and its exit is our signal. */
export function masterArgs(t: SshTarget): string[] {
  return [
    "-M", "-N", "-S", t.control,
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    t.dest,
  ];
}

/** The port `ssh -G <dest>` resolved; 22 when it printed none. */
export function parseSshPort(sshG: string): number {
  const m = /^port (\d+)$/m.exec(sshG);
  return m ? Number(m[1]) : 22;
}

const AUTH_FAILURE = /Host key verification failed|Permission denied|REMOTE HOST IDENTIFICATION HAS CHANGED|No ED25519 host key is known|host key for .* has changed/i;

/** One line for the dashboard from what ssh printed before it gave up. */
export function describeSshFailure(dest: string, stderr: string): string {
  if (AUTH_FAILURE.test(stderr)) return `add the host key and an ssh key for ${dest} first (run \`ssh ${dest}\` once)`;
  const last = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
  return last ? `ssh to ${dest} failed: ${last}` : `ssh to ${dest} exited`;
}

export type Spawn = (cmd: string, args: string[]) => ChildProcess;

export const defaultSpawn: Spawn = (cmd, args) => nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

/** A node reached over ssh. Every call goes through the ControlMaster that a NodeConnection keeps open. */
export class SshHost implements Host {
  constructor(
    readonly id: NodeId,
    private readonly target: SshTarget,
    private readonly local: Runner = spawnRunner,
    private readonly spawn: Spawn = defaultSpawn,
  ) {}

  readonly run: Runner = (cmd, args, opts = {}) => {
    const { env, ...rest } = opts;
    return this.local("ssh", [...clientArgs(this.target), this.target.dest, remoteCommand(cmd, args, env)], rest);
  };

  async readFile(file: string): Promise<string> {
    const r = await this.run("cat", [file], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new Error(`reading ${file} on ${this.id} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    return r.stdout;
  }

  async writeFile(file: string, content: string): Promise<void> {
    const r = await this.run("sh", ["-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", file], {
      input: content,
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0) throw new Error(`writing ${file} on ${this.id} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  /** A channel to `ip:port` from the node (`ssh -W`), as a stream over the ssh process's stdio. */
  dial(ip: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const child = this.spawn("ssh", [...clientArgs(this.target), "-W", `${ip}:${port}`, this.target.dest]);
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString("utf8")).slice(-2000);
      });
      // Node accepts a { readable, writable } pair here; @types/node doesn't list that overload.
      const pair = { readable: child.stdout!, writable: child.stdin! };
      const stream = Duplex.from(pair as unknown as Parameters<typeof Duplex.from>[0]);
      stream.on("close", () => {
        if (child.exitCode === null) child.kill();
      });
      child.once("error", reject);
      child.once("spawn", () => resolve(stream));
      // "close" comes after stderr is drained, so the message is complete.
      child.once("close", (code) => {
        if (code !== 0 && !stream.destroyed) {
          stream.destroy(new Error(stderr.trim() || `ssh -W ${ip}:${port} exited with ${code}`));
        }
      });
    });
  }
}
