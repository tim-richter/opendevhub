import type { NodeId, Project, ProjectId } from "../../shared/types";
import type { ProjectStore } from "../db/projects";
import type { TaskStore } from "../db/tasks";
import { UnavailableError } from "../errors";
import type { GitOps } from "../git/ops";
import type { Publisher } from "../git/publish";
import type { Worktrees } from "../git/worktrees";
import type { PortForwarder } from "../network/port-forwarder";
import type { AgentTunnelOptions } from "../network/relay/agent";
import type { RelayTarget } from "../network/relay/client";
import type { RelayRuntime } from "../network/relay/runtime";
import { directRoute } from "../network/routes";
import type { Network, RouteContainer } from "../network/routes";
import type { NodeRepoPort } from "../nodes/repo";
import type {
  OpencodeClient,
  OpencodeEndpoint,
  RawSession,
} from "../opencode/client";
import type { OpencodeRuntime } from "../opencode/runtime";
import type { StateStore } from "../projects/state";
import type { Containers } from "./containers";
import type { Credentials } from "./credentials";
import type { EditorLauncher } from "./editors";
import type { EnvFiles } from "./files";
import type { Images } from "./images";
import type { MonitorOptions } from "./monitor";

export type ContainersPort = Pick<
  Containers,
  | "up"
  | "inspect"
  | "listManaged"
  | "stop"
  | "readConfiguration"
  | "workspaceFolder"
  | "readConfig"
  | "remove"
  | "removeImage"
  | "ensureVolume"
  | "removeVolume"
> &
  Partial<Pick<Containers, "remoteEnv" | "exec">>;
export type ImagesPort = Pick<Images, "ensureBase">;
export type EnvFilesPort = Pick<EnvFiles, "path" | "write" | "remove">;
export type GitPort = Pick<
  GitOps,
  | "currentBranch"
  | "recordedBase"
  | "aheadBehind"
  | "isClean"
  | "isPushed"
  | "commit"
  | "update"
  | "mergeInto"
  | "deleteBranch"
  | "fetchPull"
  | "localBranches"
  | "remotes"
  | "fetchPrune"
  | "branchRefs"
  | "remoteHead"
  | "isAncestor"
  | "mergeBase"
  | "fileBytes"
>;
export type WorktreesPort = Pick<Worktrees, "list" | "add" | "remove">;
export type EditorsPort = Pick<EditorLauncher, "open">;
export type ForwarderPort = Pick<PortForwarder, "open" | "close" | "closeAll">;
export type RuntimePort = Pick<
  OpencodeRuntime,
  "ensureRunning" | "stopServer" | "isHealthy" | "endpoint" | "resolveBinary"
>;
export type RelayPort = Pick<RelayRuntime, "ensureRunning" | "stop">;
export type NetworkPort = Pick<Network, "route">;
export interface MonitorHandle {
  start: () => void;
  stop: () => void;
  reconcile?: () => unknown;
}

export type PublisherPort = Pick<Publisher, "info" | "publish">;
export type CredentialsPort = Pick<Credentials, "prepare">;
export interface AgentTunnelHandle {
  start: () => void;
  stop: () => void;
}
export type AgentTunnelFactory = (
  target: RelayTarget,
  opts: AgentTunnelOptions
) => AgentTunnelHandle;

/** Everything that acts on one node's Docker and files; the local node's come from the deps below. */
export interface NodeKit {
  containers: ContainersPort;
  runtime: RuntimePort;
  relay: RelayPort;
  images: ImagesPort;
  envFiles: EnvFilesPort;
  credentials?: CredentialsPort;
  network: NetworkPort;
  git: GitPort;
  repo: NodeRepoPort;
}

/** The other nodes: a kit while a node is online. */
export interface NodeKitsPort {
  known: (node: NodeId) => boolean;
  kit: (node: NodeId) => NodeKit | undefined;
}

/** The local node's kit: the deps as they are, where images and a repo may be missing. */
export type Kit = Omit<NodeKit, "images" | "repo"> & {
  images?: ImagesPort;
  repo?: NodeRepoPort;
};

/** The repo port of a kit that has one (the local kit has none on some setups). */
export const repoOf = (kit: Kit): NodeRepoPort => {
  if (!kit.repo) {
    throw new UnavailableError("this node has no repository access");
  }
  return kit.repo;
};

export const DIRECT: NetworkPort = {
  route: (c: RouteContainer) => Promise.resolve(directRoute(c.ip)),
};

/** What the Hub's modules act through; tests pass fakes. */
export interface HubDeps {
  store: StateStore;
  /** The project registry; discovery upserts it. */
  projects: ProjectStore;
  /** Tasks and their variants, the only record of which session belongs to which task. */
  tasks: TaskStore;
  containers: ContainersPort;
  runtime: RuntimePort;
  forwarder: ForwarderPort;
  relay: RelayPort;
  worktrees: WorktreesPort;
  publisher: PublisherPort;
  git: GitPort;
  editors: EditorsPort;
  /** Creates the host worktrees folder before `up` mounts it (defaults to a recursive mkdir). */
  mkdir?: (dir: string) => Promise<void>;
  /** Defaults to connecting to container IPs directly. */
  network?: NetworkPort;
  clientFor: (ep: OpencodeEndpoint) => OpencodeClient;
  roots: () => string[];
  scan: (roots: string[]) => Promise<Project[]>;
  monitorFactory?: (opts: MonitorOptions) => MonitorHandle;
  /** Clock for task ids and the models cache; tests pass their own. */
  now?: () => number;
  /** Waits between retries; tests pass their own. */
  delay?: (ms: number) => Promise<void>;
  /** Base images for task environments. */
  images?: ImagesPort;
  /** Where task environments' generated configs live; defaults to the state folder. */
  envFiles?: EnvFilesPort;
  /** The project's entry in config.json `projects`. */
  projectSettings?: (project: Project) => unknown;
  /** Git identity, known_hosts and git's ssh command in containers; skipped when absent. */
  credentials?: CredentialsPort;
  /** Books what each poll's sessions spent; skipped when absent (no usage ledger). */
  recordUsage?: (projectId: ProjectId, sessions: RawSession[]) => void;
  /** Defaults to a real AgentTunnel; tests pass their own. */
  agentTunnel?: AgentTunnelFactory;
  /** Other nodes' kits; absent when nodes aren't wired (and then every environment is local). */
  nodes?: NodeKitsPort;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
