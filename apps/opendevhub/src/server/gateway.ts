import { createHash } from "node:crypto";
import type net from "node:net";

import { CommandError, tailLines } from "./containers";
import type { Runner } from "./exec";
import type { GatewayPort, RouteContainer } from "./network";
import { RelayError, openGatewayConnection, pingRelay } from "./relay/client";
import type { RelayTarget } from "./relay/client";
import { generateRelayToken } from "./relay/runtime";
import { RELAY_SCRIPT } from "./relay/script";

export const GATEWAY_NAME = "opendevhub-gateway";
export const GATEWAY_LABEL = "opendevhub.gateway";
export const DEFAULT_GATEWAY_IMAGE = "node:22-alpine";
const GATEWAY_PORT = 4097;
const RUN_TIMEOUT_MS = 10 * 60_000;
const DOCKER_TIMEOUT_MS = 15_000;
const RECOVERY_INTERVAL_MS = 10_000;

export interface GatewayInfo {
  running: boolean;
  version?: string;
  token?: string;
  hostPort?: number;
}

export const parseGatewayInspect = (json: string): GatewayInfo => {
  const c = JSON.parse(json) as {
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> | null; Env?: string[] | null };
    NetworkSettings?: {
      Ports?: Record<
        string,
        { HostIp?: string; HostPort?: string }[] | null
      > | null;
    };
  };
  const token = c.Config?.Env?.find((e) =>
    e.startsWith("ODH_RELAY_TOKEN=")
  )?.slice("ODH_RELAY_TOKEN=".length);
  const binding = c.NetworkSettings?.Ports?.[`${GATEWAY_PORT}/tcp`]?.find(
    (b) => b.HostPort
  );
  const hostPort = binding?.HostPort ? Number(binding.HostPort) : undefined;
  return {
    hostPort: hostPort && Number.isInteger(hostPort) ? hostPort : undefined,
    running: c.State?.Running === true,
    token: token || undefined,
    version: c.Config?.Labels?.[GATEWAY_LABEL],
  };
};

export interface GatewayDeps {
  run: Runner;
  image?: string;
  ping?: (target: RelayTarget) => Promise<boolean>;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

/**
 * A long-lived container that publishes one port on the host's loopback and relays to container
 * IPs on the Docker networks it joins. Used when those IPs are not routable from the host.
 * It runs the relay script in remote mode and is left running when opendevhub exits.
 */
export class Gateway implements GatewayPort {
  private current?: Promise<RelayTarget>;
  private readonly networks = new Set<string>();
  private lastRecovery = -Infinity;

  private readonly deps: GatewayDeps;
  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  private get image(): string {
    return this.deps.image ?? DEFAULT_GATEWAY_IMAGE;
  }

  /** Changes whenever the image or the script does, so an outdated gateway is replaced. */
  get version(): string {
    return createHash("sha256")
      .update(this.image)
      .update("\0")
      .update(RELAY_SCRIPT)
      .digest("hex")
      .slice(0, 16);
  }

  async attach(
    container: RouteContainer,
    onLog: (line: string) => void
  ): Promise<void> {
    await this.ensure(onLog);
    if (!container.network || this.networks.has(container.network)) {
      return;
    }
    await this.joinNetwork(container.network);
    this.networks.add(container.network);
  }

  async connect(ip: string, port: number): Promise<net.Socket> {
    const target = await this.ensure();
    try {
      return await openGatewayConnection(target, ip, port);
    } catch (error) {
      // The gateway answered, so it is fine: the container side refused or is gone.
      if (error instanceof RelayError) {
        throw error;
      }
      // The gateway itself is unreachable (removed, Docker restarted): recreate it, at most every 10 s.
      const now = Date.now();
      if (now - this.lastRecovery < RECOVERY_INTERVAL_MS) {
        throw error;
      }
      this.lastRecovery = now;
      this.current = undefined;
      return openGatewayConnection(await this.ensure(), ip, port);
    }
  }

  private ensure(
    onLog: (line: string) => void = () => undefined
  ): Promise<RelayTarget> {
    this.current ??= this.start(onLog).catch((error: unknown) => {
      this.current = undefined;
      throw error;
    });
    return this.current;
  }

