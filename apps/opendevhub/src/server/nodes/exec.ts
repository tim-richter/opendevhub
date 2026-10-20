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
  onStderrLine?: (line: string) => void;
  /** Working directory; defaults to the server's. */
  cwd?: string;
  /** Run in a new session without a controlling terminal, so ssh can't open /dev/tty to prompt. */
  detached?: boolean;
  /** Written to the command's stdin, which is then closed. Without it stdin is ignored. */
  input?: string | Buffer;
  /** Ends the command (its whole group when detached) like a timeout does, without marking it timed out. */
  signal?: AbortSignal;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: RunOptions
) => Promise<RunResult>;

export const spawnRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const carry = { err: "", out: "" };
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      detached: opts.detached === true,
    });
    if (opts.input !== undefined) {
      // A child that exits without reading would otherwise raise EPIPE here.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.input);
    }
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (opts.detached && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        child.kill(signal);
      }
    };

    const feed = (key: "out" | "err", chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (key === "out") {
        stdout += text;
      } else {
        stderr += text;
      }
      const callback =
        key === "err" ? (opts.onStderrLine ?? opts.onLine) : opts.onLine;
      if (!callback) {
        return;
      }
      const parts = (carry[key] + text).split(/\r?\n/u);
      carry[key] = parts.pop() ?? "";
      for (const line of parts) {
        if (line.trim()) {
          callback(line);
        }
      }
    };
    child.stdout?.on("data", (c: Buffer) => feed("out", c));
    child.stderr?.on("data", (c: Buffer) => feed("err", c));

    const stop = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs)
      : undefined;
    if (opts.signal?.aborted) {
      stop();
    } else {
      opts.signal?.addEventListener("abort", stop, { once: true });
    }

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      if (carry.out.trim()) {
        opts.onLine?.(carry.out);
      }
      if (carry.err.trim()) {
        (opts.onStderrLine ?? opts.onLine)?.(carry.err);
      }
      resolve({ exitCode, stderr, stdout, timedOut });
    };
    child.on("error", (err) => {
      stderr += err.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
