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
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const spawnRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const carry = { out: "", err: "" };
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });

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
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
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
