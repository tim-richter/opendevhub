import { spawn } from "node:child_process";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  /** Working directory; defaults to the server's. */
  cwd?: string;
  /** Run in a new session without a controlling terminal, so ssh can't open /dev/tty to prompt. */
  detached?: boolean;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const spawnRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const carry = { out: "", err: "" };
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      detached: opts.detached === true,
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (opts.detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };

    const feed = (key: "out" | "err", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (key === "out") stdout += text;
      else stderr += text;
      if (!opts.onLine) return;
      const parts = (carry[key] + text).split(/\r?\n/);
      carry[key] = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) opts.onLine(line);
    };
    child.stdout.on("data", (c: Buffer) => feed("out", c));
    child.stderr.on("data", (c: Buffer) => feed("err", c));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 5000).unref();
        }, opts.timeoutMs)
      : undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.onLine) for (const rest of [carry.out, carry.err]) if (rest.trim()) opts.onLine(rest);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    child.on("error", (err) => {
      stderr += err.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
