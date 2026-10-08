import { randomBytes } from "node:crypto";

import { CommandError, tailLines } from "../containers";
import type { Containers, ExecTarget } from "../containers";
import type { HostPort } from "../network";
import type { OpencodeClient, OpencodeEndpoint } from "./client";

export const OPENCODE_PORT = 4096;
const LOG_FILE = "/tmp/opendevhub-opencode.log";
const KILL_SERVER = "pkill -f 'opencode [s]erve' || true";

// `devcontainer exec` does not read shell rc files, so the installer's PATH entry
// (added to .bashrc/.zshrc) is invisible. Check PATH, the usual install dirs, then
// ask bash/zsh (login and plain interactive, since bash -l skips .bashrc); print the first absolute path to an executable.
const RESOLVE_BINARY = `
check() { case "$1" in /*) [ -x "$1" ] && { echo "$1"; exit 0; } ;; esac; }
check "$(command -v opencode 2>/dev/null)"
check "$HOME/.opencode/bin/opencode"
check "$HOME/.local/bin/opencode"
check "$HOME/.bun/bin/opencode"
for sh in bash zsh; do
  command -v "$sh" >/dev/null 2>&1 || continue
  for flags in -lic -ic; do
    check "$("$sh" "$flags" 'command -v opencode' 2>/dev/null < /dev/null | grep '^/' | tail -n 1)"
  done
done
exit 1
`;
const SEARCHED =
  "PATH, ~/.opencode/bin, ~/.local/bin, ~/.bun/bin and bash/zsh login shells";

/** Where an environment's opencode volume is mounted. Sessions, auth and UI state live here, so they outlive the container. */
export const OPENCODE_STATE_DIR = "/opendevhub/opencode";
const VOLUME_PREFIX = "opendevhub-opencode-";
export const VOLUME_LABEL = "opendevhub.volume";

/** One volume per environment: two opencode servers never share a database. */
export const opencodeVolume = (envId: string): string =>
  `${VOLUME_PREFIX}${envId}`;

export const opencodeMount = (envId: string): string =>
  `type=volume,source=${opencodeVolume(envId)},target=${OPENCODE_STATE_DIR}`;

/** Prints `owner <uid>:<gid>` of the remote user, and `readonly` when it can't write the volume; `unmounted` without one. */
const PROBE_STATE = `[ -d "$ODH_STATE" ] || { echo unmounted; exit 0; }
echo "owner $(id -u):$(id -g)"
[ -w "$ODH_STATE" ] || echo readonly
exit 0`;

/** Gives the volume to the remote user; recursive only when it belonged to someone else (an image with another user). */
const CHOWN_STATE = `[ "$(stat -c %u:%g "$ODH_STATE")" = "$ODH_OWNER" ] || chown -R "$ODH_OWNER" "$ODH_STATE"`;

/**
 * Points opencode's XDG data and state folders at the volume. A folder already on a mount (the devcontainer
 * persists it) is left alone. Local data moves into an empty volume; otherwise the volume wins and the local
 * folder is kept aside. Prints one `<kind> <result>` line per folder.
 */
export const LINK_STATE = `under_mount() {
  awk -v p="$1" '$5 != "/" && (p == $5 || index(p, $5 "/") == 1) { f = 1 } END { exit !f }' "\${ODH_MOUNTINFO:-/proc/self/mountinfo}" 2>/dev/null
}
link() {
  d="$2/opencode"; s="$ODH_STATE/$1"
  [ "$(readlink "$d" 2>/dev/null)" = "$s" ] && { echo "$1 kept"; return 0; }
  if [ ! -L "$d" ] && under_mount "$d"; then echo "$1 own-mount"; return 0; fi
  mkdir -p "$s" "$2" || return 1
  if [ -L "$d" ]; then
    rm -f "$d" || return 1
  elif [ -e "$d" ]; then
    if [ -z "$(ls -A "$s")" ]; then
      cp -a "$d/." "$s/" && rm -rf "$d" || return 1
      echo "$1 moved"
    else
      mv "$d" "$d.before-opendevhub.$(date +%s)" || return 1
      echo "$1 set-aside"
    fi
  fi
  ln -s "$s" "$d" && echo "$1 linked"
}
link data "\${XDG_DATA_HOME:-$HOME/.local/share}" || exit 1
link state "\${XDG_STATE_HOME:-$HOME/.local/state}" || exit 1`;

const LINK_RESULTS: Record<string, string> = {
  "own-mount": "already on a mount, left as is",
  kept: "on the opendevhub volume",
  linked: "now on the opendevhub volume",
  moved: "moved onto the opendevhub volume",
  "set-aside":
    "on the opendevhub volume (the container's own copy was set aside)",
};

/** Last line of the output that is an absolute path to an `opencode` binary (shells may print noise). */
export const parseBinaryPath = (output: string): string | undefined =>
  output
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .findLast((l) => /^\/\S*\/opencode$/u.test(l));

export const parseOpencodeVersion = (output: string): string | undefined =>
  output.match(/(?<g1>\d+)\.(?<g2>\d+)\.(?<g3>\d+)/u)?.[0];

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export interface RuntimeDeps {
  containers: Pick<Containers, "exec" | "execAsRoot">;
  clientFor: (ep: OpencodeEndpoint) => OpencodeClient;
  port?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  generatePassword?: () => string;
}

export class OpencodeRuntime {
  private readonly deps: RuntimeDeps;
  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  /** `address` is where the host reaches opencode (see Route), not necessarily the container port. */
  endpoint(address: HostPort, password: string): OpencodeEndpoint {
    return { baseUrl: `http://${address.host}:${address.port}`, password };
  }

