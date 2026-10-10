import { expect, it, vi } from "vitest";

import { envIdFor } from "../../src/server/environments/config";
import type {
  ContainerInfo,
  ExecTarget,
} from "../../src/server/environments/containers";
import type { OpenTarget } from "../../src/server/environments/editors";
import type { MonitorOptions } from "../../src/server/environments/monitor";
import type {
  NetworkPort,
  NodeKit,
  NodeKitsPort,
} from "../../src/server/environments/ports";
import type {
  AddedWorktree,
  AddWorktreeArgs,
} from "../../src/server/git/worktrees";
import { createHub } from "../../src/server/hub";
import type { ForwardTarget } from "../../src/server/network/port-forwarder";
import type { PortSpec } from "../../src/server/network/ports";
import type { AgentTunnelOptions } from "../../src/server/network/relay/agent";
import type { RelayTarget } from "../../src/server/network/relay/client";
import type { RelayStatus } from "../../src/server/network/relay/runtime";
import type {
  Dial,
  HostPort,
  Route,
  RouteContainer,
} from "../../src/server/network/routes";
import type { NodeRepoLayout } from "../../src/server/nodes/repo";
import type {
  NewSession,
  OpencodeEndpoint,
  RawAgent,
  RawCommand,
  RawMessage,
  RawModel,
  RawSession,
} from "../../src/server/opencode/client";
import { OpencodeClient } from "../../src/server/opencode/client";
import { StateStore } from "../../src/server/projects/state";
import type {
  ForwardedPort,
  Worktree,
  WorktreeRoot,
  EnvWorktree,
  PendingItems,
  Project,
  SessionSummary,
  UpdateResult,
} from "../../src/shared/types";
import { memoryStores, seed, worktreeRow } from "./stores";
import type { Seed } from "./stores";

/** A Hub on fakes for the Hub modules' tests: `setup()` builds one, the `with…` helpers bring it to a known state. */
export const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};
export const running: ContainerInfo = {
  id: "c1",
  name: "demo_c1",
  running: true,
  ip: "172.17.0.9",
  projectId: project.id,
  binds: {
    "/workspaces/demo": "/src/demo",
    "/workspaces/demo.worktrees": "/src/demo.worktrees",
  },
};
// Untyped so it is both a Worktree and an EnvWorktree (hostPath is required in the latter).
export const feat = {
  path: "/workspaces/demo.worktrees/feat",
  hostPath: "/src/demo.worktrees/feat",
  branch: "feat",
};
export const featEnv = envIdFor(project.id, feat.path, "feat");
export const runningTask: ContainerInfo = {
  id: "c2",
  name: "demo_feat",
  running: true,
  ip: "172.17.0.10",
  envId: featEnv,
  envProjectId: project.id,
  image: "vsc-feat-1234-uid",
  binds: {},
};

export const remoteFix = {
  path: "/workspaces/demo.worktrees/fix",
  hostPath: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees/fix",
  branch: "fix",
};
export const remoteEnv = envIdFor(project.id, `box:${remoteFix.path}`, "fix");

