import { spawn } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import { parseArgs } from "node:util";

import type { EnvLogs } from "../shared/types";
import { Access, DASHBOARD_COOKIE, accessUrl } from "./access";
import { loadConfig } from "./config";
import type { CliEnv, CliTarget } from "./environments/environments";
import type { TerminalTarget } from "./environments/terminals";
import {
  DEFAULT_TERM,
  execCommand,
  inDirectory,
  shellCommand,
  withKnownTerm,
} from "./environments/terminals";

export const TERMINAL_COMMANDS = ["attach", "up", "exec", "ls"] as const;
export type TerminalCommand = (typeof TERMINAL_COMMANDS)[number];

export const isTerminalCommand = (
  s: string | undefined
): s is TerminalCommand =>
  (TERMINAL_COMMANDS as readonly string[]).includes(s ?? "");

const POLL_MS = 1000;
const LOG_LINES = 200;

export type TerminalArgs =
  | { command: "ls" }
  | { command: "up"; target?: string }
  | { command: "attach"; target?: string; shell?: string }
  | { command: "exec"; target?: string; run: string[] };

const USAGES: Record<TerminalCommand, string> = {
  attach: "usage: opendevhub attach [target] [--shell bash|zsh|sh|fish]",
  exec: "usage: opendevhub exec [target] -- <command…>",
  ls: "usage: opendevhub ls",
  up: "usage: opendevhub up [target]",
};

/** Parses a terminal subcommand's arguments; a usage error carries the subcommand's usage line. */
export const parseTerminalArgs = (
  command: TerminalCommand,
  argv: string[]
): TerminalArgs => {
  const dash = argv.indexOf("--");
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const run = dash === -1 ? [] : argv.slice(dash + 1);
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: own,
      options: command === "attach" ? { shell: { type: "string" } } : {},
      strict: true,
    });
  } catch {
    throw new Error(USAGES[command]);
  }
  const { positionals, values } = parsed;
  const maxTargets = command === "ls" ? 0 : 1;
  const runs = command === "exec" ? run.length > 0 : dash === -1;
  if (positionals.length > maxTargets || !runs) {
    throw new Error(USAGES[command]);
  }
  const [target] = positionals;
  const named = target === undefined ? {} : { target };
  if (command === "ls") {
    return { command };
  }
  if (command === "up") {
    return { command, ...named };
  }
  if (command === "exec") {
    return { command, run, ...named };
  }
  const shell = typeof values.shell === "string" ? values.shell : undefined;
  return { command, ...named, ...(shell === undefined ? {} : { shell }) };
};

class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The running opendevhub's API on this machine, with the dashboard cookie a browser would get. */
export class LocalApi {
  readonly port: number;
  private readonly cookie: string;
  private readonly fetch: typeof fetch;

  constructor(port: number, cookie: string, fetcher: typeof fetch = fetch) {
    this.port = port;
    this.cookie = cookie;
    this.fetch = fetcher;
  }

  get<T>(path: string, query: Record<string, string | undefined> = {}) {
    const params = new URLSearchParams(
      Object.entries(query).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    );
    const search = params.size > 0 ? `?${params}` : "";
    return this.request<T>("GET", `${path}${search}`);
  }

  post<T>(path: string) {
    return this.request<T>("POST", path);
  }

  private async request<T>(method: string, path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`http://localhost:${this.port}${path}`, {
        headers: { cookie: `${DASHBOARD_COOKIE}=${this.cookie}` },
        method,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(
        `opendevhub isn't running on port ${this.port}; start it with \`opendevhub\``
      );
    }
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      throw new ApiError(res.status, body);
    }
    return body as T;
  }
}

