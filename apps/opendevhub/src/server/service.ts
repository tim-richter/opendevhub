import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import type { Runner } from "./nodes/exec";

// `opendevhub service …`: runs the dashboard in the background from login on, as a systemd user
// unit on Linux or a launchd agent on macOS, so the installed PWA always finds a server.

export const SYSTEMD_UNIT = "opendevhub.service";
export const LAUNCHD_LABEL = "dev.opendevhub";

/** The `state = running` line of `launchctl print`. */
const LAUNCHD_STATE = /^\s*state = (?<state>.+)$/mu;

export const SERVICE_USAGE =
  "usage: opendevhub service install [--port <n>] | service uninstall | service status";

/** What the service runs: this node, this script, on a fixed port, with the environment it needs. */
export interface ServiceSpec {
  node: string;
  script: string;
  port: number;
  env: Record<string, string>;
  /** launchd only: where the agent's stdout and stderr go. */
  logFile: string;
}

/** The variables a service inherits from the shell that installed it; a login session has few of its own. */
const INHERITED = new Set([
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
]);
/** Development switches that must not leak into a long-running service. */
const NOT_INHERITED = new Set(["OPENDEVHUB_DEV", "OPENDEVHUB_E2E"]);

export const serviceEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const wanted =
      INHERITED.has(key) ||
      (key.startsWith("OPENDEVHUB_") && !NOT_INHERITED.has(key));
    if (wanted && value !== undefined && value !== "") {
      picked[key] = value;
    }
  }
  return picked;
};

/** Why `script` can't back a service, or undefined when it can. */
export const launcherProblem = (script: string): string | undefined => {
  if (path.extname(script) !== ".js") {
    return "run `service install` from a built opendevhub (npm i -g opendevhub), not from source";
  }
  const parts = script.split(path.sep);
  if (parts.includes("_npx") || parts.includes("dlx")) {
    return "npx runs opendevhub from a temporary cache the service can't rely on. Install it first: npm i -g opendevhub, then run opendevhub service install";
  }
  return undefined;
};

/** A systemd value in double quotes: backslashes and quotes escaped, `%` and `$` doubled so they stay literal. */
const systemdQuote = (value: string): string =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$")}"`;

const args = (spec: ServiceSpec): string[] => [
  spec.node,
  spec.script,
  "--no-open",
  "--port",
  String(spec.port),
];

export const systemdUnit = (spec: ServiceSpec): string =>
  [
    "[Unit]",
    "Description=opendevhub dashboard",
    "",
    "[Service]",
    `ExecStart=${args(spec).map(systemdQuote).join(" ")}`,
    ...Object.entries(spec.env).map(
      ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`
    ),
    // Also covers a start while opendevhub still runs in a terminal: the port frees up when that one exits.
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const launchdPlist = (spec: ServiceSpec): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args(spec).map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(spec.env).map(
      ([key, value]) =>
        `    <key>${xml(key)}</key><string>${xml(value)}</string>`
    ),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    // Restarted after a crash, but not after a clean exit (Ctrl+C equivalent, `service uninstall`).
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>StandardOutPath</key><string>${xml(spec.logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(spec.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  run: Runner;
  /** Builds the spec for `install`; throws when this opendevhub can't back a service. */
  spec: (port: number | undefined) => ServiceSpec;
  out: { log: (s: string) => void; error: (s: string) => void };
}

export const serviceFile = (platform: NodeJS.Platform, home: string): string =>
  platform === "darwin"
    ? path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    : path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);

const parsePort = (rest: string[]): number | undefined => {
  const { values } = parseArgs({
    allowPositionals: false,
    args: rest,
    options: { port: { short: "p", type: "string" } },
    strict: true,
  });
  if (values.port === undefined) {
    return undefined;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  return port;
};

/** Runs a command and throws its stderr when it fails. */
const must = async (
  run: Runner,
  cmd: string,
  cmdArgs: string[]
): Promise<string> => {
  const result = await run(cmd, cmdArgs, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `${cmd} ${cmdArgs.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout;
};

const systemctl = (deps: ServiceDeps, ...rest: string[]) =>
  must(deps.run, "systemctl", ["--user", ...rest]);

const install = async (deps: ServiceDeps, port: number | undefined) => {
  const spec = deps.spec(port);
  const file = serviceFile(deps.platform, deps.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (deps.platform === "darwin") {
    fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
    fs.writeFileSync(file, launchdPlist(spec));
    const domain = `gui/${deps.uid}`;
    // An agent from an earlier install keeps its old definition until it is booted out.
    await deps.run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    await must(deps.run, "launchctl", ["bootstrap", domain, file]);
  } else {
    fs.writeFileSync(file, systemdUnit(spec));
    await systemctl(deps, "daemon-reload");
    await systemctl(deps, "enable", SYSTEMD_UNIT);
    await systemctl(deps, "restart", SYSTEMD_UNIT);
  }
  deps.out.log(`installed ${file}`);
  deps.out.log(
    `opendevhub now starts at login on http://localhost:${spec.port}/ (node ${spec.node})`
  );
  deps.out.log(
    "If opendevhub is still running in a terminal, stop it; the service takes over its port."
  );
};

const uninstall = async (deps: ServiceDeps) => {
  const file = serviceFile(deps.platform, deps.home);
  if (deps.platform === "darwin") {
    await deps.run("launchctl", [
      "bootout",
      `gui/${deps.uid}/${LAUNCHD_LABEL}`,
    ]);
  } else {
    // Fails harmlessly when the unit was never loaded.
    await deps.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  }
  if (!fs.existsSync(file)) {
    deps.out.log("the opendevhub service is not installed");
    return;
  }
  fs.rmSync(file);
  if (deps.platform !== "darwin") {
    await systemctl(deps, "daemon-reload");
  }
  deps.out.log(`removed ${file}; opendevhub no longer starts at login`);
};

const status = async (deps: ServiceDeps) => {
  const file = serviceFile(deps.platform, deps.home);
  if (!fs.existsSync(file)) {
    deps.out.log("not installed. Install it: opendevhub service install");
    return;
  }
  if (deps.platform === "darwin") {
    const result = await deps.run("launchctl", [
      "print",
      `gui/${deps.uid}/${LAUNCHD_LABEL}`,
    ]);
    const state =
      result.exitCode === 0
        ? (LAUNCHD_STATE.exec(result.stdout)?.groups?.state ?? "loaded")
        : "not loaded";
    deps.out.log(`${state} (${file})`);
    return;
  }
  // is-active exits non-zero for every state but active, so its output is the answer either way.
  const result = await deps.run("systemctl", [
    "--user",
    "is-active",
    SYSTEMD_UNIT,
  ]);
  deps.out.log(`${result.stdout.trim() || "unknown"} (${file})`);
  deps.out.log(`logs: journalctl --user -u ${SYSTEMD_UNIT}`);
};

export const runServiceCommand = async (
  argv: string[],
  deps: ServiceDeps
): Promise<number> => {
  const [sub, ...rest] = argv;
  try {
    if (deps.platform !== "linux" && deps.platform !== "darwin") {
      throw new Error("opendevhub service supports Linux (systemd) and macOS");
    }
    if (sub === "install") {
      await install(deps, parsePort(rest));
      return 0;
    }
    if (sub === "uninstall" && rest.length === 0) {
      await uninstall(deps);
      return 0;
    }
    if (sub === "status" && rest.length === 0) {
      await status(deps);
      return 0;
    }
    throw new Error(SERVICE_USAGE);
  } catch (error) {
    deps.out.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
};