/** Fakes for node "box", shaped like setup()'s; `online.box` turns it off. */
export function boxKit() {
  const layout = (p: Project, ws: string): NodeRepoLayout => ({
    repo: `/home/tim/.opendevhub/repos/${p.id}/demo`,
    gitDir: `/home/tim/.opendevhub/repos/${p.id}/demo/.git`,
    worktrees: `/home/tim/.opendevhub/repos/${p.id}/demo.worktrees`,
    url: `ssh://tim@box/home/tim/.opendevhub/repos/${p.id}/demo`,
    workspaceFolder: ws,
  });
  const routes: (Route & { close: ReturnType<typeof vi.fn> })[] = [];
  const info: ContainerInfo = {
    id: "r1",
    name: "demo_fix",
    running: true,
    ip: "172.18.0.4",
    envId: remoteEnv,
    envProjectId: project.id,
    image: "vsc-fix-1234-uid",
    binds: {},
  };
  const kit = {
    containers: {
      workspaceFolder: vi.fn(
        async (_t?: ExecTarget): Promise<string | undefined> => undefined
      ),
      listManaged: vi.fn(async (): Promise<ContainerInfo[]> => []),
      up: vi.fn(
        async (
          _t: ExecTarget,
          _o: { rebuild: boolean; onLine: (l: string) => void }
        ) => ({
          containerId: "r1",
          remoteWorkspaceFolder: remoteFix.path,
          remoteUser: "node",
        })
      ),
      inspect: vi.fn(
        async (_id?: string): Promise<ContainerInfo | undefined> => info
      ),
      stop: vi.fn(async (_id: string) => {}),
      readConfiguration: vi.fn(async (_t?: ExecTarget) => ({
        forwardPorts: [] as unknown[],
        portsAttributes: {} as Record<string, unknown>,
      })),
      readConfig: vi.fn(async (_f: string) => ({
        configuration: { image: "node:22" } as Record<string, unknown>,
        workspaceFolder: "/workspaces/fix" as string | undefined,
      })),
      remove: vi.fn(async (_id: string) => {}),
      removeImage: vi.fn(async (_ref: string) => true),
      ensureVolume: vi.fn(async (_name: string, _labels?: string[]) => true),
      removeVolume: vi.fn(async (_name: string) => true),
    },
    runtime: {
      endpoint: (a: HostPort, password: string) => ({
        baseUrl: `http://${a.host}:${a.port}`,
        password,
      }),
      ensureRunning: vi.fn(
        async (_t: ExecTarget, _a: { password?: string }) => ({
          password: "pw-box",
          version: "2.0.20",
        })
      ),
      stopServer: vi.fn(async () => {}),
      isHealthy: vi.fn(async () => true),
      resolveBinary: vi.fn(
        async (_t?: ExecTarget): Promise<string | undefined> =>
          "/usr/local/bin/opencode"
      ),
    },
    relay: {
      ensureRunning: vi.fn(
        async (
          _t: ExecTarget,
          _a: { address: HostPort; token: string }
        ): Promise<RelayStatus> => ({ status: "active", via: "bun" })
      ),
      stop: vi.fn(async (_t?: ExecTarget) => {}),
    },
    images: {
      ensureBase: vi.fn(
        async (
          p: Project,
          _w: EnvWorktree,
          _k: string[],
          _l: (l: string) => void
        ) => ({
          key: "b".repeat(64),
          ref: `opendevhub/${p.id}:bbbbbbbbbbbb-base`,
        })
      ),
    },
    envFiles: {
      path: (id: string) =>
        `/home/tim/.opendevhub/envs/${id}/devcontainer.json`,
      write: vi.fn(
        async (id: string, _c: Record<string, unknown>) =>
          `/home/tim/.opendevhub/envs/${id}/devcontainer.json`
      ),
      remove: vi.fn(async (_id: string) => {}),
    },
    credentials: {
      prepare: vi.fn(
        async (
          _t: ExecTarget,
          _path: string,
          _o: { sshAgent: boolean; onLine: (l: string) => void }
        ) => {}
      ),
    },
    network: {
      route: vi.fn(
        async (
          _c: RouteContainer,
          _onLog: (l: string) => void
        ): Promise<Route> => {
          const r = {
            kind: "ssh" as const,
            opencode: { host: "127.0.0.1", port: 41_001 },
            relay: { host: "127.0.0.1", port: 41_002 },
            dial: vi.fn() as unknown as Dial,
            close: vi.fn(async () => {}),
          };
          routes.push(r);
          return r;
        }
      ),
    },
    git: {
      currentBranch: vi.fn(
        async (_t: ExecTarget, _dir: string): Promise<string | undefined> =>
          "fix"
      ),
      recordedBase: vi.fn(
        async (
          _t: ExecTarget,
          _dir: string,
          _b: string
        ): Promise<string | undefined> => "main"
      ),
      aheadBehind: vi.fn(
        async (_t: ExecTarget, _dir: string, _base: string) => ({
          ahead: 3,
          behind: 0,
        })
      ),
      isClean: vi.fn(async (_t: ExecTarget, _dir: string) => true),
      isPushed: vi.fn(async (_t: ExecTarget, _dir: string) => false),
      commit: vi.fn(async (_t: ExecTarget, _dir: string, _m: string) => {}),
      update: vi.fn(
        async (
          _t: ExecTarget,
          _dir: string,
          _base: string,
          strategy: "rebase" | "merge"
        ): Promise<UpdateResult> => ({ strategy })
      ),
    },
    repo: {
      layout: vi.fn(layout),
      ensure: vi.fn(async (_l: NodeRepoLayout) => {}),
      branches: vi.fn(async (_l: NodeRepoLayout): Promise<string[]> => []),
      pushBase: vi.fn(
        async (_p: Project, _l: NodeRepoLayout, _base: string) => {}
      ),
      addWorktree: vi.fn(
        async (
          l: NodeRepoLayout,
          branch: string,
          _base: string
        ): Promise<EnvWorktree> => ({
          path: `${l.workspaceFolder}.worktrees/${branch.replaceAll("/", "-")}`,
          hostPath: `${l.worktrees}/${branch.replaceAll("/", "-")}`,
          branch,
        })
      ),
      removeWorktree: vi.fn(async (_l: NodeRepoLayout, _w: EnvWorktree) => {}),
      bringHome: vi.fn(
        async (_p: Project, _l: NodeRepoLayout, _b: string) => {}
      ),
    },
  };
  const online = { box: true };
  const nodes: NodeKitsPort = {
    known: (n) => n === "box",
    kit: (n) =>
      n === "box" && online.box ? (kit as unknown as NodeKit) : undefined,
  };
  return { kit, nodes, online, routes, layout, info };
}

