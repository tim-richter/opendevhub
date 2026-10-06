import type { NodeId, NodeStats, NodeView } from "../shared/types";
import { InvalidNodeError, type NodeConfig, addNode, loadConfig, removeNode, saveConfig } from "./config";
import type { Runner } from "./exec";
import { type Host, LOCAL_NODE, localHost } from "./host";
import { NodeConnection } from "./node-connection";
import { nodeStats } from "./node-preflight";
import { NotFoundError } from "./orchestrator";
import type { SshTarget } from "./ssh";
import type { StateStore } from "./state";

/** What the registry needs from a connection; NodeConnection is one. */
export interface NodeConnectionPort {
  readonly host: Host;
  readonly online: boolean;
  /** The ssh destination and ControlMaster socket; absent on fakes that don't need them. */
  readonly target?: SshTarget;
  view(): NodeView;
  start(): void;
  close(): Promise<void>;
}

export interface NodesOptions {
  configDir: string;
  /** Where ControlMaster sockets go. */
  controlDir: string;
  store: Pick<StateStore, "setNodes">;
  local?: Host;
  connect?: (node: NodeConfig, onChange: () => void) => NodeConnectionPort;
  stats?: (run: Runner) => Promise<NodeStats | undefined>;
  statsIntervalMs?: number;
  /** A node became online: called once per transition. */
  onOnline?: (id: NodeId) => void;
  /** A node stopped being online, or an online node was removed. */
  onOffline?: (id: NodeId) => void;
}

/** This machine plus the configured ssh nodes: their connections, their stats, and the views the dashboard shows. */
export class Nodes {
  readonly local: Host;
  private readonly connections = new Map<NodeId, NodeConnectionPort>();
  private readonly stats = new Map<NodeId, NodeStats>();
  private readonly wasOnline = new Set<NodeId>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly opts: NodesOptions) {
    this.local = opts.local ?? localHost();
  }

  start(): void {
    for (const node of loadConfig(this.opts.configDir).nodes ?? []) this.open(node);
    this.publish();
    void this.sample();
  }

  list(): NodeView[] {
    const withStats = (view: NodeView): NodeView => {
      const stats = this.stats.get(view.id);
      return stats ? { ...view, stats } : view;
    };
    return [
      withStats({ id: LOCAL_NODE, label: "This machine", state: "online" }),
      ...[...this.connections.values()].map((c) => withStats(c.view())),
    ];
  }

  /** A configured node's connection, online or not. */
  connection(id: NodeId): NodeConnectionPort | undefined {
    return this.connections.get(id);
  }

  /** The local host always; a node's host only while it's online. */
  host(id: NodeId): Host | undefined {
    if (id === LOCAL_NODE) return this.local;
    const conn = this.connections.get(id);
    return conn?.online ? conn.host : undefined;
  }

  async add(input: { ssh?: unknown; label?: unknown }): Promise<NodeView> {
    if (typeof input.ssh !== "string") throw new InvalidNodeError("an ssh destination is required");
    // Re-read so settings saved meanwhile (forges, projects) aren't lost.
    const { config, node } = addNode(loadConfig(this.opts.configDir), {
      ssh: input.ssh,
      ...(typeof input.label === "string" ? { label: input.label } : {}),
    });
    saveConfig(this.opts.configDir, config);
    this.open(node);
    this.publish();
    return this.list().find((n) => n.id === node.id)!;
  }

  async remove(id: NodeId): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) throw new NotFoundError(`no node ${id}`);
    saveConfig(this.opts.configDir, removeNode(loadConfig(this.opts.configDir), id));
    this.connections.delete(id);
    this.stats.delete(id);
    if (this.wasOnline.delete(id)) this.opts.onOffline?.(id);
    await conn.close();
    this.publish();
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.all([...this.connections.values()].map((c) => c.close()));
  }

  private open(node: NodeConfig): void {
    const connect =
      this.opts.connect ??
      ((n: NodeConfig, onChange: () => void) =>
        new NodeConnection({ node: n, controlDir: this.opts.controlDir, onChange }));
    const conn = connect(node, () => this.publish());
    this.connections.set(node.id, conn);
    conn.start();
  }

  private publish(): void {
    if (this.stopped) return;
    for (const [id, conn] of this.connections) {
      if (conn.online && !this.wasOnline.has(id)) {
        this.wasOnline.add(id);
        this.opts.onOnline?.(id);
      } else if (!conn.online && this.wasOnline.delete(id)) {
        this.opts.onOffline?.(id);
      }
    }
    this.opts.store.setNodes(this.list());
  }

  /** Samples local and online nodes, then again `statsIntervalMs` after the round ends. */
  private async sample(): Promise<void> {
    const read = this.opts.stats ?? nodeStats;
    const targets: Array<[NodeId, Host]> = [[LOCAL_NODE, this.local]];
    for (const [id, conn] of this.connections) {
      if (conn.online) targets.push([id, conn.host]);
      else this.stats.delete(id);
    }
    await Promise.all(
      targets.map(async ([id, host]) => {
        const stats = await read(host.run).catch(() => undefined);
        if (stats) this.stats.set(id, stats);
        else this.stats.delete(id);
      }),
    );
    if (this.stopped) return;
    this.publish();
    this.timer = setTimeout(() => void this.sample(), this.opts.statsIntervalMs ?? 10_000);
    this.timer.unref?.();
  }
}
