import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import open from "open";

import {
  FileForgeStore,
  FileProjectSettings,
  addNode,
  configDir,
  nodeInUse,
  loadConfig,
  loadState,
  removeNode,
  saveConfig,
  saveState,
  stateDir,
  validateRoots,
} from "./config";
import type { Config } from "./config";
import { createDashboardApp } from "./dashboard-api";
import { Checks } from "./environments/checks";
import { Containers } from "./environments/containers";
import { Credentials } from "./environments/credentials";
import {
  EditorLauncher,
  detectEditors,
  pathWhich,
} from "./environments/editors";
import type { Environments } from "./environments/environments";
import { EnvFiles } from "./environments/files";
import { Images } from "./environments/images";
import { ensureSpawnHelperExecutable } from "./environments/pty-helper";
import { startResourceSampler } from "./environments/resources";
import { Cleanup } from "./git/cleanup";
import { GitOps } from "./git/ops";
import { Publisher } from "./git/publish";
import { Worktrees } from "./git/worktrees";
import { createHub } from "./hub";
import { FileForgejoSettings, Forgejo } from "./integrations/forgejo";
import { FileJiraSettings, Jira } from "./integrations/jira";
import { Gateway } from "./network/gateway";
import { PortForwarder } from "./network/port-forwarder";
import type { ResolveTarget } from "./network/proxy";
import { RelayRuntime } from "./network/relay/runtime";
import { Network, parseRouteMode } from "./network/routes";
import { spawnRunner } from "./nodes/exec";
import { LOCAL_NODE } from "./nodes/host";
import { NodeKits, buildNodeKit } from "./nodes/kits";
import { Nodes } from "./nodes/registry";
import { startNotifier } from "./notifications/notifier";
import { Push } from "./notifications/push";
import { OpencodeClient } from "./opencode/client";
import { OpencodeRuntime } from "./opencode/runtime";
import { preflight } from "./preflight";
import { scanRoots } from "./projects/discovery";
import { Onboarding } from "./projects/onboarding";
import { StateStore } from "./projects/state";
import { startServer } from "./server";
import { UsageStore, trackUsage } from "./sessions/usage";
import { Specs } from "./specs/specs";
import { startDevUi } from "./vite-dev";