export interface TerminalIo {
  log: (s: string) => void;
  error: (s: string) => void;
  /** The folder the command runs in, as `realpath` gives it. */
  cwd: string;
  env: { SHELL?: string; TERM?: string };
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

export interface TerminalDeps {
  api: LocalApi;
  /** The dashboard link, printed when an approval is missing. */
  dashboardUrl: () => string;
  /** Runs a command on the user's terminal and resolves to its exit code. */
  run: (file: string, args: string[]) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The process's exit code for a child that exited or was killed by a signal. */
const exitCode = (code: number | null, signal: NodeJS.Signals | null) =>
  code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0);

/**
 * Runs on the user's terminal and waits. Ctrl-C reaches the child through the terminal, so this process only
 * outlives it to pass its exit code on; a signal sent to this process alone is passed to the child.
 */
const runInherited = (file: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => {
      if (signal !== "SIGINT") {
        child.kill(signal);
      }
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) {
      process.on(signal, forward);
    }
    const done = () => {
      for (const signal of signals) {
        process.off(signal, forward);
      }
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      done();
      resolve(exitCode(code, signal));
    });
  });

const label = (env: CliEnv): string =>
  env.branch ? `${env.branch} (${env.envId})` : env.envId;

class Session {
  private readonly args: TerminalArgs;
  private readonly io: TerminalIo;
  private readonly deps: TerminalDeps;

  constructor(args: TerminalArgs, io: TerminalIo, deps: TerminalDeps) {
    this.args = args;
    this.io = io;
    this.deps = deps;
  }

  target(): Promise<CliTarget> {
    const name = "target" in this.args ? this.args.target : undefined;
    return this.deps.api.get<CliTarget>("/api/cli/target", {
      dir: this.io.cwd,
      name,
    });
  }

  async ls(): Promise<number> {
    const { envs, projectName } = await this.deps.api.get<{
      projectName: string;
      envs: CliEnv[];
    }>("/api/cli/envs", { dir: this.io.cwd });
    const rows = [
      ["BRANCH", "ENV", "NODE", "STATE"],
      ...envs.map((e) => [
        `${e.branch ?? "-"}${e.main ? " (main)" : ""}`,
        e.envId,
        e.node,
        e.busy && e.state !== "starting" ? `${e.state} (busy)` : e.state,
      ]),
    ];
    const widths = rows[0].map((_, i) =>
      Math.max(...rows.map((r) => r[i].length))
    );
    this.io.log(projectName);
    for (const row of rows) {
      this.io.log(
        row
          .map((cell, i) =>
            i < row.length - 1 ? cell.padEnd(widths[i]) : cell
          )
          .join("  ")
      );
    }
    return 0;
  }

