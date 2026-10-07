import type { Duplex } from "node:stream";

import type { NodeStats } from "../shared/types";
import { ENV_LABEL, LABEL } from "./containers";
import type { Runner } from "./exec";
import type { Host } from "./host";
import { parseGitVersion, supportsRelativePaths } from "./worktrees";

const TIMEOUT_MS = 15_000;
const PATH_HINT =
  "on the PATH of a non-interactive ssh shell (tools installed through nvm or a login profile aren't on it; see the README)";

/** What keeps a node from running environments; empty when it's ready. */
export const nodePreflight = async (
  host: Pick<Host, "run" | "dial">,
  sshPort: number,
  dest: string
): Promise<string[]> => {
  const errors: string[] = [];
  const docker = await host.run(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { timeoutMs: TIMEOUT_MS }
  );
  if (docker.exitCode === 127) {
    errors.push(`docker not found ${PATH_HINT}`);
  } else if (docker.exitCode !== 0) {
    errors.push(
      "the Docker daemon is not reachable (is Docker running, and may the ssh user use it?)"
    );
  }
  const devcontainer = await host.run("devcontainer", ["--version"], {
    timeoutMs: TIMEOUT_MS,
  });
  if (devcontainer.exitCode !== 0) {
    errors.push(`devcontainer CLI not found ${PATH_HINT}`);
  }
  const git = await host.run("git", ["--version"], { timeoutMs: TIMEOUT_MS });
  if (git.exitCode !== 0) {
    errors.push(`git not found ${PATH_HINT}`);
  } else if (!supportsRelativePaths(parseGitVersion(git.stdout))) {
    errors.push(`git 2.48 or newer is needed (found ${git.stdout.trim()})`);
  }
  const home = await host.run(
    "sh",
    ["-c", 'mkdir -p "$HOME/.opendevhub" && test -w "$HOME/.opendevhub"'],
    { timeoutMs: TIMEOUT_MS }
  );
  if (home.exitCode !== 0) {
    errors.push("~/.opendevhub can't be created or isn't writable");
  }
  const forwarding = await probeForwarding(host, sshPort, dest);
  if (forwarding) {
    errors.push(forwarding);
  }
  return errors;
};

/**
 * Opens a channel from the node to its own sshd. A greeting, or a refusal (the channel opened and
 * the port said no), means forwarding works; "administratively prohibited" means sshd forbids it.
 */
export const probeForwarding = async (
  host: Pick<Host, "dial">,
  sshPort: number,
  dest: string,
  timeoutMs = 5000
): Promise<string | undefined> => {
  let stream: Duplex;
  try {
    stream = await host.dial("127.0.0.1", sshPort);
  } catch (error) {
    return `opening an ssh channel to ${dest} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return new Promise((resolve) => {
    const done = (result: string | undefined) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.on("error", () => undefined);
      stream.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => done(`sshd on ${dest} did not answer through a forwarded channel`),
      timeoutMs
    );
    stream.once("data", (chunk: Buffer) =>
      done(
        chunk.toString("utf-8").startsWith("SSH-")
          ? undefined
          : `unexpected answer through a forwarded channel to ${dest}`
      )
    );
    stream.once("error", (err: Error) => {
      if (/administratively prohibited/iu.test(err.message)) {
        done(
          `sshd on ${dest} does not allow TCP forwarding (AllowTcpForwarding)`
        );
      } else if (/Connection refused/iu.test(err.message)) {
        done(undefined);
      } else {
        done(`a forwarded channel to ${dest} failed: ${err.message}`);
      }
    });
  });
};

const STATS_SCRIPT = [
  "nproc",
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  `docker ps -q --filter label=${LABEL} | wc -l`,
  `docker ps -q --filter label=${ENV_LABEL} | wc -l`,
].join("; ");

/** `nproc`, two /proc/meminfo lines and two container counts. */
export const parseNodeStats = (stdout: string): NodeStats | undefined => {
  const lines = stdout
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB$`, "u").exec(
      lines.find((l) => l.startsWith(`${key}:`)) ?? ""
    );
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const memTotal = kb("MemTotal");
  const memAvailable = kb("MemAvailable");
  const numbers = lines.filter((l) => /^\d+$/u.test(l)).map(Number);
  if (
    numbers.length < 3 ||
    !(numbers[0] > 0) ||
    memTotal === undefined ||
    memAvailable === undefined
  ) {
    return undefined;
  }
  return {
    containers: numbers[1] + numbers[2],
    cpus: numbers[0],
    memAvailable,
    memTotal,
  };
};

/** A node's capacity, or undefined when it can't be read (no /proc/meminfo, ssh down). */
export const nodeStats = async (
  run: Runner
): Promise<NodeStats | undefined> => {
  const r = await run("sh", ["-c", STATS_SCRIPT], { timeoutMs: TIMEOUT_MS });
  return r.exitCode === 0 ? parseNodeStats(r.stdout) : undefined;
};
