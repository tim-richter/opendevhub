import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { type Config, FileForgeStore, configDir, loadConfig, loadState, mergeRoots, saveConfig, saveState, stateDir } from "./config";
import { Containers } from "./containers";
import { EditorLauncher, detectEditors, pathWhich } from "./editors";
import { Cleanup } from "./cleanup";
import { createDashboardApp } from "./dashboard-api";
import { scanRoots } from "./discovery";
import { EnvFiles } from "./env-files";
import { spawnRunner } from "./exec";
import { Credentials } from "./credentials";
import { Gateway } from "./gateway";
import { GitOps } from "./git";
import { Images } from "./images";
import { Network, parseRouteMode } from "./network";
import { Onboarding } from "./onboarding";
import { OpencodeClient } from "./opencode/client";
import { OpencodeRuntime } from "./opencode/runtime";
import { Orchestrator } from "./orchestrator";
import { PortForwarder } from "./port-forwarder";
import { Publisher } from "./publish";
import { RelayRuntime } from "./relay/runtime";
import { startResourceSampler } from "./resources";
import { preflight } from "./preflight";
import { startNotifier } from "./notifier";
import { Push } from "./push";
import type { ResolveTarget } from "./proxy";
import { startServer } from "./server";
import { StateStore } from "./state";
import { UsageStore, trackUsage } from "./usage";
import { Worktrees } from "./worktrees";

const USAGE = `Usage: opendevhub [--root <dir>]... [--port <n>] [--no-open]

  -r, --root <dir>   Directory to scan for devcontainer projects (repeatable, saved)
  -p, --port <n>     Dashboard port (default 7777, saved)
      --no-open      Do not open the browser
  -h, --help         Show this help

Environment:
  OPENDEVHUB_ROUTE           auto (default), direct or gateway: how to reach containers
  OPENDEVHUB_GATEWAY_IMAGE   Image for the gateway container (default node:22-alpine)`;

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

/** The proxy's upstream for `<envId>.localhost`: a running environment's opencode, main or task. */
export function proxyTargets(
  store: Pick<StateStore, "runtime">,
  orchestrator: Pick<Orchestrator, "opencodeAddress">,
): ResolveTarget {
  return (envId) => {
    const rt = store.runtime(envId);
    const address = orchestrator.opencodeAddress(envId);
    if (rt.containerState !== "running" || !address || !rt.password) return undefined;
    return { ...address, password: rt.password };
  };
}

/** Merges the command line into the saved config and saves it, keeping every other saved key (forges). */
export function loadAndSaveStartupConfig(dir: string, opts: Pick<CliOptions, "roots" | "port">): Config {
  const saved = loadConfig(dir);
  const config: Config = { ...saved, roots: mergeRoots(saved.roots, opts.roots), port: opts.port ?? saved.port };
  saveConfig(dir, config);
  return config;
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
  let routeMode;
  try {
    routeMode = parseRouteMode(process.env.OPENDEVHUB_ROUTE);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 2;
    return;
  }

  const dir = configDir();
  const config = loadAndSaveStartupConfig(dir, opts);
  if (config.roots.length === 0) {
    console.error("No project roots configured yet. Run: opendevhub --root ~/code");
    process.exitCode = 2;
    return;
  }

  const store = new StateStore({ port: config.port, persisted: loadState(dir), persist: (s) => saveState(dir, s) });
  store.setRoots(config.roots);
  const usage = UsageStore.open(path.join(dir, "usage.db"));
  const usageTracker = usage ? trackUsage(usage, store) : undefined;
  const containers = new Containers(spawnRunner);
  const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
  const runtime = new OpencodeRuntime({ containers, clientFor });
  const editors = new EditorLauncher(await detectEditors(pathWhich()));
  store.setEditors(editors.list());
  const git = new GitOps({ containers });
  const orchestrator = new Orchestrator({
    store,
    containers,
    runtime,
    forwarder: new PortForwarder(),
    relay: new RelayRuntime({ containers }),
    network: new Network({
      mode: routeMode,
      gateway: new Gateway({ run: spawnRunner, image: process.env.OPENDEVHUB_GATEWAY_IMAGE || undefined }),
    }),
    git,
    images: new Images({ run: spawnRunner, containers, git }),
    envFiles: new EnvFiles(path.join(stateDir(), "envs")),
    projectSettings: (p) => loadConfig(dir).projects?.[p.path],
    worktrees: new Worktrees({
      containers,
      run: spawnRunner,
      relativeLinks: process.env.OPENDEVHUB_RELATIVE_WORKTREES !== "0",
    }),
    publisher: new Publisher({ containers, run: spawnRunner, forges: new FileForgeStore(dir) }),
    credentials: new Credentials({ run: spawnRunner, containers }),
    ...(usageTracker ? { recordUsage: usageTracker.record } : {}),
    editors,
    clientFor,
    roots: () => config.roots,
    scan: (roots) => scanRoots(roots),
  });
  const cleanup = new Cleanup({ store, containers, branches: orchestrator });

  store.setPreflight(await preflight(spawnRunner));
  await orchestrator.rescan();
  if (store.preflight().errors.length === 0) await orchestrator.adopt();

  const push = new Push({ file: path.join(stateDir(), "push.json") });
  const stopNotifier = startNotifier(store, push);
  const app = createDashboardApp({
    store,
    orchestrator,
    cleanup,
    push,
    onboarding: new Onboarding({ roots: () => config.roots }),
    ...(usage ? { usage } : {}),
    webDir: findWebDir(),
  });
  const server = await startServer({
    port: config.port,
    app,
    resolveTarget: proxyTargets(store, orchestrator),
  });
  const refresh = setInterval(() => void orchestrator.refreshContainers().catch(() => {}), 10_000);
  const sampler = startResourceSampler({ run: spawnRunner, store });

  console.log(`opendevhub running at ${server.url}`);
  for (const e of store.preflight().errors) console.warn(`warning: ${e}`);
  if (opts.open) await open(server.url).catch(() => {});

  const shutdown = async () => {
    clearInterval(refresh);
    sampler.stop();
    stopNotifier();
    usageTracker?.stop();
    await orchestrator.shutdown();
    usage?.close();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