export function setup(
  persisted: Seed = {},
  network?: NetworkPort,
  projects = [project],
  nodes?: NodeKitsPort
) {
  const clock = { now: 1_000_000 };
  const dbs = memoryStores(() => clock.now);
  // Discovery registers projects before anything refers to them; most tests start from there.
  dbs.projects.upsertAll(projects);
  seed(dbs, persisted);
  const store = new StateStore({
    port: 7777,
    environments: dbs.environments,
    tasks: dbs.tasks,
    checkouts: dbs.checkouts,
    links: dbs.links,
  });
  const monitors: {
    opts: MonitorOptions;
    started: boolean;
    stopped: boolean;
    reconciled: number;
  }[] = [];
  const containers = {
    exec: vi.fn(
      async (
        _t: ExecTarget,
        _command: string[]
      ): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }> => ({ exitCode: 0, stderr: "", stdout: "", timedOut: false })
    ),
    workspaceFolder: vi.fn(
      async (_p?: ExecTarget): Promise<string | undefined> => "/workspaces/demo"
    ),
    listManaged: vi.fn(async (): Promise<ContainerInfo[]> => []),
    up: vi.fn(
      async (
        t: ExecTarget,
        o: { rebuild: boolean; onLine: (l: string) => void; mounts?: string[] }
      ): Promise<{
        containerId: string;
        remoteWorkspaceFolder: string;
        remoteUser?: string;
      }> => {
        o.onLine("building image");
        if (t.idLabels) {
          return {
            containerId: "c2",
            remoteWorkspaceFolder: feat.path,
            remoteUser: "node",
          };
        }
        return {
          containerId: "c1",
          remoteWorkspaceFolder: "/workspaces/demo",
          remoteUser: "node",
        };
      }
    ),
    inspect: vi.fn(async (id?: string): Promise<ContainerInfo | undefined> =>
      id === "c2" ? runningTask : running
    ),
    stop: vi.fn(async (_id: string) => {}),
    readConfiguration: vi.fn(async (_t?: ExecTarget) => ({
      forwardPorts: [3000, "db:5432"] as unknown[],
      portsAttributes: { "3000": { label: "web" } } as Record<string, unknown>,
      configuration: undefined as Record<string, unknown> | undefined,
    })),
    readConfig: vi.fn(async (_folder: string) => ({
      configuration: {
        image: "node:22",
        postCreateCommand: "npm ci",
        forwardPorts: [3000],
      } as Record<string, unknown>,
      workspaceFolder: "/workspaces/feat" as string | undefined,
    })),
    remove: vi.fn(async (_id: string) => {}),
    removeImage: vi.fn(async (_ref: string) => true),
    ensureVolume: vi.fn(async (_name: string, _labels?: string[]) => true),
    removeVolume: vi.fn(async (_name: string) => true),
  };
  const runtime = {
    endpoint: (a: HostPort, password: string) => ({
      baseUrl: `http://${a.host}:${a.port}`,
      password,
    }),
    ensureRunning: vi.fn(
      async (
        _p: ExecTarget,
        _a: { password?: string; env?: Record<string, string> }
      ) => ({ password: "pw", version: "2.0.20" })
    ),
    stopServer: vi.fn(async () => {}),
    isHealthy: vi.fn(async () => true),
    resolveBinary: vi.fn(
      async (_p?: ExecTarget): Promise<string | undefined> =>
        "/usr/local/bin/opencode"
    ),
  };
  const forwarder = {
    open: vi.fn(
      async (
        _id: string,
        _target: ForwardTarget,
        ports: PortSpec[],
        _onLog?: (l: string) => void,
        _events?: { onRelayUnreachable?: () => void }
      ) =>
        ports.map((p): ForwardedPort => ({
          status: "forwarded",
          containerPort: p.containerPort,
          label: p.label,
          hostPort: p.containerPort,
        }))
    ),
    close: vi.fn(async (_id: string) => {}),
    closeAll: vi.fn(async () => {}),
  };
  const relay = {
    ensureRunning: vi.fn(
      async (
        _p: ExecTarget,
        _a: { address: HostPort; token: string; binary?: string }
      ): Promise<RelayStatus> => ({
        status: "active",
        via: "bun",
      })
    ),
    stop: vi.fn(async (_p?: ExecTarget) => {}),
  };
  const worktrees = {
    list: vi.fn(
      async (
        _p: Project,
        _ws: string,
        _root?: WorktreeRoot
      ): Promise<Worktree[]> => []
    ),
    add: vi.fn(
      async (_p: Project, a: AddWorktreeArgs): Promise<AddedWorktree> => ({
        path: `${a.root.container}/${a.branch.replaceAll("/", "-")}`,
        hostPath: `${a.root.host}/${a.branch.replaceAll("/", "-")}`,
        branch: a.branch,
      })
    ),
    remove: vi.fn(
      async (_p: Project, _ws: string, _path: string, _force: boolean) => {}
    ),
  };
  const editors = { open: vi.fn(async (_id: string, _t: OpenTarget) => {}) };
  const git = {
    currentBranch: vi.fn(
      async (_p: Project, dir: string): Promise<string | undefined> =>
        dir === "/workspaces/demo" ? "main" : "x"
    ),
    recordedBase: vi.fn(
      async (
        _p: Project,
        _dir: string,
        _b: string
      ): Promise<string | undefined> => "main"
    ),
    aheadBehind: vi.fn(async (_p: Project, _dir: string, _base: string) => ({
      ahead: 2,
      behind: 1,
    })),
    isClean: vi.fn(async (_p: Project, _dir: string) => true),
    isPushed: vi.fn(async (_p: Project, _dir: string) => false),
    commit: vi.fn(async (_p: Project, _dir: string, _m: string) => {}),
    update: vi.fn(
      async (
        _p: Project,
        _dir: string,
        _base: string,
        strategy: "rebase" | "merge"
      ): Promise<UpdateResult> => ({ strategy })
    ),
    mergeInto: vi.fn(
      async (_p: Project, _ws: string, _b: string, _ff: boolean) => {}
    ),
    deleteBranch: vi.fn(
      async (_p: Project, _ws: string, _b: string, _force?: boolean) => {}
    ),
    localBranches: vi.fn(
      async (_p: Project, _dir: string): Promise<string[]> => ["main"]
    ),
    remotes: vi.fn(async (_p: Project, _dir: string): Promise<string[]> => [
      "origin",
    ]),
    fetchPull: vi.fn(async () => "a".repeat(40)),
    fetchPrune: vi.fn(async (_p: Project, _dir: string, _remote: string) => {}),
    branchRefs: vi.fn(
      async (
        _p: Project,
        _dir: string
      ): Promise<{ name: string; upstream?: string; gone: boolean }[]> => []
    ),
    remoteHead: vi.fn(
      async (
        _p: Project,
        _dir: string,
        _remote: string
      ): Promise<string | undefined> => "main"
    ),
    isAncestor: vi.fn(
      async (_p: Project, _dir: string, _b: string, _base: string) => true
    ),
    mergeBase: vi.fn(
      async (
        _p: Project,
        _dir: string,
        _base: string
      ): Promise<string | undefined> => "c0ffee"
    ),
    fileBytes: vi.fn(
      async (
        _p: Project,
        _dir: string,
        file: string,
        _o: { rev?: string; maxBytes: number }
      ): Promise<Buffer | undefined> => Buffer.from(file)
    ),
  };
  // Each session gets its own id, as in opencode: a session belongs to one task variant only.
  let created = 0;
  const client = {
    createSession: vi.fn(async (directory: string, _o?: NewSession) => {
      created += 1;
      return {
        id: created === 1 ? "ses_new" : `ses_new_${created}`,
        location: { directory },
      };
    }),
    models: vi.fn(async (_dir: string): Promise<RawModel[]> => [
      { id: "m1", providerID: "p", name: "M1", enabled: true, variants: [] },
    ]),
    defaultModel: vi.fn(
      async (_dir: string): Promise<RawModel | undefined> => ({
        id: "m1",
        providerID: "p",
        name: "M1",
      })
    ),
    agents: vi.fn(async (_dir: string): Promise<RawAgent[]> => [
      { id: "build", name: "Build", mode: "primary" },
    ]),
    commands: vi.fn(async (_dir: string): Promise<RawCommand[]> => []),
    command: vi.fn(
      async (_sid: string, _name: string, _text: string, _dir?: string) => {}
    ),
    session: vi.fn(async (id: string): Promise<RawSession> => ({
      id,
      time: { created: 1, updated: 1 },
      location: { directory: "/workspaces/demo" },
    })),
    updateSession: vi.fn(
      async (
        _id: string,
        _patch: { metadata?: Record<string, unknown> },
        _dir?: string
      ) => {}
    ),
    replyPermission: vi.fn(
      async (_sid: string, _rid: string, _reply: unknown, _dir?: string) => {}
    ),
    replyForm: vi.fn(
      async (_sid: string, _fid: string, _answer: unknown, _dir?: string) => {}
    ),
    cancelForm: vi.fn(async (_sid: string, _fid: string, _dir?: string) => {}),
    vcsInfo: vi.fn(
      async (_dir: string) =>
        ({ current: "x", default: "main" }) as {
          current?: string;
          default?: string;
        }
    ),
    vcsBase: vi.fn(
      async (_dir: string): Promise<string | undefined> => undefined
    ),
    vcsStatus: vi.fn(async (_dir: string) => [] as { file: string }[]),
    vcsDiff: vi.fn(async (_dir: string, _mode: string, _base?: string) => [
      {
        file: "a.ts",
        patch: "@@ -1 +1 @@\n-a\n+b\n",
        additions: 1,
        deletions: 1,
        status: "modified" as const,
      },
      {
        file: "b.ts",
        patch: "@@ -0,0 +1 @@\n+c\n",
        additions: 1,
        deletions: 0,
        status: "added" as const,
      },
    ]),
    userMessages: vi.fn(async (_sid: string, _limit: number) => [
      { id: "msg_2", text: "Now add tests", time: { created: 2 } },
      { id: "msg_1", text: "Fix the login\nplease", time: { created: 1 } },
    ]),
    sessionDiff: vi.fn(
      async (
        _sid: string,
        _opts: { from?: string; to?: string },
        _dir?: string
      ) => [
        {
          file: "c.ts",
          patch: "@@ -1 +1 @@\n-x\n+y\n",
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
      ]
    ),
    prompt: vi.fn(
      async (
        _sid: string,
        _text: string,
        _delivery?: string,
        _dir?: string
      ) => {}
    ),
    generate: vi.fn(
      async (_sid: string, _prompt: string, _dir?: string, _timeout?: number) =>
        "feat: do things"
    ),
    interrupt: vi.fn(async (_sid: string, _dir?: string) => {}),
    sessions: vi.fn(async (): Promise<RawSession[]> => []),
    messages: vi.fn(
      async (_sid: string, _limit: number): Promise<RawMessage[]> => []
    ),
    active: vi.fn(async () => new Set<string>()),
    deleteSession: vi.fn(async (_id: string, _dir?: string) => {}),
  };
  const publisher = {
    info: vi.fn(
      async (
        _p: Project,
        _c: { container: string; host?: string },
        branch: string | undefined,
        _remote?: string
      ) => ({
        ...(branch ? { branch } : {}),
        remotes: ["origin"],
        remote: "origin",
        forge: { kind: "github" as const, webBase: "https://github.com/a/b" },
        strategies: ["branch" as const],
        strategy: "branch" as const,
        pushFrom: "host" as const,
      })
    ),
    publish: vi.fn(
      async (
        _p: Project,
        _c: { container: string; host?: string },
        _branch: string,
        req: { strategy: "branch" | "agit" }
      ) => ({
        strategy: req.strategy,
        pushedFrom: "host" as const,
        openUrl: "https://github.com/a/b/compare/main...x",
        output: [],
      })
    ),
  };

  const images = {
    ensureBase: vi.fn(
      async (
        p: Project,
        _w: EnvWorktree,
        _keyFiles: string[],
        _onLine: (l: string) => void
      ) => ({
        key: "k".repeat(64),
        ref: `opendevhub/${p.id}:kkkkkkkkkkkk-base`,
      })
    ),
  };
  const envFiles = {
    path: (id: string) => `/state/envs/${id}/devcontainer.json`,
    write: vi.fn(
      async (id: string, _config: Record<string, unknown>) =>
        `/state/envs/${id}/devcontainer.json`
    ),
    remove: vi.fn(async (_id: string) => {}),
  };
  const projectSettings = vi.fn((_p: Project): unknown => undefined);
  const mkdir = vi.fn(async (_dir: string) => {});
  const clientFor = vi.fn(
    (_ep: OpencodeEndpoint) => client as unknown as OpencodeClient
  );
  const delay = vi.fn(async (_ms: number) => {});
  const credentials = {
    prepare: vi.fn(
      async (
        _t: ExecTarget,
        _path: string,
        _o: { sshAgent: boolean; onLine: (l: string) => void }
      ) => {}
    ),
  };
  const tunnels: {
    target: RelayTarget;
    opts: AgentTunnelOptions;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const agentTunnel = vi.fn((target: RelayTarget, opts: AgentTunnelOptions) => {
    const t = { target, opts, start: vi.fn(), stop: vi.fn() };
    tunnels.push(t);
    return t;
  });
  const recordUsage = vi.fn();
  const hub = createHub({
    store,
    projects: dbs.projects,
    tasks: dbs.tasks,
    checkouts: dbs.checkouts,
    links: dbs.links,
    containers,
    runtime,
    forwarder,
    relay,
    network,
    nodes,
    worktrees,
    git,
    publisher,
    editors,
    mkdir,
    clientFor,
    now: () => clock.now,
    delay,
    images,
    envFiles,
    projectSettings,
    credentials,
    agentTunnel,
    recordUsage,
    roots: () => ["/src"],
    scan: async () => projects,
    monitorFactory: (opts) => {
      const m = {
        opts,
        started: false,
        stopped: false,
        reconciled: 0,
        start() {
          m.started = true;
        },
        stop() {
          m.stopped = true;
        },
        reconcile() {
          m.reconciled++;
        },
      };
      monitors.push(m);
      return m;
    },
  });
  return {
    store,
    dbs,
    environments: dbs.environments,
    tasks: dbs.tasks,
    checkouts: dbs.checkouts,
    links: dbs.links,
    projects: dbs.projects,
    db: dbs.db,
    containers,
    runtime,
    hub,
    monitors,
    forwarder,
    relay,
    worktrees,
    editors,
    client,
    clientFor,
    mkdir,
    git,
    publisher,
    clock,
    delay,
    images,
    envFiles,
    projectSettings,
    credentials,
    agentTunnel,
    tunnels,
    recordUsage,
  };
}

/** A started project with a remote environment for `fix` on box recorded (not started). */
export async function withRemote() {
  const box = boxKit();
  const s = setup(undefined, undefined, undefined, box.nodes);
  await s.hub.environments.rescan();
  await s.hub.environments.start(project.id);
  s.store.putEnvironment({
    id: remoteEnv,
    projectId: project.id,
    worktree: remoteFix,
    worktreeId: worktreeRow(s.dbs, project.id, remoteFix, "box"),
    node: "box",
  });
  return { ...s, box };
}

/** …and started. */
export async function withRemoteRunning() {
  const s = await withRemote();
  await s.hub.environments.startEnv(project.id, remoteEnv);
  return s;
}

/** A started project whose worktree list has `feat`. */
export async function withWorktree(persisted?: Seed) {
  const s = setup(persisted);
  s.worktrees.list.mockResolvedValue([feat]);
  await s.hub.environments.rescan();
  await s.hub.environments.start(project.id);
  return s;
}

/** …and `feat` running in its own container. */
export async function withEnv() {
  const s = await withWorktree();
  const { envId } = await s.hub.environments.createEnv(project.id, feat.path);
  await vi.waitFor(() =>
    expect(s.store.runtime(envId).opencode).toBe("healthy")
  );
  return { ...s, envId };
}

export function waiting(pending: PendingItems): SessionSummary {
  return {
    id: "ses_root",
    projectId: project.id,
    title: "Fix tests",
    directory: "/workspaces/demo.worktrees/x",
    updatedAt: 1,
    status: "needs-permission",
    pending,
  };
}
export const permission = {
  id: "per_1",
  sessionId: "ses_child",
  action: "bash",
  resources: ["npm test"],
};
export const form = {
  id: "frm_1",
  sessionId: "ses_root",
  title: "Which DB?",
  fields: [],
};
