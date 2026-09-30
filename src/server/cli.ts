import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { configDir, loadConfig, loadState, mergeRoots, saveConfig, saveState } from "./config";
import { Containers } from "./containers";
import { createDashboardApp } from "./dashboard-api";
import { scanRoots } from "./discovery";
import { spawnRunner } from "./exec";
import { OpencodeClient } from "./opencode/client";
import { OPENCODE_PORT, OpencodeRuntime } from "./opencode/runtime";
import { Orchestrator } from "./orchestrator";
import { PortForwarder } from "./port-forwarder";
import { preflight } from "./preflight";
import { startServer } from "./server";
import { StateStore } from "./state";

const USAGE = `Usage: opendevhub [--root <dir>]... [--port <n>] [--no-open]

  -r, --root <dir>   Directory to scan for devcontainer projects (repeatable, saved)
  -p, --port <n>     Dashboard port (default 7777, saved)
      --no-open      Do not open the browser
  -h, --help         Show this help`;

export interface CliOptions {
  roots: string[];
  port?: number;
  open: boolean;
  help: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", short: "r", multiple: true },
      port: { type: "string", short: "p" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  return { roots: values.root ?? [], port, open: !values["no-open"], help: values.help === true };
}

export function findWebDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "web"), path.resolve(here, "../../dist/web")]) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const dir = configDir();
  const saved = loadConfig(dir);
  const config = { roots: mergeRoots(saved.roots, opts.roots), port: opts.port ?? saved.port };
  saveConfig(dir, config);
  if (config.roots.length === 0) {
    console.error("No project roots configured yet. Run: opendevhub --root ~/code");
    process.exitCode = 2;
    return;
  }

  const store = new StateStore({ port: config.port, persisted: loadState(dir), persist: (s) => saveState(dir, s) });
  store.setRoots(config.roots);
  const containers = new Containers(spawnRunner);
  const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
  const runtime = new OpencodeRuntime({ containers, clientFor });
  const orchestrator = new Orchestrator({
    store,
    containers,
    runtime,
    forwarder: new PortForwarder(),
    clientFor,
    roots: () => config.roots,
    scan: (roots) => scanRoots(roots),
  });

  store.setPreflight(await preflight(spawnRunner));
  await orchestrator.rescan();
  if (store.preflight().errors.length === 0) await orchestrator.adopt();

  const app = createDashboardApp({ store, orchestrator, webDir: findWebDir() });
  const server = await startServer({
    port: config.port,
    app,
    resolveTarget: (id) => {
      const rt = store.runtime(id);
      if (rt.containerState !== "running" || !rt.containerIp || !rt.password) return undefined;
      return { host: rt.containerIp, port: OPENCODE_PORT, password: rt.password };
    },
  });
  const refresh = setInterval(() => void orchestrator.refreshContainers().catch(() => {}), 10_000);

  console.log(`opendevhub running at ${server.url}`);
  for (const e of store.preflight().errors) console.warn(`warning: ${e}`);
  if (opts.open) await open(server.url).catch(() => {});

  const shutdown = async () => {
    clearInterval(refresh);
    await orchestrator.shutdown();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
