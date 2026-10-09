import { randomBytes } from "node:crypto";

import type { Containers, ExecTarget } from "../../environments/containers";
import type { HostPort } from "../routes";
import { pingRelay } from "./client";
import type { RelayTarget } from "./client";
import { RELAY_SCRIPT } from "./script";

export const RELAY_PORT = 4097;
const RELAY_LOG = "/tmp/opendevhub-relay.log";
const KILL_RELAY = "pkill -f 'odh-[r]elay' || true";

export interface RelayArgs {
  /** Where the host reaches the relay (the container IP, or a gateway tunnel). */
  address: HostPort;
  token: string;
  binary?: string;
}

export type RelayStatus =
  | { status: "active"; via: "existing" | "bun" | "node" }
  | { status: "unavailable"; reason: string };

export const generateRelayToken = (): string =>
  randomBytes(32).toString("base64url");

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export interface RelayRuntimeDeps {
  containers: Pick<Containers, "exec">;
  ping?: (target: RelayTarget) => Promise<boolean>;
  relayPort?: number;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

export class RelayRuntime {
  private readonly deps: RelayRuntimeDeps;
  constructor(deps: RelayRuntimeDeps) {
    this.deps = deps;
  }

  async ensureRunning(
    execTarget: ExecTarget,
    args: RelayArgs
  ): Promise<RelayStatus> {
    try {
      return await this.start(execTarget, args);
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : String(error),
        status: "unavailable",
      };
    }
  }

  async stop(execTarget: ExecTarget): Promise<void> {
    await this.deps.containers.exec(execTarget, ["sh", "-c", KILL_RELAY]);
  }

  private async start(
    execTarget: ExecTarget,
    args: RelayArgs
  ): Promise<RelayStatus> {
    const { containers } = this.deps;
    const port = this.deps.relayPort ?? RELAY_PORT;
    // `port` is where the relay listens in the container; `address` is where the host reaches it.
    const target: RelayTarget = { ...args.address, token: args.token };
    if (await this.ping(target)) {
      return { status: "active", via: "existing" };
    }

    await containers.exec(execTarget, ["sh", "-c", KILL_RELAY]);
    const candidates: { via: "bun" | "node"; command: string }[] = [];
    if (args.binary) {
      candidates.push({
        command: `BUN_BE_BUN=1 ${shellQuote(args.binary)}`,
        via: "bun",
      });
    }
    const hasNode = await containers.exec(execTarget, [
      "sh",
      "-c",
      "command -v node >/dev/null 2>&1",
    ]);
    if (hasNode.exitCode === 0) {
      candidates.push({ command: "node", via: "node" });
    }
    if (candidates.length === 0) {
      return {
        reason:
          "no relay runtime: opencode Bun mode unavailable and node not found",
        status: "unavailable",
      };
    }

    let reason = "";
    for (const candidate of candidates) {
      const launch =
        `nohup env ${candidate.command} -e ${shellQuote(RELAY_SCRIPT)} odh-relay ` +
        `< /dev/null > ${RELAY_LOG} 2>&1 &`;
      await containers.exec(execTarget, ["sh", "-c", launch], {
        env: { ODH_RELAY_PORT: String(port), ODH_RELAY_TOKEN: args.token },
      });
      if (await this.waitReady(target)) {
        return { status: "active", via: candidate.via };
      }
      const log = await containers.exec(execTarget, [
        "sh",
        "-c",
        `tail -n 1 ${RELAY_LOG} 2>/dev/null`,
      ]);
      reason = `${candidate.via}: ${log.stdout.trim() || "did not answer"}`;
      await containers.exec(execTarget, ["sh", "-c", KILL_RELAY]);
    }
    return { reason, status: "unavailable" };
  }

  private ping(target: RelayTarget): Promise<boolean> {
    return (this.deps.ping ?? pingRelay)(target);
  }

  private async waitReady(target: RelayTarget): Promise<boolean> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 5000);
    while (Date.now() < deadline) {
      if (await this.ping(target)) {
        return true;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, this.deps.readyIntervalMs ?? 200);
      });
    }
    return false;
  }
}
