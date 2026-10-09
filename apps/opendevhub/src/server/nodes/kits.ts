import path from "node:path";

import type { NodeId } from "../../shared/types";
import { Containers } from "../environments/containers";
import { Credentials } from "../environments/credentials";
import { EnvFiles } from "../environments/files";
import { Images } from "../environments/images";
import type { NodeKit, NodeKitsPort } from "../environments/ports";
import { GitOps, hostHeadObjects } from "../git/ops";
import { RelayRuntime } from "../network/relay/runtime";
import { sshRoute } from "../network/routes";
import type { OpencodeClient, OpencodeEndpoint } from "../opencode/client";
import { OpencodeRuntime } from "../opencode/runtime";
import type { Runner } from "./exec";
import type { NodeConnectionPort, Nodes } from "./registry";
import { NodeRepo } from "./repo";

/** One kit per online node, rebuilt when its connection is replaced (the node was removed and added again). */
export class NodeKits implements NodeKitsPort {
  private readonly cache = new Map<
    NodeId,
    { conn: NodeConnectionPort; kit: NodeKit }
  >();

  private readonly opts: {
    nodes: Pick<Nodes, "connection">;
    build: (conn: NodeConnectionPort) => NodeKit;
  };
  constructor(opts: {
    nodes: Pick<Nodes, "connection">;
    build: (conn: NodeConnectionPort) => NodeKit;
  }) {
    this.opts = opts;
  }

  known(node: NodeId): boolean {
    return this.opts.nodes.connection(node) !== undefined;
  }

  kit(node: NodeId): NodeKit | undefined {
    const conn = this.opts.nodes.connection(node);
    if (!conn?.online) {
      return undefined;
    }
    const hit = this.cache.get(node);
    if (hit?.conn === conn) {
      return hit.kit;
    }
    const kit = this.opts.build(conn);
    this.cache.set(node, { conn, kit });
    return kit;
  }
}

/** The orchestrator's per-environment tools, built on a node's ssh host. git on this machine stays local. */
export const buildNodeKit = (
  conn: NodeConnectionPort,
  deps: { clientFor: (ep: OpencodeEndpoint) => OpencodeClient; local: Runner }
): NodeKit => {
  const { host, target } = conn;
  if (!target) {
    throw new Error(`node ${host.id} has no ssh target`);
  }
  const containers = new Containers(host.run);
  return {
    containers,
    runtime: new OpencodeRuntime({ clientFor: deps.clientFor, containers }),
    relay: new RelayRuntime({ containers }),
    images: new Images({
      containers,
      objects: (_p, wt, paths) => hostHeadObjects(host.run, wt.hostPath, paths),
      run: host.run,
    }),
    envFiles: new EnvFiles(
      path.posix.join(host.home, ".opendevhub", "envs"),
      host
    ),
    // Identity and known_hosts are read from this machine's repository and ~/.ssh.
    credentials: new Credentials({ containers, run: deps.local }),
    network: { route: (c) => sshRoute(host, c.ip) },
    git: new GitOps({ containers }),
    repo: new NodeRepo({ host, local: deps.local, node: host.id, target }),
  };
};
