import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { NodeState, NodeView } from "../shared/types";
import type { NodeConfig } from "./config";
import { type Runner, spawnRunner } from "./exec";
import { nodePreflight } from "./node-preflight";
import { SshHost, type Spawn, type SshTarget, defaultSpawn, describeSshFailure, masterArgs, parseSshPort } from "./ssh";

export interface NodeConnectionOptions {
  node: NodeConfig;
  /** The master's socket is `<controlDir>/<id>.sock`. */
  controlDir: string;
  onChange: () => void;
  run?: Runner;
  spawn?: Spawn;
  preflight?: (host: SshHost, sshPort: number, dest: string) => Promise<string[]>;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

export function nextDelay(current: number, max: number): number {
  return Math.min(current * 2, max);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps one node reachable: an ssh ControlMaster as a child process, preflight once it's up, and
 * reconnection with backoff when it exits. Every SshHost call goes through that master.
 */
export class NodeConnection {
  readonly host: SshHost;
  private readonly target: SshTarget;
  private readonly run: Runner;
  private state: NodeState = "connecting";
  private reason?: string;
  private master?: ChildProcess;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private delay: number;
  private closed = false;

  constructor(private readonly opts: NodeConnectionOptions) {
    this.target = { dest: opts.node.ssh, control: path.join(opts.controlDir, `${opts.node.id}.sock`) };
    this.run = opts.run ?? spawnRunner;
    this.host = new SshHost(opts.node.id, this.target, this.run, opts.spawn ?? defaultSpawn);
    this.delay = opts.retryMinMs ?? 1000;
  }

  get online(): boolean {
    return this.state === "online";
  }

  view(): NodeView {
    const { node } = this.opts;
    return { id: node.id, label: node.label ?? node.ssh, ssh: node.ssh, state: this.state, ...(this.reason ? { reason: this.reason } : {}) };
  }

  start(): void {
    void this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const master = this.master;
    this.master = undefined;
    if (master && master.exitCode === null) {
      await this.run("ssh", ["-S", this.target.control, "-O", "exit", this.target.dest], { timeoutMs: 5000 }).catch(() => undefined);
      master.kill();
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.set("connecting");
    try {
      await this.openMaster();
      const port = parseSshPort((await this.run("ssh", ["-G", this.target.dest], { timeoutMs: 10_000 })).stdout);
      const errors = await (this.opts.preflight ?? nodePreflight)(this.host, port, this.target.dest);
      if (this.closed) return;
      if (errors.length > 0) {
        this.set("error", errors.join("; "));
        this.retry(this.opts.retryMaxMs ?? 60_000);
        return;
      }
      this.delay = this.opts.retryMinMs ?? 1000;
      this.set("online");
    } catch (err) {
      if (this.closed) return;
      this.set("unreachable", err instanceof Error ? err.message : String(err));
      this.retry();
    }
  }

  /** Starts a fresh master and resolves once `ssh -O check` answers; rejects with ssh's reason when it exits first. */
  private async openMaster(): Promise<void> {
    this.stopMaster();
    fs.mkdirSync(path.dirname(this.target.control), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(this.target.control), 0o700);
    // A socket left by a crash makes the new ssh silently skip being a master.
    fs.rmSync(this.target.control, { force: true });
    const child = (this.opts.spawn ?? defaultSpawn)("ssh", masterArgs(this.target));
    this.master = child;
    let stderr = "";
    let exited = false;
    child.stdout?.resume();
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    child.once("error", (err) => {
      stderr += `\n${err.message}`;
      exited = true;
    });
    child.once("exit", () => {
      exited = true;
      if (this.master !== child) return;
      this.master = undefined;
      // While connecting, openMaster's own loop reports the exit.
      if (this.closed || this.state === "connecting") return;
      this.set("unreachable", describeSshFailure(this.target.dest, stderr));
      this.retry();
    });

    const timeoutMs = this.opts.readyTimeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exited) throw new Error(describeSshFailure(this.target.dest, stderr));
      const check = await this.run("ssh", ["-S", this.target.control, "-O", "check", this.target.dest], { timeoutMs: 5000 });
      if (check.exitCode === 0 && !exited) return;
      if (Date.now() > deadline) {
        this.stopMaster();
        throw new Error(`ssh to ${this.target.dest} did not connect within ${Math.round(timeoutMs / 1000)} s`);
      }
      await sleep(this.opts.readyIntervalMs ?? 250);
    }
  }

  private stopMaster(): void {
    const master = this.master;
    this.master = undefined;
    if (master && master.exitCode === null) master.kill();
  }

  /** Reconnects after `ms`, or after the backoff delay, which then doubles. */
  private retry(ms?: number): void {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    const wait = ms ?? this.delay;
    if (ms === undefined) this.delay = nextDelay(this.delay, this.opts.retryMaxMs ?? 60_000);
    this.retryTimer = setTimeout(() => void this.connect(), wait);
    this.retryTimer.unref?.();
  }

  private set(state: NodeState, reason?: string): void {
    if (this.closed || (this.state === state && this.reason === reason)) return;
    this.state = state;
    this.reason = reason;
    this.opts.onChange();
  }
}
