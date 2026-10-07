import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";

import type { NodeId } from "../shared/types";
import { spawnRunner } from "./exec";
import type { Runner } from "./exec";
import type { Host } from "./host";

/** Quotes a word for a POSIX shell; safe words stay readable. */
export const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/** The single string ssh hands to the remote shell for `cmd args`, with `env` set for it. */
export const remoteCommand = (
  cmd: string,
  args: string[],
  env: Record<string, string> = {}
): string => {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return [...(vars.length > 0 ? ["env", ...vars] : []), cmd, ...args]
    .map(shellQuote)
    .join(" ");
};

export interface SshTarget {
  /** As the user's ssh config knows it: `host`, `user@host` or an alias. */
  dest: string;
  /** The ControlMaster socket. */
  control: string;
}

/** Every client call: go through the master, never prompt. */
export const clientArgs = (t: SshTarget): string[] => [
  "-S",
  t.control,
  "-o",
  "BatchMode=yes",
];

/** The master, in the foreground: a daemonized ssh (-f) keeps captured stdio open, and its exit is our signal. */
export const masterArgs = (t: SshTarget): string[] => [
  "-M",
  "-N",
  "-S",
  t.control,
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  t.dest,
];

/** The port `ssh -G <dest>` resolved; 22 when it printed none. */
export const parseSshPort = (sshG: string): number => {
  const m = /^port (?<g1>\d+)$/mu.exec(sshG);
  return m ? Number(m[1]) : 22;
};

const AUTH_FAILURE =
  /Host key verification failed|Permission denied|REMOTE HOST IDENTIFICATION HAS CHANGED|No ED25519 host key is known|host key for .* has changed/iu;

/** One line for the dashboard from what ssh printed before it gave up. */
export const describeSshFailure = (dest: string, stderr: string): string => {
  if (AUTH_FAILURE.test(stderr)) {
    return `add the host key and an ssh key for ${dest} first (run \`ssh ${dest}\` once)`;
  }
  const last = stderr
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .findLast(Boolean);
  return last ? `ssh to ${dest} failed: ${last}` : `ssh to ${dest} exited`;
};

export type Spawn = (cmd: string, args: string[]) => ChildProcess;

export const defaultSpawn: Spawn = (cmd, args) =>
  nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

/** A node reached over ssh. Every call goes through the ControlMaster that a NodeConnection keeps open. */
export class SshHost implements Host {
  /** Set by the NodeConnection once the node answered; empty until then. */
  home = "";

  constructor(
    readonly id: NodeId,
    private readonly target: SshTarget,
    private readonly local: Runner = spawnRunner,
    private readonly spawn: Spawn = defaultSpawn
  ) {}

  readonly run: Runner = (cmd, args, opts = {}) => {
    const { env, ...rest } = opts;
    return this.local(
      "ssh",
      [
        ...clientArgs(this.target),
        this.target.dest,
        remoteCommand(cmd, args, env),
      ],
      rest
    );
  };

  async readFile(file: string): Promise<string> {
    const r = await this.run("cat", [file], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) {
      throw new Error(
        `reading ${file} on ${this.id} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`
      );
    }
    return r.stdout;
  }

  async writeFile(file: string, content: string): Promise<void> {
    const r = await this.run(
      "sh",
      ["-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", file],
      {
        input: content,
        timeoutMs: 30_000,
      }
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `writing ${file} on ${this.id} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`
      );
    }
  }

  /** A channel to `ip:port` from the node (`ssh -W`), as a stream over the ssh process's stdio. */
  dial(ip: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const child = this.spawn("ssh", [
        ...clientArgs(this.target),
        "-W",
        `${ip}:${port}`,
        this.target.dest,
      ]);
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString("utf-8")).slice(-2000);
      });
      const stream = childStream(child);
      child.once("error", reject);
      child.once("spawn", () => resolve(stream));
      // "close" comes after stderr is drained, so the message is complete.
      child.once("close", (code) => {
        if (code !== 0 && !stream.destroyed) {
          stream.destroy(
            new Error(
              stderr.trim() || `ssh -W ${ip}:${port} exited with ${code}`
            )
          );
        }
      });
    });
  }
}

/**
 * A socket-like stream over a child's stdout and stdin. Unlike `Duplex.from`, a plain `destroy()`
 * closes it without an AbortError, as on a `net.Socket`, and stops the child.
 */
const childStream = (child: ChildProcess): Duplex => {
  const { stdin, stdout } = child;
  if (!stdin || !stdout) {
    throw new Error("child process has no stdio pipes");
  }
  // ssh's exit is reported through "close"; a write after it would raise EPIPE here.
  stdin.on("error", () => undefined);
  stdout.on("error", () => undefined);
  const stream = new Duplex({
    allowHalfOpen: true,
    destroy(err, callback) {
      stdout.destroy();
      stdin.destroy();
      if (child.exitCode === null) {
        child.kill();
      }
      callback(err);
    },
    final(callback) {
      stdin.end(() => callback());
    },
    read() {
      stdout.resume();
    },
    write(chunk, encoding, callback) {
      stdin.write(chunk, encoding, () => callback());
    },
  });
  stdout.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) {
      stdout.pause();
    }
  });
  stdout.on("end", () => stream.push(null));
  return stream;
};