  async isHealthy(ep: OpencodeEndpoint): Promise<boolean> {
    try {
      await this.deps.clientFor(ep).info();
      return true;
    } catch {
      return false;
    }
  }

  async resolveBinary(target: ExecTarget): Promise<string | undefined> {
    const resolved = await this.deps.containers.exec(target, [
      "sh",
      "-c",
      RESOLVE_BINARY,
    ]);
    return resolved.exitCode === 0
      ? parseBinaryPath(resolved.stdout)
      : undefined;
  }

  async ensureRunning(
    target: ExecTarget,
    args: {
      address: HostPort;
      password?: string;
      workspaceFolder: string;
      onLine: (line: string) => void;
      /** Extra environment for `opencode serve` (and so for every tool the agent runs). */
      env?: Record<string, string>;
      /** The container, to keep opencode's data on its volume (see `opencodeMount`). */
      containerId?: string;
    }
  ): Promise<{ password: string; version: string }> {
    if (args.password) {
      try {
        const info = await this.deps
          .clientFor(this.endpoint(args.address, args.password))
          .info();
        return { password: args.password, version: info.version };
      } catch {
        // not running or different password: relaunch below
      }
    }

    const { containers } = this.deps;
    const binary = await this.resolveBinary(target);
    if (!binary) {
      throw new CommandError(
        `opencode v2 not found in the devcontainer (searched ${SEARCHED})`
      );
    }
    const versionRun = await containers.exec(target, [binary, "--version"]);
    if (versionRun.exitCode !== 0) {
      throw new CommandError(
        `failed to run ${binary} --version`,
        tailLines(versionRun.stderr + versionRun.stdout)
      );
    }
    const version = parseOpencodeVersion(versionRun.stdout);
    if (!version || Number(version.split(".")[0]) < 2) {
      throw new CommandError(
        `opencode ${version ?? "(unknown version)"} found, but opendevhub requires opencode v2`
      );
    }
    args.onLine(`opencode ${version} found at ${binary}`);

    const password =
      this.deps.generatePassword?.() ?? randomBytes(32).toString("base64url");
    const port = this.deps.port ?? OPENCODE_PORT;
    await containers.exec(target, ["sh", "-c", KILL_SERVER]);
    // After the kill, so no running server holds the folders being moved.
    if (args.containerId) {
      await this.persistState(target, args.containerId, args.onLine);
    }
    const script =
      `cd ${shellQuote(args.workspaceFolder)} && ` +
      `nohup ${shellQuote(binary)} serve --hostname 0.0.0.0 --port ${port} < /dev/null > ${LOG_FILE} 2>&1 &`;
    const launch = await containers.exec(target, ["sh", "-c", script], {
      env: { ...args.env, OPENCODE_PASSWORD: password },
    });
    if (launch.exitCode !== 0) {
      throw new CommandError(
        "failed to launch opencode serve",
        tailLines(launch.stderr + launch.stdout)
      );
    }
    args.onLine(`launched opencode serve on port ${port}; waiting for health`);

    const ep = this.endpoint(args.address, password);
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (await this.isHealthy(ep)) {
        return { password, version };
      }
      await new Promise((resolve) => {
        setTimeout(resolve, this.deps.healthIntervalMs ?? 500);
      });
    }
    const log = await containers.exec(target, [
      "sh",
      "-c",
      `tail -n 20 ${LOG_FILE} 2>/dev/null`,
    ]);
    throw new CommandError(
      "opencode did not become healthy within 30 s",
      tailLines(log.stdout)
    );
  }

  /**
   * Links opencode's data and state folders to the environment's volume before opencode opens them. Never
   * throws: without it opencode still runs, its sessions just live and die with the container.
   */
  async persistState(
    target: ExecTarget,
    containerId: string,
    onLine: (line: string) => void
  ): Promise<void> {
    const { containers } = this.deps;
    const env = { ODH_STATE: OPENCODE_STATE_DIR };
    const probe = await containers.exec(target, ["sh", "-c", PROBE_STATE], {
      env,
    });
    const owner = probe.stdout.match(/^owner (?<id>\d+:\d+)$/mu)?.groups?.id;
    if (probe.exitCode !== 0 || !owner) {
      onLine(
        "opencode: this container has no sessions volume, so its sessions are lost when it is rebuilt (the next rebuild adds the volume)"
      );
      return;
    }
    if (/^readonly$/mu.test(probe.stdout)) {
      const chown = await containers.execAsRoot(
        containerId,
        ["sh", "-c", CHOWN_STATE],
        { env: { ...env, ODH_OWNER: owner } }
      );
      if (chown.exitCode !== 0) {
        onLine(
          `opencode: could not give ${OPENCODE_STATE_DIR} to the container user (${tailLines(chown.stderr, 1).at(-1) ?? `exit ${chown.exitCode}`})`
        );
        return;
      }
    }
    const link = await containers.exec(target, ["sh", "-c", LINK_STATE], {
      env,
    });
    for (const m of link.stdout.matchAll(
      /^(?<kind>data|state) (?<result>[\w-]+)$/gmu
    )) {
      const { kind, result } = m.groups ?? {};
      onLine(`opencode ${kind}: ${LINK_RESULTS[result] ?? result}`);
    }
    if (link.exitCode !== 0) {
      onLine(`opencode: could not link its data to ${OPENCODE_STATE_DIR}`);
      for (const l of tailLines(link.stderr + link.stdout, 5)) {
        onLine(`  ${l}`);
      }
    }
  }

  async stopServer(target: ExecTarget): Promise<void> {
    await this.deps.containers.exec(target, ["sh", "-c", KILL_SERVER]);
  }
}
