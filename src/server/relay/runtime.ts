import { randomBytes } from "node:crypto";
import type { Project } from "../../shared/types";
import type { Containers } from "../containers";
import type { HostPort } from "../network";
import { type RelayTarget, pingRelay } from "./client";
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

export function generateRelayToken(): string {
  return randomBytes(32).toString("base64url");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RelayRuntimeDeps {
  containers: Pick<Containers, "exec">;
  ping?: (target: RelayTarget) => Promise<boolean>;
  relayPort?: number;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

export class RelayRuntime {
  constructor(private readonly deps: RelayRuntimeDeps) {}

  async ensureRunning(project: Project, args: RelayArgs): Promise<RelayStatus> {
    try {
      return await this.start(project, args);
    } catch (err) {
      return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(project: Project): Promise<void> {
    await this.deps.containers.exec(project, ["sh", "-c", KILL_RELAY]);
  }

  private async start(project: Project, args: RelayArgs): Promise<RelayStatus> {
    const { containers } = this.deps;
    const port = this.deps.relayPort ?? RELAY_PORT;
    // `port` is where the relay listens in the container; `address` is where the host reaches it.
    const target: RelayTarget = { ...args.address, token: args.token };
    if (await this.ping(target)) return { status: "active", via: "existing" };

    await containers.exec(project, ["sh", "-c", KILL_RELAY]);
    const candidates: Array<{ via: "bun" | "node"; command: string }> = [];
    if (args.binary) candidates.push({ via: "bun", command: `BUN_BE_BUN=1 ${shellQuote(args.binary)}` });
    const hasNode = await containers.exec(project, ["sh", "-c", "command -v node >/dev/null 2>&1"]);
    if (hasNode.exitCode === 0) candidates.push({ via: "node", command: "node" });
    if (candidates.length === 0) {
      return { status: "unavailable", reason: "no relay runtime: opencode Bun mode unavailable and node not found" };
    }

    let reason = "";
    for (const candidate of candidates) {
      const launch =
        `nohup env ${candidate.command} -e ${shellQuote(RELAY_SCRIPT)} odh-relay ` +
        `< /dev/null > ${RELAY_LOG} 2>&1 &`;
      await containers.exec(project, ["sh", "-c", launch], {
        env: { ODH_RELAY_TOKEN: args.token, ODH_RELAY_PORT: String(port) },
      });
      if (await this.waitReady(target)) return { status: "active", via: candidate.via };
      const log = await containers.exec(project, ["sh", "-c", `tail -n 1 ${RELAY_LOG} 2>/dev/null`]);
      reason = `${candidate.via}: ${log.stdout.trim() || "did not answer"}`;
      await containers.exec(project, ["sh", "-c", KILL_RELAY]);
    }
    return { status: "unavailable", reason };
  }

  private ping(target: RelayTarget): Promise<boolean> {
    return (this.deps.ping ?? pingRelay)(target);
  }

  private async waitReady(target: RelayTarget): Promise<boolean> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 5000);
    while (Date.now() < deadline) {
      if (await this.ping(target)) return true;
      await new Promise((r) => setTimeout(r, this.deps.readyIntervalMs ?? 200));
    }
    return false;
  }
}