  private async start(onLog: (line: string) => void): Promise<RelayTarget> {
    const existing = await this.inspect();
    if (
      existing?.running &&
      existing.version === this.version &&
      existing.token &&
      existing.hostPort
    ) {
      const target: RelayTarget = {
        host: "127.0.0.1",
        port: existing.hostPort,
        token: existing.token,
      };
      if (await this.ping(target)) {
        await this.rejoinNetworks();
        return target;
      }
    }
    if (existing) {
      await this.docker(["rm", "-f", GATEWAY_NAME], DOCKER_TIMEOUT_MS);
    }

    onLog(`network: starting the gateway container (${this.image})`);
    const token = generateRelayToken();
    // `-e NAME` without a value takes it from the docker CLI's environment, keeping the token off the command line.
    await this.docker(
      [
        "run",
        "-d",
        "--name",
        GATEWAY_NAME,
        "--label",
        `${GATEWAY_LABEL}=${this.version}`,
        "-p",
        `127.0.0.1::${GATEWAY_PORT}`,
        "-e",
        "ODH_RELAY_TOKEN",
        "-e",
        `ODH_RELAY_PORT=${GATEWAY_PORT}`,
        "-e",
        "ODH_RELAY_REMOTE=1",
        this.image,
        "node",
        "-e",
        RELAY_SCRIPT,
        "odh-relay",
      ],
      RUN_TIMEOUT_MS,
      { ODH_RELAY_TOKEN: token },
      // stdout is only the new container's id; stderr carries the image pull progress.
      (line) => {
        if (!/^[0-9a-f]{64}$/u.test(line.trim())) {
          onLog(`network: ${line}`);
        }
      }
    );
    const info = await this.inspect();
    if (!info?.running) {
      throw new CommandError(
        "the gateway container is not running after docker run"
      );
    }
    if (!info.hostPort) {
      throw new CommandError("the gateway container has no published port");
    }
    const target: RelayTarget = {
      host: "127.0.0.1",
      port: info.hostPort,
      token,
    };
    if (!(await this.waitReady(target))) {
      const logs = await this.deps.run(
        "docker",
        ["logs", "--tail", "20", GATEWAY_NAME],
        {
          timeoutMs: DOCKER_TIMEOUT_MS,
        }
      );
      throw new CommandError(
        "the gateway container did not answer",
        tailLines(logs.stdout + logs.stderr)
      );
    }
    // A new container has none of the old one's networks.
    await this.rejoinNetworks();
    return target;
  }

  private async inspect(): Promise<GatewayInfo | undefined> {
    const args = [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{json .}}",
      GATEWAY_NAME,
    ];
    const r = await this.deps.run("docker", args, {
      timeoutMs: DOCKER_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
      return undefined;
    }
    return parseGatewayInspect(r.stdout.trim());
  }

  private async joinNetwork(network: string): Promise<void> {
    const r = await this.deps.run(
      "docker",
      ["network", "connect", network, GATEWAY_NAME],
      {
        timeoutMs: DOCKER_TIMEOUT_MS,
      }
    );
    if (
      r.exitCode !== 0 &&
      !/already (?<g1>exists|connected)/iu.test(r.stderr)
    ) {
      throw new CommandError(
        `could not connect the gateway to network ${network}: ${r.stderr.trim()}`
      );
    }
  }

  private async rejoinNetworks(): Promise<void> {
    // oxlint-disable-next-line unicorn/no-useless-spread -- joining may add to the set while it is iterated
    for (const network of [...this.networks]) {
      // A network that no longer exists is dropped; its containers are gone too.
      await this.joinNetwork(network).catch(() =>
        this.networks.delete(network)
      );
    }
  }

  private async docker(
    args: string[],
    timeoutMs: number,
    env?: Record<string, string>,
    onLine?: (line: string) => void
  ): Promise<void> {
    const r = await this.deps.run("docker", args, { env, onLine, timeoutMs });
    if (r.exitCode !== 0) {
      throw new CommandError(
        `docker ${args[0]} failed for the gateway container`,
        tailLines(r.stderr)
      );
    }
  }

  private ping(target: RelayTarget): Promise<boolean> {
    return (this.deps.ping ?? pingRelay)(target);
  }

  private async waitReady(target: RelayTarget): Promise<boolean> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 10_000);
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
