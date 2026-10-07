import fs from "node:fs";
import net from "node:net";

import type { SshAgentState } from "../../shared/types";
import { acceptAgentConnection, openAgentControl } from "./client";
import type { RelayTarget } from "./client";

/** Where the relay serves the forwarded agent inside the container. */
export const AGENT_SOCKET = "/tmp/opendevhub-ssh-agent.sock";
/**
 * git's ssh command in containers with forwarding on: ssh with the forwarded agent while it answers, and with the
 * shell's own SSH_AUTH_SOCK otherwise (opendevhub not running, a stale socket after a restart, VS Code's agent).
 * ssh-add exits 2 when it can't reach an agent. opendevhub only removes the setting when it still has this value.
 */
export const AGENT_SSH_COMMAND =
  `sh -c 'if [ -S ${AGENT_SOCKET} ]; then SSH_AUTH_SOCK=${AGENT_SOCKET} ssh-add -l >/dev/null 2>&1; ` +
  `[ $? -eq 2 ] || export SSH_AUTH_SOCK=${AGENT_SOCKET}; fi; exec ssh "$@"' ssh`;

export interface AgentStatus {
  state: Exclude<SshAgentState, "off">;
  reason?: string;
}

export interface AgentTunnelOptions {
  onLog: (line: string) => void;
  onStatus: (status: AgentStatus) => void;
  /** The control connection couldn't be opened: the relay may be gone. */
  onRelayLost?: () => void;
  /** The host agent's socket, read on every use; defaults to SSH_AUTH_SOCK. */
  hostSocket?: () => string | undefined;
  retryMinMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

const WARN_INTERVAL_MS = 60_000;

/** Why the host's agent can't be forwarded; undefined when SSH_AUTH_SOCK is a socket. */
export const hostAgentProblem = (
  socketPath: string | undefined
): string | undefined => {
  if (!socketPath) {
    return "SSH_AUTH_SOCK is not set on this machine";
  }
  try {
    return fs.statSync(socketPath).isSocket()
      ? undefined
      : `SSH_AUTH_SOCK (${socketPath}) is not a socket`;
  } catch {
    return `SSH_AUTH_SOCK (${socketPath}) does not exist`;
  }
};

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const connectUnix = (socketPath: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once("error", reject);
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
  });

/**
 * Keeps one environment's agent control connection open and pipes each container client the relay
 * announces to the host's ssh-agent. Reconnects with backoff until stopped.
 */
export class AgentTunnel {
  private stopped = false;
  private control?: net.Socket;
  private timer?: NodeJS.Timeout;
  private delay: number;
  private readonly pipes = new Set<net.Socket>();
  private lastWarn = -Infinity;
  private status?: string;

  constructor(
    private readonly target: RelayTarget,
    private readonly opts: AgentTunnelOptions
  ) {
    this.delay = opts.retryMinMs ?? 1000;
  }

  start(): void {
    const problem = hostAgentProblem(this.hostSocket());
    if (problem) {
      this.setStatus({ reason: problem, state: "unavailable" });
      return;
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.control?.destroy();
    this.control = undefined;
    for (const s of this.pipes) {
      s.destroy();
    }
    this.pipes.clear();
  }

  private hostSocket(): string | undefined {
    return (
      (this.opts.hostSocket ?? (() => process.env.SSH_AUTH_SOCK))() || undefined
    );
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private setStatus(status: AgentStatus): void {
    if (this.stopped) {
      return;
    }
    const key = `${status.state}:${status.reason ?? ""}`;
    if (key === this.status) {
      return;
    }
    this.status = key;
    this.opts.onStatus(status);
    this.opts.onLog(
      status.state === "forwarded"
        ? "ssh-agent: forwarded"
        : `ssh-agent: unavailable (${status.reason})`
    );
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    let socket: net.Socket;
    let rest: Buffer;
    try {
      ({ socket, rest } = await openAgentControl(this.target));
    } catch (error) {
      this.setStatus({
        reason: `relay: ${message(error)}`,
        state: "unavailable",
      });
      this.opts.onRelayLost?.();
      this.retry();
      return;
    }
    if (this.stopped) {
      socket.destroy();
      return;
    }
    this.control = socket;
    this.delay = this.opts.retryMinMs ?? 1000;
    this.setStatus({ state: "forwarded" });
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const m = /^CONN (?<g1>\d+)$/u.exec(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
        if (m) {
          void this.accept(Number(m[1]));
        }
      }
      if (buf.length > 256) {
        socket.destroy();
      }
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.on("end", () => socket.destroy());
    socket.on("close", () => {
      if (this.control === socket) {
        this.control = undefined;
      }
      if (this.stopped) {
        return;
      }
      this.setStatus({
        reason: "lost the relay connection; reconnecting",
        state: "unavailable",
      });
      this.retry();
    });
    if (rest.length) {
      onData(rest);
    }
    socket.resume();
  }

  private retry(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.opts.retryMaxMs ?? 30_000);
  }

  /** Pipes the announced client to the host agent; when the agent can't be reached the relay's 5 s timeout closes the client. */
  private async accept(id: number): Promise<void> {
    let local: net.Socket;
    try {
      const socketPath = this.hostSocket();
      if (!socketPath) {
        throw new Error("SSH_AUTH_SOCK is not set");
      }
      local = await connectUnix(socketPath);
    } catch (error) {
      this.warn(
        `ssh-agent: can't reach the agent on this machine (${message(error)})`
      );
      return;
    }
    let remote: net.Socket;
    try {
      remote = await acceptAgentConnection(this.target, id);
    } catch {
      local.destroy();
      return;
    }
    if (this.stopped) {
      local.destroy();
      remote.destroy();
      return;
    }
    this.pipes.add(local);
    this.pipes.add(remote);
    const close = () => {
      local.destroy();
      remote.destroy();
      this.pipes.delete(local);
      this.pipes.delete(remote);
    };
    for (const s of [local, remote]) {
      s.on("error", close);
      s.on("close", close);
    }
    local.pipe(remote);
    remote.pipe(local);
    remote.resume();
  }

  private warn(line: string): void {
    const now = this.now();
    if (now - this.lastWarn < WARN_INTERVAL_MS) {
      return;
    }
    this.lastWarn = now;
    this.opts.onLog(line);
  }
}