  /** Starts the target unless it runs; resolves to the running target, or undefined after saying why not. */
  async up(target: CliTarget): Promise<CliTarget | undefined> {
    if (target.state === "running" && !target.busy) {
      return target;
    }
    const logs = `/api/projects/${encodeURIComponent(target.projectId)}/envs/${encodeURIComponent(target.envId)}/logs`;
    const seen = new Set<string>();
    const fresh = async () => {
      const { lines } = await this.deps.api.get<EnvLogs>(logs, {
        lines: String(LOG_LINES),
        source: "setup",
      });
      return lines
        .map((l) => ({ key: `${l.at ?? ""}\t${l.text}`, text: l.text }))
        .filter((l) => {
          const isNew = !seen.has(l.key);
          seen.add(l.key);
          return isNew;
        });
    };
    await fresh();
    if (target.busy) {
      this.io.error(`${label(target)} is busy; waiting for it…`);
    } else {
      this.io.error(`Starting ${label(target)}…`);
      const start = target.main
        ? `/api/projects/${encodeURIComponent(target.projectId)}/start`
        : `/api/projects/${encodeURIComponent(target.projectId)}/envs/${encodeURIComponent(target.envId)}/start`;
      try {
        await this.deps.api.post(start);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) {
          throw error;
        }
        if (this.approvalMissing(error)) {
          return undefined;
        }
        // Busy: someone else is starting or stopping it; wait for that.
      }
    }
    let now = target;
    do {
      await (this.deps.sleep ?? sleep)(POLL_MS);
      for (const line of await fresh()) {
        this.io.error(line.text);
      }
      now = await this.target();
    } while (now.busy || now.state === "starting");
    if (now.state !== "running") {
      this.io.error(
        `${label(now)} didn't start${now.error ? `: ${now.error}` : ` (${now.state})`}`
      );
      return undefined;
    }
    return now;
  }

  private approvalMissing(error: ApiError): boolean {
    const approval = error.body.approval as
      | { changes?: { key: string; kind: string }[] }
      | undefined;
    if (!approval) {
      return false;
    }
    this.io.error(
      "Not started: its devcontainer config has host-affecting settings that aren't approved:"
    );
    for (const change of approval.changes ?? []) {
      this.io.error(`  ${change.kind}\t${change.key}`);
    }
    this.io.error(
      `Review and approve them in the dashboard: ${this.deps.dashboardUrl()}`
    );
    return true;
  }

  async runUp(): Promise<number> {
    const target = await this.target();
    const up = await this.up(target);
    if (!up) {
      return 1;
    }
    if (up.error) {
      this.io.error(`${label(up)} runs, but: ${up.error}`);
      return 1;
    }
    this.io.error(`${label(up)} is running`);
    return 0;
  }

  async attach(shell: string | undefined): Promise<number> {
    // Refuses a bad --shell before anything starts.
    const command = shellCommand(shell, this.io.env.SHELL);
    if (!this.io.stdinIsTty) {
      this.io.error(
        "attach needs a terminal; run a command with `opendevhub exec -- <command…>`"
      );
      return 2;
    }
    const up = await this.up(await this.target());
    if (!up) {
      return 1;
    }
    if (up.error) {
      this.io.error(`warning: ${up.error}`);
    }
    // The start may have changed what the container reports, so ask again.
    const target = up.exec ? up : await this.target();
    return this.spawn(target, command, true);
  }

  async exec(run: string[]): Promise<number> {
    const target = await this.target();
    if (target.state !== "running" || !target.exec) {
      const named =
        "target" in this.args && this.args.target ? ` ${this.args.target}` : "";
      this.io.error(
        `${label(target)} is ${target.state}; start it with \`opendevhub up${named}\``
      );
      return 1;
    }
    return this.spawn(target, run, this.io.stdinIsTty && this.io.stdoutIsTty);
  }

  private spawn(target: CliTarget, command: string[], tty: boolean) {
    if (!target.exec) {
      throw new Error(`${label(target)} is ${target.state}`);
    }
    const { directory, root, ...rest } = target.exec;
    const exec: TerminalTarget = rest;
    const wrapped =
      directory === root ? command : inDirectory(directory, command);
    const term = this.io.env.TERM || DEFAULT_TERM;
    const checkTerm = tty && term !== DEFAULT_TERM;
    const { file, args } = execCommand(
      exec,
      root,
      checkTerm ? withKnownTerm(wrapped) : wrapped,
      { term, tty }
    );
    return this.deps.run(file, args);
  }
}

/** `opendevhub attach|up|exec|ls`: a thin client of the opendevhub running on this machine. */
export const runTerminalCommand = async (
  command: TerminalCommand,
  argv: string[],
  io: TerminalIo,
  deps: TerminalDeps
): Promise<number> => {
  let args: TerminalArgs;
  try {
    args = parseTerminalArgs(command, argv);
  } catch (error) {
    io.error((error as Error).message);
    return 2;
  }
  const session = new Session(args, io, deps);
  try {
    switch (args.command) {
      case "ls": {
        return await session.ls();
      }
      case "up": {
        return await session.runUp();
      }
      case "attach": {
        return await session.attach(args.shell);
      }
      default: {
        return await session.exec(args.run);
      }
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

/** The real terminal, config and access token for `runTerminalCommand`. */
export const terminalSetup = (dirs: {
  config: string;
  state: string;
}): { io: TerminalIo; deps: TerminalDeps } => {
  const { port } = loadConfig(dirs.config);
  const access = new Access(dirs.state);
  return {
    deps: {
      api: new LocalApi(port, access.dashboardCookie()),
      dashboardUrl: () => accessUrl(port, access.token()),
      run: runInherited,
    },
    io: {
      cwd: fs.realpathSync.native(process.cwd()),
      env: { SHELL: process.env.SHELL, TERM: process.env.TERM },
      error: (s) => console.error(s),
      log: (s) => console.log(s),
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
    },
  };
};