const USAGE = `Usage: opendevhub [--port <n>] [--no-open]

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
  port?: number;
  open: boolean;
  help: boolean;
}

export const parseCli = (argv: string[]): CliOptions => {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv,
    options: {
      help: { short: "h", type: "boolean" },
      "no-open": { type: "boolean" },
      port: { short: "p", type: "string" },
    },
    strict: true,
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  return {
    help: values.help === true,
    open: !values["no-open"],
    port,
  };
};

/** The proxy's upstream for `<envId>.localhost`: a running environment's opencode, main or task. */
export const proxyTargets =
  (
    store: Pick<StateStore, "runtime">,
    environments: Pick<Environments, "opencodeAddress">
  ): ResolveTarget =>
  (envId) => {
    const rt = store.runtime(envId);
    const address = environments.opencodeAddress(envId);
    if (rt.containerState !== "running" || !address || !rt.password) {
      return;
    }
    return { ...address, password: rt.password };
  };

/** Saves the dashboard port while preserving the other settings. */
export const loadAndSaveStartupConfig = (
  dir: string,
  opts: Pick<CliOptions, "port">
): Config => {
  const saved = loadConfig(dir);
  const config: Config = { ...saved, port: opts.port ?? saved.port };
  saveConfig(dir, config);
  return config;
};

export const findWebDir = (): string | undefined => {
  const here = import.meta.dirname;
  for (const candidate of [
    path.join(here, "web"),
    path.resolve(here, "../../dist/web"),
  ]) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return undefined;
};

const NODES_USAGE =
  "usage: opendevhub nodes add <ssh-destination> [--label <name>] | nodes list | nodes remove <id>";

/** `opendevhub nodes …`: edits config.json; a running opendevhub picks changes up on restart. */
export const runNodesCommand = (
  argv: string[],
  dir: string,
  out: { log: (s: string) => void; error: (s: string) => void }
): number => {
  const [sub, ...rest] = argv;
  try {
    if (sub === "list") {
      const nodes = loadConfig(dir).nodes ?? [];
      if (nodes.length === 0) {
        out.log("No nodes yet. Add one: opendevhub nodes add user@host");
      }
      for (const n of nodes) {
        out.log([n.id, n.ssh, ...(n.label ? [n.label] : [])].join("\t"));
      }
      return 0;
    }
    if (sub === "add") {
      const { values, positionals } = parseArgs({
        allowPositionals: true,
        args: rest,
        options: { label: { type: "string" } },
        strict: true,
      });
      if (positionals.length !== 1) {
        throw new Error(NODES_USAGE);
      }
      const { config, node } = addNode(loadConfig(dir), {
        ssh: positionals[0],
        ...(values.label ? { label: values.label } : {}),
      });
      saveConfig(dir, config);
      out.log(
        `added node ${node.id} (${node.ssh}); a running opendevhub connects to it after a restart, or add it on the Nodes page instead`
      );
      return 0;
    }
    if (sub === "remove" && rest.length === 1) {
      const cfg = loadConfig(dir);
      if (!cfg.nodes?.some((n) => n.id === rest[0])) {
        throw new Error(`no node ${rest[0]}`);
      }
      const environments = Object.values(
        loadState(dir).environments ?? {}
      ).filter((e) => e.node === rest[0]).length;
      if (environments > 0) {
        throw new Error(nodeInUse(rest[0], environments));
      }
      saveConfig(dir, removeNode(cfg, rest[0]));
      out.log(`removed node ${rest[0]}`);
      return 0;
    }
    throw new Error(NODES_USAGE);
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
};

export const main = async (argv = process.argv.slice(2)): Promise<void> => {
  if (argv[0] === "nodes") {
    process.exitCode = runNodesCommand(argv.slice(1), configDir(), console);
    return;
  }
  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  ensureSpawnHelperExecutable();
  let routeMode;
  try {
    routeMode = parseRouteMode(process.env.OPENDEVHUB_ROUTE);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }

  const dir = configDir();
  const config = loadAndSaveStartupConfig(dir, opts);
  // Edited in Settings; the scans below read the current list.
  let roots = config.roots ?? [];
  const store = new StateStore({
    persist: (s) => saveState(dir, s),
    persisted: loadState(dir),
    port: config.port,
  });
  store.setRoots(roots);
  const nodes = new Nodes({
    configDir: dir,
    controlDir: path.join(dir, "ssh"),
    environmentsOn: (id) =>
      store
        .projects()
        .flatMap((p) => store.environments(p.id))
        .filter((e) => e.node === id).length,
    onOffline: (id) =>
      void hub.environments.nodeOffline(id).catch(() => undefined),
    onOnline: (id) =>
      void hub.environments.nodeOnline(id).catch(() => undefined),
    store,
  });
  const usage = UsageStore.open(path.join(dir, "usage.db"));
  const usageTracker = usage ? trackUsage(usage, store) : undefined;
  const containers = new Containers(spawnRunner);
  const clientFor = (ep: { baseUrl: string; password: string }) =>
    new OpencodeClient(ep);
  const kits = new NodeKits({
    build: (conn) => buildNodeKit(conn, { clientFor, local: spawnRunner }),
    nodes,
  });
  const runtime = new OpencodeRuntime({ clientFor, containers });
  const editors = new EditorLauncher(await detectEditors(pathWhich()));
  store.setEditors(editors.list());
  const git = new GitOps({ containers });
  const hub = createHub({
    store,
    containers,
    runtime,
    forwarder: new PortForwarder(),
    relay: new RelayRuntime({ containers }),
    network: new Network({
      gateway: new Gateway({
        image: process.env.OPENDEVHUB_GATEWAY_IMAGE || undefined,
        run: spawnRunner,
      }),
      mode: routeMode,
    }),
    git,
    nodes: kits,
    images: new Images({
      containers,
      objects: (p, wt, paths) => git.headObjects(p, wt.path, paths),
      run: spawnRunner,
    }),
    envFiles: new EnvFiles(path.join(stateDir(), "envs")),
    projectSettings: (p) => loadConfig(dir).projects?.[p.path],
    worktrees: new Worktrees({
      containers,
      relativeLinks: process.env.OPENDEVHUB_RELATIVE_WORKTREES !== "0",
      run: spawnRunner,
    }),
    publisher: new Publisher({
      containers,
      forges: new FileForgeStore(dir),
      run: spawnRunner,
    }),
    credentials: new Credentials({ containers, run: spawnRunner }),
    ...(usageTracker ? { recordUsage: usageTracker.record } : {}),
    editors,
    clientFor,
    roots: () => roots,
    scan: (toScan) => scanRoots(toScan),
  });
  const cleanup = new Cleanup({
    branches: hub.cleanupTargets,
    containers,
    log: (id, line) => hub.environments.note(id, line),
    store,
  });
  const checks = new Checks({
    containers,
    git,
    log: (id, line) => hub.environments.note(id, line),
    project: (id) => store.project(id),
    run: spawnRunner,
    settings: new FileProjectSettings(dir),
    target: (id, directory) => hub.checkouts.checkTarget(id, directory),
  });

  const specs = new Specs({
    client: (envId) => hub.environments.opencodeClient(envId),
    containers,
    log: (id, line) => hub.environments.note(id, line),
    reconcile: (envId) => hub.environments.reconcile(envId),
    sessions: (id) => store.sessionsOf(id),
    target: (id, directory) => hub.checkouts.checkTarget(id, directory),
  });

  store.setPreflight(await preflight(spawnRunner));
  await hub.environments.rescan();
  if (store.preflight().errors.length === 0) {
    await hub.environments.adopt();
  }
  // After the local containers, so a node coming online adopts into a settled store.
  nodes.start();

  const push = new Push({ file: path.join(stateDir(), "push.json") });
  const stopNotifier = startNotifier(store, push);
  const app = createDashboardApp({
    store,
    hub,
    cleanup,
    checks,
    specs,
    push,
    nodes,
    onboarding: new Onboarding({ roots: () => roots }),
    saveRoots: (input) => {
      const next = validateRoots(input);
      const saved = loadConfig(dir);
      saveConfig(dir, { ...saved, roots: next });
      roots = next;
      store.setRoots(next);
    },
    forgejo: new Forgejo(new FileForgejoSettings(dir)),
    jira: new Jira(new FileJiraSettings(dir)),
    ...(usage ? { usage } : {}),
    webDir: findWebDir(),
  });
  const server = await startServer({
    app,
    ...(process.env.OPENDEVHUB_DEV === "1"
      ? { devUi: await startDevUi() }
      : {}),
    port: config.port,
    resolveTarget: proxyTargets(store, hub.environments),
    terminalTarget: async (id, directory) => {
      const target = await hub.environments.terminalTarget(id, directory);
      const remote =
        target.node && target.node !== LOCAL_NODE ? target.node : undefined;
      const conn = remote ? nodes.connection(remote) : undefined;
      if (remote && (!conn?.online || !conn.target)) {
        throw new Error("The node is offline");
      }
      return { ...target, ssh: conn?.target };
    },
  });
  const refresh = setInterval(
    () => void hub.environments.refreshContainers().catch(() => undefined),
    10_000
  );
  const sampler = startResourceSampler({ run: spawnRunner, store });

  console.log(`opendevhub running at ${server.url}`);
  for (const e of store.preflight().errors) {
    console.warn(`warning: ${e}`);
  }
  if (opts.open) {
    await open(server.url).catch(() => undefined);
  }

  const shutdown = async () => {
    clearInterval(refresh);
    sampler.stop();
    stopNotifier();
    usageTracker?.stop();
    await hub.environments.shutdown();
    await nodes.close();
    usage?.close();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
};
