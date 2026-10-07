import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import {
  type Config,
  FileForgeStore,
  FileProjectSettings,
  addNode,
  configDir,
  nodeInUse,
  loadConfig,
  loadState,
  resolveRoots,
  removeNode,
  saveConfig,
  saveState,
  stateDir,
} from "./config";
import { Containers } from "./containers";
import { EditorLauncher, detectEditors, pathWhich } from "./editors";
import { Checks } from "./checks";
import { Cleanup } from "./cleanup";
import { createDashboardApp } from "./dashboard-api";
import { FileForgejoSettings, Forgejo } from "./forgejo";
import { FileJiraSettings, Jira } from "./jira";
import { scanRoots } from "./discovery";
import { EnvFiles } from "./env-files";
import { spawnRunner } from "./exec";
import { Credentials } from "./credentials";
import { Gateway } from "./gateway";
import { GitOps } from "./git";
import { Images } from "./images";
import { Network, parseRouteMode } from "./network";
import { NodeKits, buildNodeKit } from "./node-kits";
import { LOCAL_NODE } from "./host";
import { Nodes } from "./nodes";
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

  -r, --root <dir>   Directory to scan for devcontainer projects (default: current directory; repeatable)
  -p, --port <n>     Dashboard port (default 7777, saved)
      --no-open      Do not open the browser
  -h, --help         Show this help

Remote nodes:
  opendevhub nodes add <ssh-destination> [--label <name>]
  opendevhub nodes list
  opendevhub nodes remove <id>

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
  return { roots: values.root ?? [process.cwd()], port, open: !values["no-open"], help: values.help === true };
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

/** Saves the dashboard port while preserving the other settings. Scan roots are per-run. */
export function loadAndSaveStartupConfig(dir: string, opts: Pick<CliOptions, "port">): Config {
  const saved = loadConfig(dir);
  const config: Config = { ...saved, port: opts.port ?? saved.port };
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

const NODES_USAGE = "usage: opendevhub nodes add <ssh-destination> [--label <name>] | nodes list | nodes remove <id>";

/** `opendevhub nodes …`: edits config.json; a running opendevhub picks changes up on restart. */
export function runNodesCommand(argv: string[], dir: string, out: { log(s: string): void; error(s: string): void }): number {
  const [sub, ...rest] = argv;
  try {
    if (sub === "list") {
      const nodes = loadConfig(dir).nodes ?? [];
      if (nodes.length === 0) out.log("No nodes yet. Add one: opendevhub nodes add user@host");
      for (const n of nodes) out.log([n.id, n.ssh, ...(n.label ? [n.label] : [])].join("\t"));
      return 0;
    }
    if (sub === "add") {
      const { values, positionals } = parseArgs({ args: rest, options: { label: { type: "string" } }, allowPositionals: true, strict: true });
      if (positionals.length !== 1) throw new Error(NODES_USAGE);
      const { config, node } = addNode(loadConfig(dir), { ssh: positionals[0], ...(values.label ? { label: values.label } : {}) });
      saveConfig(dir, config);
      out.log(`added node ${node.id} (${node.ssh}); a running opendevhub connects to it after a restart, or add it on the Nodes page instead`);
      return 0;
    }
    if (sub === "remove" && rest.length === 1) {
      const cfg = loadConfig(dir);
      if (!cfg.nodes?.some((n) => n.id === rest[0])) throw new Error(`no node ${rest[0]}`);
      const environments = Object.values(loadState(dir).environments ?? {}).filter((e) => e.node === rest[0]).length;
      if (environments > 0) throw new Error(nodeInUse(rest[0], environments));
      saveConfig(dir, removeNode(cfg, rest[0]));
      out.log(`removed node ${rest[0]}`);
      return 0;
    }
    throw new Error(NODES_USAGE);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "nodes") {
    process.exitCode = runNodesCommand(argv.slice(1), configDir(), console);
    return;
  }
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
  const roots = resolveRoots(opts.roots);
  const store = new StateStore({ port: config.port, persisted: loadState(dir), persist: (s) => saveState(dir, s) });
  store.setRoots(roots);
  const nodes = new Nodes({
    configDir: dir,
    controlDir: path.join(dir, "ssh"),
    store,
    environmentsOn: (id) => store.projects().flatMap((p) => store.environments(p.id)).filter((e) => e.node === id).length,
    onOnline: (id) => void orchestrator.nodeOnline(id).catch(() => {}),
    onOffline: (id) => void orchestrator.nodeOffline(id).catch(() => {}),
  });
  const usage = UsageStore.open(path.join(dir, "usage.db"));
  const usageTracker = usage ? trackUsage(usage, store) : undefined;
  const containers = new Containers(spawnRunner);
  const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
  const kits = new NodeKits({ nodes, build: (conn) => buildNodeKit(conn, { clientFor, local: spawnRunner }) });
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
    nodes: kits,
    images: new Images({ run: spawnRunner, containers, objects: (p, wt, paths) => git.headObjects(p, wt.path, paths) }),
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
    roots: () => roots,
    scan: (roots) => scanRoots(roots),
  });
  const cleanup = new Cleanup({ store, containers, branches: orchestrator });
  const checks = new Checks({
    target: (id, directory) => orchestrator.checkTarget(id, directory),
    project: (id) => store.project(id),
    containers,
    run: spawnRunner,
    git,
    settings: new FileProjectSettings(dir),
    log: (id, line) => orchestrator.note(id, line),
  });

  store.setPreflight(await preflight(spawnRunner));
  await orchestrator.rescan();
  if (store.preflight().errors.length === 0) await orchestrator.adopt();
  // After the local containers, so a node coming online adopts into a settled store.
  nodes.start();

  const push = new Push({ file: path.join(stateDir(), "push.json") });
  const stopNotifier = startNotifier(store, push);
  const app = createDashboardApp({
    store,
    orchestrator,
    cleanup,
    checks,
    push,
    nodes,
    onboarding: new Onboarding({ roots: () => roots }),
    forgejo: new Forgejo(new FileForgejoSettings(dir)),
    jira: new Jira(new FileJiraSettings(dir)),
    ...(usage ? { usage } : {}),
    webDir: findWebDir(),
  });
  const server = await startServer({
    port: config.port,
    app,
    resolveTarget: proxyTargets(store, orchestrator),
    terminalTarget: async (id, directory) => {
      const target = await orchestrator.terminalTarget(id, directory);
      const remote = target.node && target.node !== LOCAL_NODE ? target.node : undefined;
      const conn = remote ? nodes.connection(remote) : undefined;
      if (remote && (!conn?.online || !conn.target)) throw new Error("The node is offline");
      return { ...target, ssh: conn?.target };
    },
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
    await nodes.close();
    usage?.close();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
