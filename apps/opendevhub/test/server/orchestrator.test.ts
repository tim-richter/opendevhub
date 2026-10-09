import { describe, expect, it, vi } from "vitest";

import type { PersistedState } from "../../src/server/config";
import { CommandError, envLabels } from "../../src/server/containers";
import type { ContainerInfo, ExecTarget } from "../../src/server/containers";
import type { OpenTarget } from "../../src/server/editors";
import { envIdFor } from "../../src/server/env-config";
import type { MonitorOptions } from "../../src/server/monitor";
import type {
  Dial,
  HostPort,
  Route,
  RouteContainer,
} from "../../src/server/network";
import type { NodeRepoLayout } from "../../src/server/node-repo";
import type {
  NewSession,
  OpencodeEndpoint,
  RawAgent,
  RawMessage,
  RawModel,
  RawSession,
} from "../../src/server/opencode/client";
import {
  OpencodeClient,
  OpencodeHttpError,
} from "../../src/server/opencode/client";
import {
  AlreadyAnsweredError,
  BusyError,
  NotFoundError,
  Orchestrator,
  UnavailableError,
} from "../../src/server/orchestrator";
import type {
  NetworkPort,
  NodeKit,
  NodeKitsPort,
} from "../../src/server/orchestrator";
import type { ForwardTarget } from "../../src/server/port-forwarder";
import type { PortSpec } from "../../src/server/ports";
import type { AgentTunnelOptions } from "../../src/server/relay/agent";
import type { RelayTarget } from "../../src/server/relay/client";
import type { RelayStatus } from "../../src/server/relay/runtime";
import { StateStore } from "../../src/server/state";
import { parseTaskMeta } from "../../src/server/tasks";
import { InvalidRequestError } from "../../src/server/worktrees";
import type { AddWorktreeArgs } from "../../src/server/worktrees";
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
import { rawSession, startFakeOpencode } from "../helpers/fake-opencode";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};
const running: ContainerInfo = {
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
const feat = {
  path: "/workspaces/demo.worktrees/feat",
  hostPath: "/src/demo.worktrees/feat",
  branch: "feat",
};
const featEnv = envIdFor(project.id, feat.path, "feat");
const runningTask: ContainerInfo = {
  id: "c2",
  name: "demo_feat",
  running: true,
  ip: "172.17.0.10",
  envId: featEnv,
  envProjectId: project.id,
  image: "vsc-feat-1234-uid",
  binds: {},
};

const remoteFix = {
  path: "/workspaces/demo.worktrees/fix",
  hostPath: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees/fix",
  branch: "fix",
};
const remoteEnv = envIdFor(project.id, `box:${remoteFix.path}`, "fix");

/** Fakes for node "box", shaped like setup()'s; `online.box` turns it off. */
function boxKit() {
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
      isPushed: vi.fn(
        async (_t: ExecTarget, _dir: string, _b: string) => false
      ),
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

function setup(
  persisted: PersistedState = { projects: {} },
  network?: NetworkPort,
  projects = [project],
  nodes?: NodeKitsPort
) {
  const store = new StateStore({ port: 7777, persisted, persist: () => {} });
  const monitors: {
    opts: MonitorOptions;
    started: boolean;
    stopped: boolean;
    reconciled: number;
  }[] = [];
  const containers = {
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
    add: vi.fn(async (_p: Project, a: AddWorktreeArgs): Promise<Worktree> => ({
      path: `${a.root.container}/${a.branch.replaceAll("/", "-")}`,
      hostPath: `${a.root.host}/${a.branch.replaceAll("/", "-")}`,
      branch: a.branch,
    })),
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
    isPushed: vi.fn(async (_p: Project, _dir: string, _b: string) => false),
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
  };
  const client = {
    createSession: vi.fn(async (directory: string, _o?: NewSession) => ({
      id: "ses_new",
      location: { directory },
    })),
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
  const clock = { now: 1_000_000 };
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
  const orch = new Orchestrator({
    store,
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
    containers,
    runtime,
    orch,
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
async function withRemote() {
  const box = boxKit();
  const s = setup(undefined, undefined, undefined, box.nodes);
  await s.orch.rescan();
  await s.orch.start(project.id);
  s.store.putEnvironment({
    id: remoteEnv,
    projectId: project.id,
    worktree: remoteFix,
    node: "box",
  });
  return { ...s, box };
}

/** …and started. */
async function withRemoteRunning() {
  const s = await withRemote();
  await s.orch.startEnv(project.id, remoteEnv);
  return s;
}

/** A started project whose worktree list has `feat`. */
async function withWorktree(persisted?: PersistedState) {
  const s = setup(persisted);
  s.worktrees.list.mockResolvedValue([feat]);
  await s.orch.rescan();
  await s.orch.start(project.id);
  return s;
}

/** …and `feat` running in its own container. */
async function withEnv() {
  const s = await withWorktree();
  const { envId } = await s.orch.createEnv(project.id, feat.path);
  await vi.waitFor(() =>
    expect(s.store.runtime(envId).opencode).toBe("healthy")
  );
  return { ...s, envId };
}

function waiting(pending: PendingItems): SessionSummary {
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
const permission = {
  id: "per_1",
  sessionId: "ses_child",
  action: "bash",
  resources: ["npm test"],
};
const form = {
  id: "frm_1",
  sessionId: "ses_root",
  title: "Which DB?",
  fields: [],
};

describe(Orchestrator, () => {
  it("routes terminals to shared, isolated and remote containers and rejects unknown or stopped checkouts", async () => {
    const shared = await withWorktree();
    await expect(
      shared.orch.terminalTarget(project.id, feat.path)
    ).resolves.toMatchObject({ containerId: "c1" });
    await expect(
      shared.orch.terminalTarget(project.id, "/unknown")
    ).rejects.toThrow(/neither the workspace nor a known worktree/u);
    shared.store.updateRuntime(project.id, { containerState: "stopped" });
    await expect(
      shared.orch.terminalTarget(project.id, feat.path)
    ).rejects.toThrow(/Start this checkout/u);
    const isolated = await withEnv();
    await expect(
      isolated.orch.terminalTarget(project.id, feat.path)
    ).resolves.toMatchObject({ containerId: "c2" });
    const remote = await withRemoteRunning();
    await expect(
      remote.orch.terminalTarget(project.id, remoteFix.path)
    ).resolves.toMatchObject({ containerId: "r1", node: "box", user: "node" });
  });

  it("runs the main container as the project's main environment", async () => {
    const { orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    expect(monitors[0].opts).toMatchObject({
      projectId: project.id,
      envId: project.id,
      directory: "/workspaces/demo",
    });
  });

  it("start brings up the container, launches opencode and starts a monitor", async () => {
    const { store, containers, runtime, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBeFalsy();
    expect(runtime.ensureRunning.mock.calls[0][1]).toMatchObject({
      address: { host: "172.17.0.9", port: 4096 },
      containerId: "c1",
      workspaceFolder: "/workspaces/demo",
    });
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "c1",
      password: "pw",
      opencodeVersion: "2.0.20",
      error: undefined,
    });
    expect(monitors[0]).toMatchObject({ started: true });
    expect(monitors[0].opts.directory).toBe("/workspaces/demo");
    expect(orch.logLines(project.id)).toContain("building image");
  });

  it("keeps opencode's sessions on a labelled volume that survives a rebuild", async () => {
    const { containers, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.rebuild(project.id);
    const volume = `opendevhub-opencode-${project.id}`;
    expect(containers.ensureVolume).toHaveBeenCalledWith(volume, [
      "opendevhub.volume=opencode",
      `opendevhub.project=${project.id}`,
    ]);
    expect(containers.up.mock.calls[1][1]).toMatchObject({ rebuild: true });
    expect(containers.up.mock.calls[1][1].mounts).toContain(
      `type=volume,source=${volume},target=/opendevhub/opencode`
    );
    expect(containers.removeVolume).not.toHaveBeenCalled();
  });

  it("rebuilds without cache when asked", async () => {
    const { containers, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.rebuild(project.id, true);
    expect(containers.up.mock.calls[0][1]).toMatchObject({ noCache: false });
    expect(containers.up.mock.calls[1][1]).toMatchObject({
      noCache: true,
      rebuild: true,
    });
  });

  it("throws synchronously for unknown projects and concurrent actions", async () => {
    const { orch } = setup();
    await orch.rescan();
    expect(() => orch.start("nope")).toThrow(NotFoundError);
    const first = orch.start(project.id);
    expect(() => orch.stop(project.id)).toThrow(BusyError);
    await first;
    await expect(orch.stop(project.id)).resolves.toBeUndefined();
  });

  it("records devcontainer failures as error state with log tail", async () => {
    const { store, containers, orch } = setup();
    containers.up.mockRejectedValueOnce(
      new CommandError("devcontainer up failed: boom", ["tail line"])
    );
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "error",
      error: "devcontainer up failed: boom",
    });
    expect(orch.logLines(project.id)).toContain("tail line");
  });

  it("rejects containers without a bridge IP but still records the container id so Stop can clean it up", async () => {
    const { store, containers, orch } = setup();
    containers.inspect.mockResolvedValueOnce({
      id: "c1",
      running: true,
      projectId: project.id,
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "error",
      containerId: "c1",
    });
    expect(store.runtime(project.id).error).toMatch(/host networking/u);

    await orch.stop(project.id);
    expect(containers.stop).toHaveBeenCalledWith("c1");
  });

  it("keeps the container running but marks opencode unhealthy when launch fails", async () => {
    const { store, runtime, orch } = setup();
    runtime.ensureRunning.mockRejectedValueOnce(
      new CommandError(
        "opencode 1.18.31 found, but opendevhub requires opencode v2"
      )
    );
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "unhealthy",
    });
    expect(store.runtime(project.id).error).toMatch(/requires opencode v2/u);
  });

  it("rebuild forces a new container and a new password", async () => {
    const { containers, runtime, orch } = setup({
      projects: { [project.id]: { password: "old" } },
    });
    await orch.rescan();
    await orch.rebuild(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBeTruthy();
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBeUndefined();
  });

  it("start reuses a persisted password", async () => {
    const { runtime, orch } = setup({
      projects: { [project.id]: { password: "old" } },
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBe("old");
  });

  it("stop stops monitor, opencode and container and clears sessions", async () => {
    const { store, containers, runtime, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    store.setSessions(project.id, [
      {
        id: "s",
        projectId: project.id,
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    await orch.stop(project.id);
    expect(monitors[0].stopped).toBeTruthy();
    expect(runtime.stopServer).toHaveBeenCalled();
    expect(containers.stop).toHaveBeenCalledWith("c1");
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      opencode: "absent",
    });
    expect(store.snapshot().projects[0].sessions).toEqual([]);
  });

  it("restartOpencode relaunches with a fresh password", async () => {
    const { runtime, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.restartOpencode(project.id);
    expect(runtime.ensureRunning).toHaveBeenCalledTimes(2);
    expect(runtime.ensureRunning.mock.calls[1][1].password).toBeUndefined();
  });

  it("adopts running containers with a working persisted password", async () => {
    const { store, containers, orch, monitors } = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "c1",
    });
    expect(monitors).toHaveLength(1);
  });

  it("adopts a running container whose opencode is gone as unhealthy", async () => {
    const { store, containers, runtime, orch, monitors } = setup({
      projects: { [project.id]: { password: "pw" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    runtime.isHealthy.mockResolvedValueOnce(false);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "unhealthy",
    });
    expect(store.runtime(project.id).error).toMatch(/Restart opencode/u);
    expect(monitors).toHaveLength(0);
  });

  it("adopts stopped containers as stopped and ignores unknown labels", async () => {
    const { store, containers, orch } = setup();
    containers.listManaged.mockResolvedValueOnce([
      { ...running, running: false },
      { id: "x", running: true, ip: "1.2.3.4", projectId: "other-000000" },
    ]);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      containerId: "c1",
    });
  });

  it("refreshContainers notices containers stopped outside opendevhub", async () => {
    const { store, containers, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    containers.inspect.mockResolvedValueOnce({ ...running, running: false });
    await orch.refreshContainers();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      opencode: "absent",
    });
    expect(monitors[0].stopped).toBeTruthy();
  });

  it("refreshContainers keeps checking other projects when inspect rejects for one", async () => {
    const project2: Project = { ...project, id: "demo2-def456" };
    const { store, containers, orch } = setup();
    containers.up.mockImplementation(async (p: ExecTarget) => ({
      containerId: p.id === project.id ? "c1" : "c2",
      remoteWorkspaceFolder: "/workspaces/demo",
    }));
    await orch.rescan();
    store.setProjects([project, project2]);
    await orch.start(project.id);
    await orch.start(project2.id);

    containers.inspect.mockImplementation(async (id?: string) => {
      if (id === "c1") {
        throw new Error("docker inspect failed");
      }
      return { ...running, id: "c2", running: false };
    });

    await expect(orch.refreshContainers()).resolves.toBeUndefined();
    expect(store.runtime(project.id).containerState).toBe("running");
    expect(store.runtime(project2.id).containerState).toBe("stopped");
  });

  it("refreshContainers does not overwrite state set by a lifecycle action started while inspect is in flight", async () => {
    const { store, containers, runtime, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);

    let resolveInspect!: (v: ContainerInfo | undefined) => void;
    containers.inspect.mockImplementationOnce(
      () => new Promise((resolve) => (resolveInspect = resolve))
    );
    let resolveEnsure!: (v: { password: string; version: string }) => void;
    runtime.ensureRunning.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEnsure = resolve))
    );

    const refreshP = orch.refreshContainers();
    const restartP = orch.restartOpencode(project.id); // marks the project busy synchronously

    resolveInspect({ ...running, running: false });
    await refreshP;
    expect(store.runtime(project.id).containerState).toBe("running");

    // restartOpencode ensures the relay before launching opencode, so wait for the launch call.
    await vi.waitFor(() =>
      expect(runtime.ensureRunning).toHaveBeenCalledTimes(2)
    );
    resolveEnsure({ password: "pw", version: "2.0.20" });
    await restartP;
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
    });
  });

  it("monitor health updates opencode state; sessions flow into the store", async () => {
    const { store, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    monitors[0].opts.onHealth(false);
    expect(store.runtime(project.id).opencode).toBe("unhealthy");
    monitors[0].opts.onSessions([
      {
        id: "s",
        projectId: project.id,
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "running",
      },
    ]);
    expect(store.snapshot().projects[0].sessions).toHaveLength(1);
  });

  it("records usage from every monitor under the project's id", async () => {
    const s = await withEnv();
    const main = s.monitors.find((m) => m.opts.envId === project.id)!;
    const env = s.monitors.find((m) => m.opts.envId !== project.id)!;
    main.opts.onRawSessions!([rawSession("a")]);
    env.opts.onRawSessions!([rawSession("b")]);
    expect(
      s.recordUsage.mock.calls.map(([id, sessions]) => [
        id,
        sessions.map((x: { id: string }) => x.id),
      ])
    ).toStrictEqual([
      [project.id, ["a"]],
      [project.id, ["b"]],
    ]);
  });

  it("notifies log listeners and caps the log buffer at 500 lines", async () => {
    const { containers, orch } = setup();
    containers.up.mockImplementationOnce(async (_p, o) => {
      for (let i = 0; i < 600; i++) {
        o.onLine(`line ${i}`);
      }
      return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo" };
    });
    const seen: string[] = [];
    orch.onLog((_id, line) => seen.push(line));
    await orch.rescan();
    await orch.start(project.id);
    expect(seen).toContain("line 599");
    expect(orch.logLines(project.id)).toHaveLength(500);
    expect(orch.logLines(project.id)[0]).not.toBe("line 0");
  });

  it("forwards configured ports on start, including skipped entries in runtime.ports", async () => {
    const { store, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ host: "172.17.0.9" }),
      [{ containerPort: 3000, label: "web" }],
      expect.any(Function),
      expect.any(Object)
    );
    expect(store.runtime(project.id).ports).toStrictEqual([
      {
        status: "forwarded",
        containerPort: 3000,
        label: "web",
        hostPort: 3000,
      },
      {
        status: "skipped",
        entry: "db:5432",
        reason: "service hosts are not supported yet",
      },
    ]);
    expect(orch.logLines(project.id)).toContain("ports: 3000 → localhost:3000");
    expect(orch.logLines(project.id)).toContain(
      "ports: skipped db:5432 (service hosts are not supported yet)"
    );
  });

  it("forwards ports before launching opencode, so they survive an opencode failure", async () => {
    const { store, runtime, orch, forwarder } = setup();
    runtime.ensureRunning.mockRejectedValueOnce(
      new CommandError(
        "opencode 1.18.31 found, but opendevhub requires opencode v2"
      )
    );
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open).toHaveBeenCalled();
    expect(store.runtime(project.id).ports).toHaveLength(2);
    expect(store.runtime(project.id).opencode).toBe("unhealthy");
  });

  it("still starts when the devcontainer config cannot be read", async () => {
    const { store, containers, orch, forwarder } = setup();
    containers.readConfiguration.mockRejectedValueOnce(
      new CommandError("devcontainer read-configuration failed (exit 1)")
    );
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open).not.toHaveBeenCalled();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      ports: [],
      error: undefined,
    });
    expect(orch.logLines(project.id)).toContain(
      "ports: could not read devcontainer configuration: devcontainer read-configuration failed (exit 1)"
    );
  });

  it("logs failed forwards without touching the project error", async () => {
    const { store, orch, forwarder } = setup();
    forwarder.open.mockResolvedValueOnce([
      {
        status: "failed",
        containerPort: 3000,
        label: "web",
        reason: "no free host port in 3000–3100",
      },
    ]);
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id).error).toBeUndefined();
    expect(orch.logLines(project.id)).toContain(
      "ports: 3000 not forwarded (no free host port in 3000–3100)"
    );
  });

  it("stop closes the forwards and clears runtime.ports", async () => {
    const { store, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.stop(project.id);
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(store.runtime(project.id).ports).toBeUndefined();
  });

  it("rebuild closes old forwards and reopens against the new container IP", async () => {
    const { containers, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    containers.inspect.mockResolvedValue({ ...running, ip: "172.17.0.42" });
    await orch.rebuild(project.id);
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(forwarder.close.mock.invocationCallOrder[0]).toBeLessThan(
      forwarder.open.mock.invocationCallOrder[1]
    );
    expect(forwarder.open.mock.calls[1][1].host).toBe("172.17.0.42");
  });

  it("adopt forwards ports of running containers only", async () => {
    const { store, containers, orch, forwarder } = setup({
      projects: { [project.id]: { password: "pw" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(forwarder.open).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ host: "172.17.0.9" }),
      [{ containerPort: 3000, label: "web" }],
      expect.any(Function),
      expect.any(Object)
    );
    expect(store.runtime(project.id).ports).toHaveLength(2);

    const stopped = setup();
    stopped.containers.listManaged.mockResolvedValueOnce([
      { ...running, running: false },
    ]);
    await stopped.orch.rescan();
    await stopped.orch.adopt();
    expect(stopped.forwarder.open).not.toHaveBeenCalled();
  });

  it("refreshContainers closes forwards of containers that went away", async () => {
    const { store, containers, orch, forwarder } = setup();
    await orch.rescan();
    await orch.start(project.id);
    containers.inspect.mockResolvedValueOnce({ ...running, running: false });
    await orch.refreshContainers();
    expect(forwarder.close).toHaveBeenCalledWith(project.id);
    expect(store.runtime(project.id).ports).toBeUndefined();
  });

  it("shutdown closes all forwards", async () => {
    const { orch, forwarder } = setup();
    await orch.shutdown();
    expect(forwarder.closeAll).toHaveBeenCalled();
  });

  it("starts the relay before forwarding and forwards through it", async () => {
    const { store, relay, forwarder, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    const token = store.runtime(project.id).relayToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(relay.ensureRunning).toHaveBeenCalledWith(project, {
      address: { host: "172.17.0.9", port: 4097 },
      token,
      binary: "/usr/local/bin/opencode",
    });
    expect(relay.ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(
      forwarder.open.mock.invocationCallOrder[0]
    );
    expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
      host: "172.17.0.9",
      relay: { host: "172.17.0.9", port: 4097, token },
    });
    expect(store.runtime(project.id).relay).toBe("active");
    expect(orch.logLines(project.id)).toContain("relay: active (bun)");
  });

  it("forwards directly and still starts when the relay is unavailable", async () => {
    const { store, relay, forwarder, orch } = setup();
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "no relay runtime",
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
      host: "172.17.0.9",
    });
    expect(store.runtime(project.id)).toMatchObject({
      relay: "unavailable",
      opencode: "healthy",
      error: undefined,
    });
    expect(orch.logLines(project.id)).toContain(
      "relay: unavailable (no relay runtime)"
    );
  });

  it("reuses the persisted relay token across restarts and adoption", async () => {
    const { relay, containers, orch } = setup({
      projects: { [project.id]: { password: "pw", relayToken: "kept" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(relay.ensureRunning.mock.calls[0][1].token).toBe("kept");
  });

  it("stop stops the relay and clears the relay status", async () => {
    const { store, relay, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.stop(project.id);
    expect(relay.stop).toHaveBeenCalledWith(project);
    expect(store.runtime(project.id).relay).toBeUndefined();
  });

  it("relaunches the relay in the background when the forwarder finds it unreachable (rate-limited)", async () => {
    const { store, relay, forwarder, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    const events = forwarder.open.mock.calls[0][4]!;
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "bun: gone",
    });
    events.onRelayUnreachable!();
    await vi.waitFor(() =>
      expect(relay.ensureRunning).toHaveBeenCalledTimes(2)
    );
    await vi.waitFor(() =>
      expect(store.runtime(project.id).relay).toBe("unavailable")
    );
    expect(orch.logLines(project.id)).toContain(
      "relay: unreachable, relaunching"
    );
    events.onRelayUnreachable!();
    await new Promise((r) => setTimeout(r, 20));
    expect(relay.ensureRunning).toHaveBeenCalledTimes(2);
  });

  it("restart opencode also ensures the relay and re-forwards when it comes back", async () => {
    const { store, relay, forwarder, orch } = setup();
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "no relay runtime",
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
      host: "172.17.0.9",
    });
    await orch.restartOpencode(project.id);
    expect(relay.ensureRunning).toHaveBeenCalledTimes(2);
    expect(forwarder.open).toHaveBeenCalledTimes(2);
    expect(forwarder.open.mock.calls[1][1]).toMatchObject({
      relay: { port: 4097 },
    });
    expect(store.runtime(project.id).relay).toBe("active");
  });

  describe("through the gateway route", () => {
    function gatewayNetwork() {
      const dial: Dial = vi.fn(async () => {
        throw new Error("not used");
      });
      const routes: (Route & { closed: boolean })[] = [];
      const network = {
        route: vi.fn(async (c: RouteContainer, onLog: (l: string) => void) => {
          onLog(
            `network: container IP ${c.ip} is not reachable from this machine, using the gateway container`
          );
          const route = {
            kind: "gateway" as const,
            opencode: { host: "127.0.0.1", port: 50_001 },
            relay: { host: "127.0.0.1", port: 50_002 },
            dial,
            closed: false,
            close: async () => {
              route.closed = true;
            },
          };
          routes.push(route);
          return route;
        }),
      };
      return { network, routes, dial };
    }

    it("reaches opencode and the relay through the route's addresses, and forwards with its dial", async () => {
      const { network, dial } = gatewayNetwork();
      const { store, runtime, relay, forwarder, orch, monitors } = setup(
        undefined,
        network
      );
      await orch.rescan();
      await orch.start(project.id);
      expect(network.route).toHaveBeenCalledWith(
        { id: "c1", ip: "172.17.0.9", network: undefined },
        expect.any(Function)
      );
      expect(relay.ensureRunning.mock.calls[0][1].address).toStrictEqual({
        host: "127.0.0.1",
        port: 50_002,
      });
      expect(runtime.ensureRunning.mock.calls[0][1]).toMatchObject({
        address: { host: "127.0.0.1", port: 50_001 },
      });
      const token = store.runtime(project.id).relayToken!;
      expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
        host: "172.17.0.9",
        dial,
        relay: { host: "127.0.0.1", port: 50_002, token },
      });
      expect(orch.opencodeAddress(project.id)).toStrictEqual({
        host: "127.0.0.1",
        port: 50_001,
      });
      expect(monitors[0].opts.client).toBeDefined();
      expect(orch.logLines(project.id)).toContain(
        "network: container IP 172.17.0.9 is not reachable from this machine, using the gateway container"
      );
      expect(store.runtime(project.id)).toMatchObject({
        containerState: "running",
        opencode: "healthy",
      });
    });

    it("starts sessions through the route's opencode address", async () => {
      const { network } = gatewayNetwork();
      const { orch, client, clientFor } = setup(undefined, network);
      await orch.rescan();
      await orch.start(project.id);
      await orch.startSession(project.id, "/workspaces/demo");
      expect(clientFor).toHaveBeenLastCalledWith({
        baseUrl: "http://127.0.0.1:50001",
        password: "pw",
      });
      expect(client.createSession).toHaveBeenCalled();
    });

    it("passes the container's network to the route", async () => {
      const { network } = gatewayNetwork();
      const { containers, orch } = setup(undefined, network);
      containers.inspect.mockResolvedValue({
        ...running,
        network: "demo_default",
      });
      await orch.rescan();
      await orch.start(project.id);
      expect(network.route.mock.calls[0][0]).toEqual({
        id: "c1",
        ip: "172.17.0.9",
        network: "demo_default",
      });
    });

    it("forwards with the dial alone when the relay is unavailable", async () => {
      const { network, dial } = gatewayNetwork();
      const { relay, forwarder, orch } = setup(undefined, network);
      relay.ensureRunning.mockResolvedValueOnce({
        status: "unavailable",
        reason: "no relay runtime",
      });
      await orch.rescan();
      await orch.start(project.id);
      expect(forwarder.open.mock.calls[0][1]).toStrictEqual({
        host: "172.17.0.9",
        dial,
      });
    });

    it("closes the route on stop, on rebuild and on shutdown", async () => {
      const { network, routes } = gatewayNetwork();
      const { orch } = setup(undefined, network);
      await orch.rescan();
      await orch.start(project.id);
      await orch.rebuild(project.id);
      expect(routes.map((r) => r.closed)).toStrictEqual([true, false]);
      await orch.stop(project.id);
      expect(routes[1].closed).toBeTruthy();
      expect(orch.opencodeAddress(project.id)).toBeUndefined();
      await orch.start(project.id);
      await orch.shutdown();
      expect(routes[2].closed).toBeTruthy();
    });

    it("closes the route when the container stops outside opendevhub", async () => {
      const { network, routes } = gatewayNetwork();
      const { containers, orch } = setup(undefined, network);
      await orch.rescan();
      await orch.start(project.id);
      containers.inspect.mockResolvedValueOnce({ ...running, running: false });
      await orch.refreshContainers();
      expect(routes[0].closed).toBeTruthy();
    });

    it("fails start, with the container still running, when the gateway cannot be set up", async () => {
      const { network } = gatewayNetwork();
      network.route.mockRejectedValueOnce(
        new CommandError("docker run failed for the gateway container", [
          "pull access denied",
        ])
      );
      const { store, runtime, orch } = setup(undefined, network);
      await orch.rescan();
      await orch.start(project.id);
      expect(store.runtime(project.id)).toMatchObject({
        containerState: "running",
        opencode: "unhealthy",
        error: "docker run failed for the gateway container",
      });
      expect(orch.logLines(project.id)).toContain("pull access denied");
      expect(runtime.ensureRunning).not.toHaveBeenCalled();
    });

    it("adopt checks health through the route and keeps adopting when one route fails", async () => {
      const { network } = gatewayNetwork();
      const other: Project = {
        ...project,
        id: "other-000000",
        name: "other",
        path: "/src/other",
      };
      const { store, containers, runtime, orch } = setup(
        {
          projects: {
            [project.id]: { password: "pw" },
            [other.id]: { password: "pw" },
          },
        },
        network,
        [project, other]
      );
      network.route.mockRejectedValueOnce(new Error("gateway down"));
      containers.listManaged.mockResolvedValueOnce([
        running,
        { ...running, id: "c2", projectId: other.id },
      ]);
      await orch.rescan();
      await orch.adopt();
      expect(store.runtime(project.id)).toMatchObject({
        containerState: "running",
        error: "gateway down",
      });
      expect(runtime.isHealthy).toHaveBeenCalledWith({
        baseUrl: "http://127.0.0.1:50001",
        password: "pw",
      });
      expect(store.runtime(other.id)).toMatchObject({
        containerState: "running",
        opencode: "healthy",
      });
    });
  });

  describe("worktrees", () => {
    const wtPath = "/workspaces/demo.worktrees/feature-x";
    const known: Worktree = {
      path: wtPath,
      hostPath: "/src/demo.worktrees/feature-x",
      branch: "feature/x",
    };

    it("mounts a host folder next to the project, created before up", async () => {
      const { store, containers, mkdir, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      expect(mkdir).toHaveBeenCalledWith("/src/demo.worktrees");
      expect(containers.up.mock.calls[0][1].mounts).toStrictEqual([
        "type=bind,source=/src/demo.worktrees,target=/workspaces/demo.worktrees",
        `type=volume,source=opendevhub-opencode-${project.id},target=/opendevhub/opencode`,
      ]);
      expect(store.runtime(project.id)).toMatchObject({
        containerName: "demo_c1",
        remoteUser: "node",
        worktreeRoot: {
          host: "/src/demo.worktrees",
          container: "/workspaces/demo.worktrees",
          mounted: true,
        },
      });
    });

    it("uses the configured workspace folder for the mount target", async () => {
      const { containers, orch } = setup();
      containers.workspaceFolder.mockResolvedValueOnce("/code/demo");
      await orch.rescan();
      await orch.start(project.id);
      expect(containers.up.mock.calls[0][1].mounts?.[0]).toMatch(
        /target=\/code\/demo\.worktrees$/u
      );
    });

    it("still starts when the folder can't be created, and flags a container without the mount", async () => {
      const { store, containers, mkdir, orch } = setup();
      mkdir.mockRejectedValueOnce(new Error("EACCES"));
      containers.inspect.mockResolvedValue({ ...running, binds: {} });
      await orch.rescan();
      await orch.start(project.id);
      expect(containers.up.mock.calls[0][1].mounts).toStrictEqual([
        `type=volume,source=opendevhub-opencode-${project.id},target=/opendevhub/opencode`,
      ]);
      expect(store.runtime(project.id)).toMatchObject({
        containerState: "running",
        worktreeRoot: { mounted: false },
      });
      expect(orch.logLines(project.id).join("\n")).toMatch(
        /EACCES[\s\S]*rebuild it to enable worktrees/u
      );
      await expect(
        orch.createWorktree(project.id, { branch: "x" })
      ).rejects.toBeInstanceOf(UnavailableError);
    });

    it("lists worktrees on start and on adopt", async () => {
      const { store, worktrees, containers, orch } = setup({
        projects: {
          [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
        },
      });
      worktrees.list.mockResolvedValue([known]);
      containers.listManaged.mockResolvedValue([running]);
      await orch.rescan();
      await orch.adopt();
      expect(worktrees.list.mock.calls[0][2]).toMatchObject({ mounted: true });
      expect(store.runtime(project.id).worktrees).toStrictEqual([known]);
    });

    it("creates a worktree, refreshes the list and starts a session in it", async () => {
      const { store, worktrees, client, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      worktrees.list.mockResolvedValue([known]);
      const res = await orch.createWorktree(project.id, {
        branch: " feature/x ",
        base: " ",
        startSession: true,
      });
      expect(worktrees.add.mock.calls[0][1]).toMatchObject({
        branch: "feature/x",
        base: undefined,
        workspaceFolder: "/workspaces/demo",
      });
      expect(client.createSession).toHaveBeenCalledWith(res.worktree.path, {
        title: "feature/x",
      });
      expect(res.sessionId).toBe("ses_new");
      expect(store.runtime(project.id).worktrees).toStrictEqual([known]);
    });

    it("validates input and needs a running container", async () => {
      const { orch } = setup();
      await orch.rescan();
      expect(() => orch.createWorktree(project.id, { branch: "a b" })).toThrow(
        InvalidRequestError
      );
      expect(() => orch.createWorktree(project.id, { branch: "ok" })).toThrow(
        UnavailableError
      );
      expect(() => orch.createWorktree("nope", { branch: "ok" })).toThrow(
        NotFoundError
      );
    });

    it("runs one git operation at a time per project", async () => {
      const { worktrees, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      let release!: () => void;
      worktrees.add.mockImplementationOnce(
        (_p, a) =>
          new Promise(
            (r) =>
              (release = () =>
                r({ path: `${a.root.container}/x`, branch: "x" }))
          )
      );
      const first = orch.createWorktree(project.id, { branch: "x" });
      expect(() => orch.createWorktree(project.id, { branch: "y" })).toThrow(
        BusyError
      );
      await vi.waitFor(() => expect(release).toBeDefined());
      release();
      await first;
    });

    it("only removes, opens and starts sessions in the workspace or known worktrees", async () => {
      const { store, worktrees, editors, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      store.updateRuntime(project.id, { worktrees: [known] });
      await expect(
        orch.removeWorktree(project.id, "/etc", true)
      ).rejects.toThrow(InvalidRequestError);
      await expect(orch.startSession(project.id, "/tmp")).rejects.toThrow(
        InvalidRequestError
      );
      expect(() => orch.openInEditor(project.id, "zed", "/home")).toThrow(
        InvalidRequestError
      );

      await orch.openInEditor(project.id, "zed", wtPath);
      expect(editors.open).toHaveBeenLastCalledWith("zed", {
        containerPath: wtPath,
        hostPath: "/src/demo.worktrees/feature-x",
        containerName: "demo_c1",
      });
      await orch.openInEditor(project.id, "zed", "/workspaces/demo");
      expect(editors.open.mock.calls.at(-1)?.[1].hostPath).toBe("/src/demo");

      worktrees.list.mockResolvedValue([]);
      await orch.removeWorktree(project.id, wtPath, false);
      expect(worktrees.remove).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        wtPath,
        false
      );
      expect(store.runtime(project.id).worktrees).toStrictEqual([]);
    });

    it("opens host editors on a stopped project, without a container to attach to", async () => {
      const { store, editors, orch } = setup();
      await orch.rescan();
      store.updateRuntime(project.id, {
        containerName: "demo_c1",
        worktrees: [known],
      });
      await orch.openInEditor(project.id, "zed", wtPath);
      expect(editors.open.mock.calls[0][1]).toStrictEqual({
        containerPath: wtPath,
        hostPath: known.hostPath,
        containerName: undefined,
      });
    });

    it("watches worktree directories and refreshes when a session shows up in an unknown one", async () => {
      const { store, worktrees, monitors, orch } = setup();
      await orch.rescan();
      await orch.start(project.id);
      store.updateRuntime(project.id, { worktrees: [known] });
      expect(monitors[0].opts.extraDirectories?.()).toStrictEqual([wtPath]);
      const calls = worktrees.list.mock.calls.length;
      const session = (directory: string) => ({
        id: directory,
        projectId: project.id,
        title: "t",
        directory,
        updatedAt: 1,
        status: "idle" as const,
      });
      monitors[0].opts.onSessions([
        session("/workspaces/demo"),
        session(wtPath),
      ]);
      expect(worktrees.list).toHaveBeenCalledTimes(calls);
      monitors[0].opts.onSessions([
        session("/home/node/.local/share/opencode/worktree/p/y"),
      ]);
      await vi.waitFor(() =>
        expect(worktrees.list).toHaveBeenCalledTimes(calls + 1)
      );
      monitors[0].opts.onSessions([
        session("/home/node/.local/share/opencode/worktree/p/y"),
      ]);
      await new Promise((r) => setTimeout(r, 10));
      expect(worktrees.list).toHaveBeenCalledTimes(calls + 1);
    });
  });
  describe("cleanup", () => {
    const featWt = {
      path: "/workspaces/demo.worktrees/feat",
      hostPath: "/src/demo.worktrees/feat",
      branch: "feat",
    };
    const item = {
      id: "branch:demo-abc123:feat",
      kind: "branch" as const,
      checked: true,
      reason: "merged into main",
      projectId: project.id,
      branch: "feat",
      base: "main",
      why: "merged" as const,
      worktree: featWt.path,
    };

    async function running() {
      const s = setup();
      await s.orch.rescan();
      await s.orch.start(project.id);
      s.worktrees.list.mockResolvedValue([featWt]);
      s.git.branchRefs.mockResolvedValue([
        { name: "main", gone: false },
        { name: "feat", gone: false },
      ]);
      s.git.recordedBase.mockResolvedValue(undefined);
      return s;
    }

    it("scans branches in the container and refreshes the worktree list", async () => {
      const { orch, git, store } = await running();
      const r = await orch.cleanupScan(project.id);
      expect(git.fetchPrune).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        "origin"
      );
      expect(r.items.map((i) => [i.branch, i.worktree])).toStrictEqual([
        ["feat", featWt.path],
      ]);
      expect(store.runtime(project.id).worktrees).toStrictEqual([featWt]);
    });

    it("removes the worktree, then deletes a merged branch with -d, and logs it", async () => {
      const { orch, worktrees, git } = await running();
      await expect(orch.cleanupBranch(project.id, item)).resolves.toStrictEqual(
        {
          outcome: "removed",
        }
      );
      expect(worktrees.remove).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        featWt.path,
        false
      );
      expect(git.deleteBranch).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        "feat",
        false
      );
      expect(orch.logLines(project.id)).toContain(
        "cleanup: deleted branch feat (merged into main) and its worktree"
      );
    });

    it("deletes an upstream-gone branch with -D", async () => {
      const { orch, git } = await running();
      git.isAncestor.mockResolvedValue(false);
      git.branchRefs.mockResolvedValue([
        { name: "feat", upstream: "refs/remotes/origin/feat", gone: true },
      ]);
      const gone = {
        ...item,
        why: "upstream-gone" as const,
        reason: "its upstream is gone; it may not be merged",
      };
      await expect(orch.cleanupBranch(project.id, gone)).resolves.toStrictEqual(
        {
          outcome: "removed",
        }
      );
      expect(git.deleteBranch).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        "feat",
        true
      );
    });

    it("forces the worktree removal only for an item scanned as dirty", async () => {
      const { orch, worktrees, git } = await running();
      git.isClean.mockResolvedValue(false);
      await orch.cleanupBranch(project.id, {
        ...item,
        dirty: true,
        checked: false,
      });
      expect(worktrees.remove).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        featWt.path,
        true
      );
    });

    it("skips an item that changed since the scan, touching nothing", async () => {
      const { orch, worktrees, git } = await running();
      git.isAncestor.mockResolvedValue(false);
      await expect(orch.cleanupBranch(project.id, item)).resolves.toStrictEqual(
        {
          outcome: "skipped",
          message: "changed since scan",
        }
      );
      expect(worktrees.remove).not.toHaveBeenCalled();
      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it("removes the worktree's own container first", async () => {
      const { orch, store, containers } = await running();
      store.putEnvironment({
        id: "env-feat",
        projectId: project.id,
        worktree: featWt,
      });
      store.updateRuntime("env-feat", { containerId: "c9" });
      await orch.cleanupBranch(project.id, { ...item, env: "env-feat" });
      expect(containers.remove).toHaveBeenCalledWith("c9");
      expect(store.environment("env-feat")).toBeUndefined();
    });

    const discarded = (id: string, directory = "/workspaces/demo") =>
      rawSession(id, {
        location: { directory },
        time: { created: 1, updated: Date.now() },
        metadata: {
          opendevhub: {
            task: "tsk_1",
            variant: 1,
            of: 2,
            title: "Fix",
            discarded: true,
          },
        },
      });

    it("scans sessions of the main opencode and of each running task environment, against a fresh worktree list", async () => {
      const { orch, client, envId } = await withEnv();
      client.sessions
        .mockResolvedValueOnce([
          discarded("ses_d"),
          rawSession("ses_gone", {
            location: { directory: "/workspaces/demo.worktrees/old" },
            time: { created: 1, updated: Date.now() },
          }),
        ])
        .mockResolvedValueOnce([discarded("ses_t", featWt.path)]);
      const r = await orch.cleanupSessionScan(project.id);
      expect(r.items.map((i) => [i.id, i.why, i.envId])).toStrictEqual([
        ["session:demo-abc123:ses_d", "discarded", undefined],
        ["session:demo-abc123:ses_gone", "worktree-gone", undefined],
        ["session:demo-abc123:ses_t", "discarded", envId],
      ]);
    });

    it("leaves out busy sessions, and skips the worktree rule when the worktree list can't be read", async () => {
      const { orch, client, store, worktrees } = await running();
      store.setSessions(project.id, [
        {
          id: "ses_w",
          projectId: project.id,
          title: "w",
          directory: "/x",
          updatedAt: 1,
          status: "needs-answer",
        },
      ]);
      const gone = (id: string) =>
        rawSession(id, {
          location: { directory: "/workspaces/demo.worktrees/old" },
          time: { created: 1, updated: Date.now() },
        });
      client.sessions.mockResolvedValue([
        discarded("ses_run"),
        discarded("ses_w"),
        gone("ses_gone"),
      ]);
      client.active.mockResolvedValue(new Set(["ses_run"]));
      worktrees.list.mockRejectedValue(new Error("git broke"));
      expect((await orch.cleanupSessionScan(project.id)).items).toStrictEqual(
        []
      );
    });

    it("deletes a session that still qualifies, logs it, and skips one that changed", async () => {
      const { orch, client } = await running();
      client.sessions.mockResolvedValue([discarded("ses_d")]);
      const [found] = (await orch.cleanupSessionScan(project.id)).items;
      await expect(
        orch.cleanupSession(project.id, found)
      ).resolves.toStrictEqual({
        outcome: "removed",
      });
      expect(client.deleteSession).toHaveBeenCalledWith(
        "ses_d",
        "/workspaces/demo"
      );
      expect(orch.logLines(project.id)).toContain(
        "cleanup: removed session Session ses_d (discarded task variant)"
      );
      client.sessions.mockResolvedValue([]);
      await expect(
        orch.cleanupSession(project.id, found)
      ).resolves.toStrictEqual({
        outcome: "skipped",
        message: "changed since scan",
      });
      expect(client.deleteSession).toHaveBeenCalledOnce();
    });

    it("refuses a session item naming another project's environment", async () => {
      const { orch, client, store } = await running();
      store.putEnvironment({
        id: "other-env",
        projectId: "other",
        worktree: featWt,
      });
      client.sessions.mockResolvedValue([discarded("ses_d")]);
      const forged = {
        ...item,
        id: "session:demo-abc123:ses_d",
        kind: "session" as const,
        sessionId: "ses_d",
        envId: "other-env",
        title: "",
        directory: "",
        updatedAt: 0,
        why: "idle" as const,
      };
      await expect(
        orch.cleanupSession(project.id, forged)
      ).resolves.toStrictEqual({
        outcome: "skipped",
        message: "changed since scan",
      });
      expect(client.deleteSession).not.toHaveBeenCalled();
    });

    it("refuses while another git action runs", async () => {
      const { orch, git } = await running();
      let release!: () => void;
      git.fetchPrune.mockImplementation(
        () => new Promise<void>((r) => (release = r))
      );
      const first = orch.cleanupScan(project.id);
      expect(() => orch.cleanupBranch(project.id, item)).toThrow(BusyError);
      await vi.waitFor(() => expect(git.fetchPrune).toHaveBeenCalled());
      release();
      await first;
    });
  });

  describe("removeSession", () => {
    it("deletes a listed session through its environment's opencode, stopping it first when busy", async () => {
      const s = setup();
      await s.orch.rescan();
      await s.orch.start(project.id);
      s.store.setSessions(project.id, [
        {
          id: "ses_1",
          projectId: project.id,
          title: "Idle one",
          directory: "/workspaces/demo",
          updatedAt: 1,
          status: "idle",
        },
        {
          id: "ses_2",
          projectId: project.id,
          title: "Busy one",
          directory: "/workspaces/demo",
          updatedAt: 1,
          status: "running",
        },
      ]);
      const { reconciled } = s.monitors[0];
      await s.orch.removeSession(project.id, "ses_1");
      expect(s.client.interrupt).not.toHaveBeenCalled();
      expect(s.client.deleteSession).toHaveBeenCalledWith(
        "ses_1",
        "/workspaces/demo"
      );
      expect(s.orch.logLines(project.id)).toContain("removed session Idle one");
      expect(s.monitors[0].reconciled).toBeGreaterThan(reconciled);
      await s.orch.removeSession(project.id, "ses_2");
      expect(s.client.interrupt).toHaveBeenCalledWith(
        "ses_2",
        "/workspaces/demo"
      );
      await expect(s.orch.removeSession(project.id, "nope")).rejects.toThrow(
        NotFoundError
      );
    });
  });

  describe("responding", () => {
    async function running() {
      const s = setup();
      await s.orch.rescan();
      await s.orch.start(project.id);
      s.store.setSessions(project.id, [
        waiting({ permissions: [permission], forms: [form] }),
      ]);
      return s;
    }

    it("replies as the asking subagent session, in the root session's directory, then reconciles", async () => {
      const { orch, client, monitors } = await running();
      await orch.replyPermission(project.id, "per_1", { decision: "always" });
      expect(client.replyPermission).toHaveBeenCalledWith(
        "ses_child",
        "per_1",
        { decision: "always" },
        "/workspaces/demo.worktrees/x"
      );
      expect(monitors.at(-1)!.reconciled).toBe(1);
    });

    it("passes a reject reason through", async () => {
      const { orch, client } = await running();
      await orch.replyPermission(project.id, "per_1", {
        decision: "reject",
        message: "use pnpm",
      });
      expect(client.replyPermission.mock.calls[0][2]).toStrictEqual({
        decision: "reject",
        message: "use pnpm",
      });
    });

    it("answers and cancels forms", async () => {
      const { orch, client } = await running();
      await orch.replyForm(project.id, "frm_1", { db: "postgres" });
      expect(client.replyForm).toHaveBeenCalledWith(
        "ses_root",
        "frm_1",
        { db: "postgres" },
        "/workspaces/demo.worktrees/x"
      );
      await orch.cancelForm(project.id, "frm_1");
      expect(client.cancelForm).toHaveBeenCalledWith(
        "ses_root",
        "frm_1",
        "/workspaces/demo.worktrees/x"
      );
    });

    it("only forwards ids it listed itself", async () => {
      const { orch, client } = await running();
      await expect(
        orch.replyPermission(project.id, "per_other", { decision: "once" })
      ).rejects.toThrow(NotFoundError);
      await expect(orch.replyForm(project.id, "per_1", {})).rejects.toThrow(
        NotFoundError
      );
      await expect(
        orch.replyPermission("nope", "per_1", { decision: "once" })
      ).rejects.toThrow(NotFoundError);
      expect(client.replyPermission).not.toHaveBeenCalled();
      expect(client.replyForm).not.toHaveBeenCalled();
    });

    it("validates the decision and the answer", async () => {
      const { orch } = await running();
      await expect(
        orch.replyPermission(project.id, "per_1", { decision: "yes" })
      ).rejects.toThrow(InvalidRequestError);
      await expect(orch.replyForm(project.id, "frm_1", ["a"])).rejects.toThrow(
        InvalidRequestError
      );
      await expect(orch.replyForm(project.id, "frm_1", null)).rejects.toThrow(
        InvalidRequestError
      );
    });

    it("turns opencode's not-found and already-settled into AlreadyAnsweredError, and still reconciles", async () => {
      const { orch, client, monitors } = await running();
      client.replyPermission.mockRejectedValueOnce(
        new OpencodeHttpError(404, "/x")
      );
      await expect(
        orch.replyPermission(project.id, "per_1", { decision: "once" })
      ).rejects.toThrow(AlreadyAnsweredError);
      client.replyForm.mockRejectedValueOnce(
        new OpencodeHttpError(409, "/x", "FormAlreadySettledError")
      );
      await expect(orch.replyForm(project.id, "frm_1", {})).rejects.toThrow(
        AlreadyAnsweredError
      );
      expect(monitors.at(-1)!.reconciled).toBe(2);
    });

    it("surfaces opencode's message for an invalid answer, and keeps other failures as they are", async () => {
      const { orch, client } = await running();
      client.replyForm.mockRejectedValueOnce(
        new OpencodeHttpError(
          400,
          "/x",
          "FormInvalidAnswerError",
          "db is required"
        )
      );
      await expect(orch.replyForm(project.id, "frm_1", {})).rejects.toThrow(
        expect.objectContaining({
          name: "InvalidRequestError",
          message: "db is required",
        })
      );
      client.replyForm.mockRejectedValueOnce(new OpencodeHttpError(500, "/x"));
      await expect(
        orch.replyForm(project.id, "frm_1", {})
      ).rejects.toBeInstanceOf(OpencodeHttpError);
    });

    it("needs opencode running", async () => {
      const { orch, store } = setup();
      await orch.rescan();
      store.setSessions(project.id, [
        waiting({ permissions: [permission], forms: [] }),
      ]);
      await expect(
        orch.replyPermission(project.id, "per_1", { decision: "once" })
      ).rejects.toThrow(UnavailableError);
    });
  });
  describe("review", () => {
    const wt = "/workspaces/demo.worktrees/x";
    async function running() {
      const s = setup();
      await s.orch.rescan();
      await s.orch.start(project.id);
      s.store.updateRuntime(project.id, {
        worktrees: [{ path: wt, branch: "x" }],
      });
      return s;
    }

    it("describes publishing for the target, from the host path of a worktree", async () => {
      const { orch, publisher, store } = await running();
      store.updateRuntime(project.id, {
        worktrees: [
          { path: wt, branch: "x", hostPath: "/src/demo.worktrees/x" },
        ],
      });
      const info = await orch.publishInfo(project.id, wt, "origin");
      expect(publisher.info).toHaveBeenCalledWith(
        project,
        { container: wt, host: "/src/demo.worktrees/x" },
        "x",
        "origin"
      );
      expect(info.branch).toBe("x");
      await orch.publishInfo(project.id, "/workspaces/demo");
      expect(publisher.info).toHaveBeenLastCalledWith(
        project,
        { container: "/workspaces/demo", host: "/src/demo" },
        "main",
        undefined
      );
    });

    it("publishes the target's branch after validating the request", async () => {
      const { orch, publisher } = await running();
      const good = {
        remote: "origin",
        base: "main",
        strategy: "branch",
        title: " Add x ",
        description: "d",
      };
      const result = await orch.publish(project.id, wt, good);
      expect(publisher.publish.mock.calls[0][2]).toBe("x");
      expect(publisher.publish.mock.calls[0][3]).toEqual({
        remote: "origin",
        base: "main",
        strategy: "branch",
        title: "Add x",
        description: "d",
      });
      expect(result.openUrl).toContain("/compare/");
      expect(orch.logLines(project.id).join("\n")).toMatch(
        /review: publish x/u
      );
      for (const bad of [
        { ...good, remote: "--upload-pack=x" },
        { ...good, remote: "--force" },
        { ...good, base: "-x" },
        { ...good, strategy: "force" },
        { ...good, title: "  " },
        { ...good, title: "x".repeat(201) },
      ]) {
        await expect(orch.publish(project.id, wt, bad)).rejects.toThrow(
          InvalidRequestError
        );
      }
      await expect(
        orch.publish(project.id, wt, { ...good, base: "x" })
      ).rejects.toThrow(/not the base itself/u);
    });

    it("suggests a title and description from the latest session", async () => {
      const { orch, client, store } = await running();
      await expect(
        orch.publishSuggestion(project.id, wt)
      ).resolves.toStrictEqual({
        title: "",
        description: "",
      });
      store.setSessions(project.id, [
        {
          id: "ses_1",
          projectId: project.id,
          title: "t",
          directory: wt,
          updatedAt: 1,
          status: "idle",
        },
      ]);
      client.generate.mockResolvedValueOnce("Add login\n\nAdds the form.");
      await expect(
        orch.publishSuggestion(project.id, wt)
      ).resolves.toStrictEqual({
        title: "Add login",
        description: "Adds the form.",
      });
    });

    it("compares a worktree with its recorded base on request", async () => {
      const { orch, client, git } = await running();
      git.isClean.mockImplementation(
        async (_p, dir) => dir === "/workspaces/demo"
      );
      client.vcsStatus.mockResolvedValueOnce([{ file: "a.ts" }]);
      const r = await orch.review(project.id, wt, { mode: "branch" });
      expect(client.vcsDiff).toHaveBeenCalledWith(wt, "branch", "main");
      expect(git.aheadBehind).toHaveBeenCalledWith(project, wt, "main");
      expect(r).toMatchObject({
        directory: wt,
        branch: "x",
        base: { name: "main", source: "config" },
        mode: "branch",
        ahead: 2,
        behind: 1,
        dirty: true,
        pushed: false,
        workspace: { branch: "main", clean: true },
      });
      expect(r.files.map((f) => f.file)).toStrictEqual(["a.ts", "b.ts"]);
    });

    it("shows uncommitted changes by default, still resolving the base", async () => {
      const { orch, client, git } = await running();
      git.recordedBase.mockResolvedValue(undefined);
      const r = await orch.review(project.id, "/workspaces/demo");
      expect(r.base).toStrictEqual({ name: "main", source: "default" });
      expect(r.mode).toBe("working");
      expect(client.vcsDiff).toHaveBeenCalledWith(
        "/workspaces/demo",
        "working",
        undefined
      );
      const w = await orch.review(project.id, wt);
      expect(w).toMatchObject({
        mode: "working",
        base: { name: "main", source: "default" },
        ahead: 2,
      });
      expect(client.vcsDiff).toHaveBeenLastCalledWith(wt, "working", undefined);
    });

    it("takes a base override, returns one file on request, and rejects option-like bases and unknown folders", async () => {
      const { orch, client } = await running();
      const r = await orch.review(project.id, wt, {
        base: "develop",
        mode: "branch",
        file: "b.ts",
      });
      expect(client.vcsDiff).toHaveBeenLastCalledWith(wt, "branch", "develop");
      expect(r.base).toEqual({ name: "develop", source: "request" });
      expect(r.files.map((f) => f.file)).toStrictEqual(["b.ts"]);
      await expect(
        orch.review(project.id, wt, { base: "--upload-pack=evil" })
      ).rejects.toThrow(InvalidRequestError);
      await expect(orch.review(project.id, "/etc")).rejects.toThrow(
        InvalidRequestError
      );
    });

    it("shows what a session's turn changed, the newest by default, and lists its prompts", async () => {
      const { orch, client, store } = await running();
      const fallback = await orch.review(project.id, wt, { mode: "turn" });
      expect(fallback.mode).toBe("working");
      expect(fallback.turn).toBeUndefined();
      store.setSessions(project.id, [
        {
          id: "ses_old",
          projectId: project.id,
          title: "old",
          directory: wt,
          updatedAt: 1,
          status: "idle",
        },
        {
          id: "ses_new",
          projectId: project.id,
          title: "Login",
          directory: wt,
          updatedAt: 2,
          status: "running",
        },
      ]);
      const r = await orch.review(project.id, wt, { mode: "turn" });
      expect(client.sessionDiff).toHaveBeenLastCalledWith(
        "ses_new",
        { from: "msg_2" },
        wt
      );
      expect(r.mode).toBe("turn");
      expect(r.files.map((f) => f.file)).toStrictEqual(["c.ts"]);
      expect(r.turn).toStrictEqual({
        sessionId: "ses_new",
        sessionTitle: "Login",
        from: "msg_2",
        latest: true,
        running: true,
        prompts: [
          { id: "msg_2", text: "Now add tests", created: 2 },
          { id: "msg_1", text: "Fix the login", created: 1 },
        ],
      });
      const older = await orch.review(project.id, wt, {
        mode: "turn",
        session: "ses_old",
        from: "msg_1",
      });
      expect(client.sessionDiff).toHaveBeenLastCalledWith(
        "ses_old",
        { from: "msg_1" },
        wt
      );
      expect(older.turn).toMatchObject({ latest: false, running: false });
    });

    it("rejects a turn of another checkout's session, a bad turn id and a turn opencode doesn't have", async () => {
      const { orch, client, store } = await running();
      store.setSessions(project.id, [
        {
          id: "ses_main",
          projectId: project.id,
          title: "t",
          directory: "/workspaces/demo",
          updatedAt: 1,
          status: "idle",
        },
        {
          id: "ses_wt",
          projectId: project.id,
          title: "t",
          directory: wt,
          updatedAt: 1,
          status: "idle",
        },
      ]);
      await expect(
        orch.review(project.id, wt, { mode: "turn", session: "ses_main" })
      ).rejects.toThrow(NotFoundError);
      await expect(
        orch.review(project.id, wt, { mode: "turn", from: "msg_1&to=x" })
      ).rejects.toThrow(InvalidRequestError);
      client.sessionDiff.mockRejectedValueOnce(
        new OpencodeHttpError(404, "/api/session/ses_wt/diff")
      );
      await expect(
        orch.review(project.id, wt, { mode: "turn", from: "msg_1" })
      ).rejects.toThrow(/unknown turn msg_1/u);
      client.userMessages.mockResolvedValueOnce([]);
      const empty = await orch.review(project.id, wt, { mode: "turn" });
      expect(empty.files).toStrictEqual([]);
      expect(empty.turn).toMatchObject({ latest: true, prompts: [] });
    });

    it("details a session: its turns, tokens, subagents and its model's context window", async () => {
      const { orch, client, store } = await running();
      await expect(orch.sessionDetail(project.id, "ses_x")).rejects.toThrow(
        NotFoundError
      );
      store.setSessions(project.id, [
        {
          id: "ses_1",
          projectId: project.id,
          title: "Login",
          directory: wt,
          updatedAt: 5,
          status: "idle",
          model: { id: "m1", providerID: "p" },
        },
      ]);
      client.models.mockResolvedValueOnce([
        { id: "m1", providerID: "p", name: "M1", limit: { context: 200_000 } },
      ]);
      client.session.mockResolvedValueOnce({
        id: "ses_1",
        agent: "build",
        outcome: "succeeded",
        time: { created: 1, updated: 5 },
        location: { directory: wt },
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cache: { read: 3, write: 1 },
        },
      });
      client.sessions.mockResolvedValueOnce([
        {
          id: "ses_1",
          time: { created: 1, updated: 5 },
          location: { directory: wt },
        },
        {
          id: "ses_child",
          parentID: "ses_1",
          title: "Explore",
          cost: 0.5,
          time: { created: 2, updated: 3 },
          location: { directory: wt },
        },
      ]);
      client.messages.mockResolvedValueOnce([
        {
          id: "msg_2",
          type: "assistant",
          content: [{ type: "text", text: "Done." }],
          time: { created: 3, completed: 4 },
        },
        { id: "msg_1", type: "user", text: "Fix it", time: { created: 2 } },
      ]);
      const d = await orch.sessionDetail(project.id, "ses_1");
      expect(client.messages).toHaveBeenLastCalledWith("ses_1", 200);
      expect(d).toMatchObject({
        agent: "build",
        contextLimit: 200_000,
        createdAt: 1,
        more: false,
        outcome: "succeeded",
        subagents: [{ id: "ses_child", title: "Explore", cost: 0.5 }],
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cacheRead: 3,
          cacheWrite: 1,
        },
        turns: [
          { id: "msg_1", prompt: "Fix it", reply: "Done.", completed: 4 },
        ],
      });
      expect(d.session.title).toBe("Login");
    });

    it("prompts a session, queued while it runs, and starts a session with a first prompt", async () => {
      const { orch, client, store } = await running();
      store.setSessions(project.id, [
        {
          id: "ses_run",
          projectId: project.id,
          title: "t",
          directory: wt,
          updatedAt: 2,
          status: "running",
        },
        {
          id: "ses_idle",
          projectId: project.id,
          title: "t",
          directory: wt,
          updatedAt: 1,
          status: "idle",
        },
      ]);
      await orch.promptSession(project.id, "ses_run", "fix it");
      await orch.promptSession(project.id, "ses_idle", "fix it");
      expect(client.prompt.mock.calls).toStrictEqual([
        ["ses_run", "fix it", "queue", wt],
        ["ses_idle", "fix it", undefined, wt],
      ]);
      await expect(
        orch.promptSession(project.id, "ses_nope", "x")
      ).rejects.toThrow(NotFoundError);
      await expect(
        orch.promptSession(project.id, "ses_idle", "  ")
      ).rejects.toThrow(InvalidRequestError);
      const sid = await orch.startSession(
        project.id,
        wt,
        "Review",
        "please look"
      );
      expect(client.prompt).toHaveBeenLastCalledWith(
        sid,
        "please look",
        undefined,
        wt
      );
    });

    it("generates a commit message from the latest session, or returns an empty one", async () => {
      const { orch, client, store } = await running();
      await expect(orch.commitMessage(project.id, wt)).resolves.toBe("");
      store.setSessions(project.id, [
        {
          id: "ses_old",
          projectId: project.id,
          title: "t",
          directory: wt,
          updatedAt: 1,
          status: "idle",
        },
        {
          id: "ses_new",
          projectId: project.id,
          title: "t",
          directory: wt,
          updatedAt: 5,
          status: "idle",
        },
      ]);
      await expect(orch.commitMessage(project.id, wt)).resolves.toBe(
        "feat: do things"
      );
      expect(client.generate.mock.calls[0][0]).toBe("ses_new");
      client.generate.mockRejectedValueOnce(new Error("no model"));
      await expect(orch.commitMessage(project.id, wt)).resolves.toBe("");
    });

    it("generates in a given idle session of the checkout, or in a new one", async () => {
      const { orch, client, store } = await running();
      const session = {
        id: "ses_review",
        projectId: project.id,
        title: "AI review",
        directory: wt,
        updatedAt: 1,
        status: "running" as const,
      };
      store.setSessions(project.id, [session]);
      const options = {
        sessionId: "ses_review",
        title: "AI review",
        timeoutMs: 5,
      };
      await expect(
        orch.generateIn(project.id, wt, "findings?", options)
      ).rejects.toThrow(InvalidRequestError);
      await expect(
        orch.generateIn(project.id, wt, "findings?", {
          ...options,
          sessionId: "ses_x",
        })
      ).rejects.toThrow(/ses_x/u);
      store.setSessions(project.id, [{ ...session, status: "idle" }]);
      await expect(
        orch.generateIn(project.id, wt, "findings?", options)
      ).resolves.toEqual({ sessionId: "ses_review", text: "feat: do things" });
      expect(client.generate).toHaveBeenLastCalledWith(
        "ses_review",
        "findings?",
        wt,
        5
      );

      await expect(
        orch.generateIn(project.id, wt, "review the diff", {
          title: "AI review",
        })
      ).resolves.toEqual({ sessionId: "ses_new", text: "feat: do things" });
      expect(client.createSession).toHaveBeenLastCalledWith(wt, {
        title: "AI review",
      });
      expect(client.prompt).not.toHaveBeenCalled();
    });

    it("commits, refusing an empty message or a clean checkout", async () => {
      const { orch, git } = await running();
      await expect(orch.commit(project.id, wt, "  ")).rejects.toThrow(
        InvalidRequestError
      );
      await expect(orch.commit(project.id, wt, "feat: x")).rejects.toThrow(
        /nothing to commit/u
      );
      git.isClean.mockResolvedValue(false);
      await orch.commit(project.id, wt, " feat: x ");
      expect(git.commit).toHaveBeenCalledWith(project, wt, "feat: x");
      expect(orch.logLines(project.id).join("\n")).toMatch(/review: commit/u);
    });

    it("rebases an unpushed branch, merges a pushed one, and reports conflicts", async () => {
      const { orch, git } = await running();
      await expect(
        orch.updateFromBase(project.id, wt, "main")
      ).resolves.toStrictEqual({ strategy: "rebase" });
      git.isPushed.mockResolvedValue(true);
      git.update.mockResolvedValueOnce({
        strategy: "merge",
        conflicts: ["a.ts"],
      });
      await expect(
        orch.updateFromBase(project.id, wt, "main")
      ).resolves.toStrictEqual({ strategy: "merge", conflicts: ["a.ts"] });
      expect(orch.logLines(project.id).join("\n")).toMatch(
        /conflicts in a\.ts; aborted/u
      );
      await expect(orch.updateFromBase(project.id, wt, "-x")).rejects.toThrow(
        InvalidRequestError
      );
      git.isClean.mockResolvedValue(false);
      await expect(orch.updateFromBase(project.id, wt, "main")).rejects.toThrow(
        /uncommitted/u
      );
    });

    it("merges a clean worktree into a clean main checkout that is on the base", async () => {
      const { orch, git } = await running();
      await expect(
        orch.mergeIntoBase(project.id, wt, "main", false)
      ).resolves.toStrictEqual({ branch: "x" });
      expect(git.mergeInto).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        "x",
        false
      );
      await expect(
        orch.mergeIntoBase(project.id, "/workspaces/demo", "main", false)
      ).rejects.toThrow(/main checkout is the base/u);
      await expect(
        orch.mergeIntoBase(project.id, wt, "develop", false)
      ).rejects.toThrow(/is on main, not develop/u);
      git.isClean.mockImplementation(
        async (_p, dir) => dir !== "/workspaces/demo"
      );
      await expect(
        orch.mergeIntoBase(project.id, wt, "main", true)
      ).rejects.toThrow(/main checkout has uncommitted/u);
    });

    it("still refreshes the worktree list when deleting the branch fails", async () => {
      const { orch, git, worktrees, store } = await running();
      git.deleteBranch.mockRejectedValueOnce(
        new CommandError("git branch failed: not fully merged")
      );
      worktrees.list.mockResolvedValueOnce([]);
      await expect(
        orch.removeWorktree(project.id, wt, false, true)
      ).rejects.toThrow(/not fully merged/u);
      expect(store.runtime(project.id).worktrees).toStrictEqual([]);
    });

    it("removes a worktree and deletes its branch when asked", async () => {
      const { orch, git } = await running();
      await orch.removeWorktree(project.id, wt, false, true);
      expect(git.deleteBranch).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        "x"
      );
    });
  });

  describe("tasks", () => {
    async function started() {
      const s = setup();
      await s.orch.rescan();
      await s.orch.start(project.id);
      let n = 0;
      s.client.createSession.mockImplementation(async (directory: string) => ({
        id: `ses_${++n}`,
        location: { directory },
      }));
      return s;
    }

    it("associates each created worktree and session with its Jira ticket", async () => {
      const { orch, client, store } = await started();
      const jira = {
        key: "APP-12",
        instanceUrl: "https://jira.example.com",
        title: "Fix login",
        description: "Safari login must succeed.",
      };
      const prompt = `Implement APP-12: Fix login\n\n${jira.description}`;
      const result = await orch.createTask(project.id, {
        prompt,
        jira,
        variants: [{}, {}],
      });
      expect(
        result.variants.every((v) => v.directory && v.branch && v.sessionId)
      ).toBeTruthy();
      for (const [directory, options] of client.createSession.mock.calls) {
        expect(options?.metadata).toMatchObject({
          opendevhub: { task: result.task, jira },
        });
        expect(result.variants.some((v) => v.directory === directory)).toBe(
          true
        );
      }
      expect(store.startingTask(project.id, result.task)?.jira).toStrictEqual(
        jira
      );
      expect(
        client.prompt.mock.calls.every(([, text]) => text === prompt)
      ).toBeTruthy();
    });

    it("starts one variant in a new worktree named after the prompt, tagged with the task", async () => {
      const { orch, client, worktrees, git, monitors } = await started();
      git.localBranches.mockResolvedValueOnce(["main", "fix-the-login-bug"]);
      const res = await orch.createTask(project.id, {
        prompt: "Fix the login bug\nIt fails on Safari",
      });
      const dir = "/workspaces/demo.worktrees/fix-the-login-bug-2";
      expect(res.task).toMatch(/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u);
      expect(res.variants).toStrictEqual([
        { branch: "fix-the-login-bug-2", directory: dir, sessionId: "ses_1" },
      ]);
      expect(worktrees.add.mock.calls[0][1]).toMatchObject({
        branch: "fix-the-login-bug-2",
        base: undefined,
        workspaceFolder: "/workspaces/demo",
      });
      expect(client.createSession).toHaveBeenCalledWith(dir, {
        title: "Fix the login bug",
        metadata: {
          opendevhub: {
            task: res.task,
            variant: 1,
            of: 1,
            title: "Fix the login bug",
            branch: "fix-the-login-bug-2",
          },
        },
      });
      expect(client.prompt).toHaveBeenCalledWith(
        "ses_1",
        "Fix the login bug\nIt fails on Safari",
        undefined,
        dir
      );
      expect(monitors.at(-1)!.reconciled).toBeGreaterThan(0);
    });

    it("avoids branches checked out in worktrees too", async () => {
      const { orch, store } = await started();
      store.updateRuntime(project.id, {
        worktrees: [
          { path: "/workspaces/demo.worktrees/ship", branch: "ship" },
        ],
      });
      const res = await orch.createTask(project.id, { prompt: "Ship" });
      expect(res.variants[0].branch).toBe("ship-2");
    });

    it("runs in the main checkout without a worktree", async () => {
      const { orch, client, worktrees } = await started();
      const res = await orch.createTask(project.id, {
        prompt: "Explain the build",
        where: "workspace",
        variants: [{ agent: "plan" }],
      });
      expect(res.variants).toStrictEqual([
        { directory: "/workspaces/demo", sessionId: "ses_1" },
      ]);
      expect(worktrees.add).not.toHaveBeenCalled();
      expect(client.createSession.mock.calls[0][1]).toMatchObject({
        agent: "plan",
        title: "Explain the build",
      });
    });

    it("runs several variants, one worktree each, and keeps going when one fails", async () => {
      const { orch, client, worktrees } = await started();
      client.createSession
        .mockImplementationOnce(async (directory: string) => ({
          id: "ses_a",
          location: { directory },
        }))
        .mockRejectedValueOnce(
          new OpencodeHttpError(
            400,
            "/api/session",
            "ModelNotFoundError",
            "unknown model b"
          )
        );
      const res = await orch.createTask(project.id, {
        prompt: "Add caching",
        branch: "cache",
        base: "develop",
        variants: [
          { model: { id: "a", providerID: "p" } },
          { model: { id: "b", providerID: "p" } },
          { model: { id: "c", providerID: "p" } },
        ],
      });
      expect(res.variants.map((v) => v.branch)).toStrictEqual([
        "cache-a",
        "cache-b",
        "cache-c",
      ]);
      expect(res.variants.map((v) => v.sessionId)).toStrictEqual([
        "ses_a",
        undefined,
        "ses_1",
      ]);
      expect(res.variants[1].error).toMatch(/unknown model b/u);
      expect(res.variants[1].directory).toBe(
        "/workspaces/demo.worktrees/cache-b"
      );
      expect(worktrees.add.mock.calls.map((c) => c[1].base)).toStrictEqual([
        "develop",
        "develop",
        "develop",
      ]);
      expect(
        client.createSession.mock.calls.map((c) => c[1]?.title)
      ).toStrictEqual([
        "Add caching · a",
        "Add caching · b",
        "Add caching · c",
      ]);
      expect(client.createSession.mock.calls[2][1]).toMatchObject({
        model: { id: "c", providerID: "p" },
        metadata: {
          opendevhub: {
            task: res.task,
            variant: 3,
            of: 3,
            title: "Add caching",
            branch: "cache-c",
          },
        },
      });
      expect(client.prompt).toHaveBeenCalledTimes(2);
      expect(orch.logLines(project.id).join("\n")).toMatch(
        /variant 2 \(cache-b\) failed/u
      );
    });

    it("records a failed worktree on its variant and still refreshes the list", async () => {
      const { orch, worktrees, store } = await started();
      worktrees.add.mockRejectedValueOnce(
        new CommandError("git worktree failed: invalid reference: nope", [
          "fatal: invalid reference: nope",
        ])
      );
      worktrees.list.mockResolvedValueOnce([
        { path: "/workspaces/demo.worktrees/x-2", branch: "x-2" },
      ]);
      const res = await orch.createTask(project.id, {
        prompt: "x",
        variants: [{}, {}],
      });
      expect(res.variants[0]).toStrictEqual({
        branch: "x-1",
        error: "git worktree failed: invalid reference: nope",
      });
      expect(res.variants[1]).toMatchObject({
        branch: "x-2",
        sessionId: "ses_1",
      });
      expect(store.runtime(project.id).worktrees).toStrictEqual([
        { path: "/workspaces/demo.worktrees/x-2", branch: "x-2" },
      ]);
      expect(orch.logLines(project.id)).toContain(
        "fatal: invalid reference: nope"
      );
    });

    it("falls back to the known worktrees plus the new ones when the list fails", async () => {
      const { orch, worktrees, store } = await started();
      store.updateRuntime(project.id, {
        worktrees: [{ path: "/workspaces/demo.worktrees/old", branch: "old" }],
      });
      worktrees.list.mockRejectedValueOnce(new Error("git down"));
      const res = await orch.createTask(project.id, {
        prompt: "x",
        variants: [{}, {}],
      });
      expect(res.variants.map((v) => v.sessionId)).toStrictEqual([
        "ses_1",
        "ses_2",
      ]);
      expect(store.runtime(project.id).worktrees).toStrictEqual([
        { path: "/workspaces/demo.worktrees/old", branch: "old" },
        { path: "/workspaces/demo.worktrees/x-1", branch: "x-1" },
        { path: "/workspaces/demo.worktrees/x-2", branch: "x-2" },
      ]);
    });

    it("rejects a generated branch git would refuse before touching git", async () => {
      const { orch, worktrees } = await started();
      // 95 + "-model-a" = 103 characters, over validateBranch's 100.
      const long = "b".repeat(95);
      await expect(
        orch.createTask(project.id, {
          prompt: "x",
          branch: long,
          variants: [
            { model: { id: "model-a", providerID: "p" } },
            { model: { id: "model-b", providerID: "p" } },
          ],
        })
      ).rejects.toThrow(InvalidRequestError);
      expect(worktrees.add).not.toHaveBeenCalled();
    });

    it("integration: tags every session through the real client against fake opencode, and survives a rejected model", async () => {
      const fake = await startFakeOpencode("pw", { rejectModels: ["b"] });
      try {
        const s = setup();
        s.clientFor.mockImplementation(
          () => new OpencodeClient({ baseUrl: fake.baseUrl, password: "pw" })
        );
        await s.orch.rescan();
        await s.orch.start(project.id);
        const jira = {
          key: "APP-12",
          instanceUrl: "https://jira.example.com",
          title: "Login",
          description: "Fix login in Safari.",
        };
        const res = await s.orch.createTask(project.id, {
          prompt: "Go",
          jira,
          variants: [
            { model: { id: "a", providerID: "p" } },
            { model: { id: "b", providerID: "p" } },
            { model: { id: "c", providerID: "p" } },
          ],
        });
        expect(res.variants.map((v) => Boolean(v.sessionId))).toStrictEqual([
          true,
          false,
          true,
        ]);
        expect(res.variants[1].error).toMatch(
          /ModelNotFoundError: unknown model b/u
        );
        // The fake prepends new sessions: c, then a.
        expect(fake.state.sessions.map((x) => x.metadata)).toStrictEqual([
          {
            opendevhub: {
              task: res.task,
              variant: 3,
              of: 3,
              title: "Go",
              jira,
              branch: "go-c",
            },
          },
          {
            opendevhub: {
              task: res.task,
              variant: 1,
              of: 3,
              title: "Go",
              jira,
              branch: "go-a",
            },
          },
        ]);
        // A new dashboard client recovers the originating ticket from persisted session metadata.
        const restored = await new OpencodeClient({
          baseUrl: fake.baseUrl,
          password: "pw",
        }).sessions();
        expect(
          restored.map((session) => parseTaskMeta(session.metadata)?.jira)
        ).toStrictEqual([jira, jira]);
        expect(fake.state.sessions.map((x) => x.model?.id)).toStrictEqual([
          "c",
          "a",
        ]);
        expect(
          fake.state.prompts.map((p) => [
            p.sessionId,
            (p.body as { text: string }).text,
            p.directory,
          ])
        ).toStrictEqual([
          [res.variants[0].sessionId, "Go", "/workspaces/demo.worktrees/go-a"],
          [res.variants[2].sessionId, "Go", "/workspaces/demo.worktrees/go-c"],
        ]);
      } finally {
        await fake.close();
      }
    });

    it("validates the request, holds the git lock, and needs the worktrees mount and opencode", async () => {
      const { orch, store, worktrees } = await started();
      await expect(
        orch.createTask(project.id, { prompt: " " })
      ).rejects.toThrow(InvalidRequestError);
      await expect(
        orch.createTask(project.id, {
          prompt: "x",
          where: "workspace",
          variants: [{}, {}],
        })
      ).rejects.toThrow(InvalidRequestError);

      let release!: () => void;
      worktrees.add.mockImplementationOnce(
        (_p, a) =>
          new Promise(
            (r) =>
              (release = () =>
                r({ path: `${a.root.container}/y`, branch: "y" }))
          )
      );
      const first = orch.createTask(project.id, { prompt: "y" });
      await vi.waitFor(() => expect(release).toBeDefined());
      // A second task waits for the lock instead of failing; other git work still says busy.
      const second = orch.createTask(project.id, { prompt: "z" });
      expect(() => orch.createWorktree(project.id, { branch: "z" })).toThrow(
        BusyError
      );
      release();
      await first;
      expect((await second).variants[0]).toMatchObject({
        branch: "z",
        sessionId: expect.any(String),
      });

      store.updateRuntime(project.id, {
        worktreeRoot: { host: "/h", container: "/c", mounted: false },
      });
      await expect(
        orch.createTask(project.id, { prompt: "x" })
      ).rejects.toThrow(UnavailableError);
      store.updateRuntime(project.id, { opencode: "unhealthy" });
      await expect(
        orch.createTask(project.id, { prompt: "x", where: "workspace" })
      ).rejects.toThrow(UnavailableError);
    });

    it("starts a session with a first prompt when creating a worktree", async () => {
      const { orch, client, worktrees } = await started();
      worktrees.list.mockResolvedValue([
        { path: "/workspaces/demo.worktrees/feature-y", branch: "feature/y" },
      ]);
      const res = await orch.createWorktree(project.id, {
        branch: "feature/y",
        startSession: true,
        prompt: "Write docs",
      });
      expect(client.prompt).toHaveBeenCalledWith(
        res.sessionId,
        "Write docs",
        undefined,
        res.worktree.path
      );
    });

    it("lists models and agents without provider settings, cached for a minute", async () => {
      const { orch, client, clock } = await started();
      client.models.mockResolvedValue([
        {
          id: "m1",
          providerID: "p",
          name: "M1",
          enabled: true,
          variants: [{ id: "high" }],
          settings: { apiKey: "secret" },
        } as RawModel,
      ]);
      const info = await orch.models(project.id);
      expect(info).toStrictEqual({
        models: [{ id: "m1", providerID: "p", name: "M1", variants: ["high"] }],
        default: { id: "m1", providerID: "p" },
        agents: [{ id: "build", name: "Build" }],
      });
      expect(JSON.stringify(info)).not.toContain("secret");
      expect(client.models).toHaveBeenCalledWith("/workspaces/demo");
      await orch.models(project.id);
      expect(client.models).toHaveBeenCalledOnce();
      clock.now += 60_001;
      await orch.models(project.id);
      expect(client.models).toHaveBeenCalledTimes(2);
    });

    it("retries once when a fresh opencode answers empty", async () => {
      const { orch, client, delay } = await started();
      client.models.mockResolvedValueOnce([]);
      client.agents.mockResolvedValueOnce([]);
      const info = await orch.models(project.id);
      expect(info.models).toStrictEqual([
        { id: "m1", providerID: "p", name: "M1", variants: [] },
      ]);
      expect(info.agents).toStrictEqual([{ id: "build", name: "Build" }]);
      expect(client.models).toHaveBeenCalledTimes(2);
      expect(delay).toHaveBeenCalledWith(1500);
    });

    it("never caches a list that is still empty after the retry", async () => {
      const { orch, client } = await started();
      client.models.mockResolvedValue([]);
      client.agents.mockResolvedValue([]);
      client.defaultModel.mockResolvedValue(undefined);
      await expect(orch.models(project.id)).resolves.toStrictEqual({
        models: [],
        agents: [],
      });
      expect(client.models).toHaveBeenCalledTimes(2);
      await orch.models(project.id);
      expect(client.models).toHaveBeenCalledTimes(4);
    });

    it("does not cache a failed model lookup, and forgets the cache when opencode restarts", async () => {
      const { orch, client } = await started();
      client.models.mockRejectedValueOnce(new Error("boom"));
      await expect(orch.models(project.id)).rejects.toThrow("boom");
      await orch.models(project.id);
      await orch.restartOpencode(project.id);
      await orch.models(project.id);
      expect(client.models).toHaveBeenCalledTimes(3);
    });

    const variant = (
      id: string,
      n: number,
      directory: string,
      branch?: string,
      status: SessionSummary["status"] = "idle"
    ): SessionSummary => ({
      id,
      projectId: project.id,
      title: `Fix · #${n}`,
      directory,
      updatedAt: n,
      status,
      task: {
        task: "tsk_1",
        variant: n,
        of: 3,
        title: "Fix",
        ...(branch ? { branch } : {}),
      },
    });

    it("keeps one variant: discards the others without losing their metadata, then removes their worktrees and branches", async () => {
      const { orch, client, worktrees, git, store } = await started();
      const dirs = [
        "/workspaces/demo.worktrees/fix-1",
        "/workspaces/demo.worktrees/fix-2",
        "/workspaces/demo.worktrees/fix-3",
      ];
      store.updateRuntime(project.id, {
        worktrees: dirs.map((path, i) => ({ path, branch: `fix-${i + 1}` })),
      });
      store.setSessions(project.id, [
        variant("s1", 1, dirs[0], "fix-1"),
        variant("s2", 2, dirs[1], "fix-2"),
        variant("s3", 3, dirs[2], "fix-3"),
        {
          id: "other",
          projectId: project.id,
          title: "x",
          directory: dirs[2],
          updatedAt: 9,
          status: "idle",
        },
      ]);
      client.session.mockImplementation(async (sid: string) => ({
        id: sid,
        time: { created: 1, updated: 1 },
        location: { directory: "/w" },
        metadata: {
          keep: sid,
          opendevhub: { task: "tsk_1", variant: 1, of: 3, title: "Fix" },
        },
      }));
      worktrees.list.mockResolvedValueOnce([
        { path: dirs[1], branch: "fix-2" },
        { path: dirs[2], branch: "fix-3" },
      ]);

      const res = await orch.pickVariant(project.id, "tsk_1", "s2", true);

      expect(res).toStrictEqual({
        discarded: ["s1", "s3"],
        removed: [dirs[0]],
        errors: [],
      });
      expect(client.updateSession).toHaveBeenCalledWith(
        "s1",
        {
          metadata: {
            keep: "s1",
            opendevhub: {
              task: "tsk_1",
              variant: 1,
              of: 3,
              title: "Fix",
              discarded: true,
            },
          },
        },
        dirs[0]
      );
      expect(worktrees.remove).toHaveBeenCalledOnce(); // fix-3 still hosts another session
      expect(worktrees.remove).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        dirs[0],
        true
      );
      expect(git.deleteBranch).toHaveBeenCalledWith(
        project,
        "/workspaces/demo",
        "fix-1",
        true
      );
      expect(
        store.runtime(project.id).worktrees?.map((w) => w.branch)
      ).toStrictEqual(["fix-2", "fix-3"]);
    });

    it("only discards when worktrees should stay, and reports what failed", async () => {
      const { orch, client, worktrees, store } = await started();
      store.setSessions(project.id, [
        variant("s1", 1, "/workspaces/demo"),
        variant("s2", 2, "/workspaces/demo"),
      ]);
      client.updateSession.mockRejectedValueOnce(new Error("opencode down"));
      await expect(
        orch.pickVariant(project.id, "tsk_1", "s2", false)
      ).resolves.toStrictEqual({
        discarded: [],
        removed: [],
        errors: ["Fix · #1: opencode down"],
      });
      expect(worktrees.remove).not.toHaveBeenCalled();
      await expect(
        orch.pickVariant(project.id, "tsk_1", "nope", false)
      ).rejects.toThrow(NotFoundError);
    });

    it("removes nothing for variants in the main checkout, in unknown folders, or whose discard failed", async () => {
      const { orch, client, worktrees, git, store } = await started();
      const known = [
        "/workspaces/demo.worktrees/s3",
        "/workspaces/demo.worktrees/s4",
      ];
      store.updateRuntime(project.id, {
        worktrees: [
          { path: "/workspaces/demo", branch: "main" },
          ...known.map((path) => ({ path, branch: path.split("/").at(-1) })),
        ],
      });
      store.setSessions(project.id, [
        variant("s1", 1, "/workspaces/demo"),
        variant("s2", 2, "/workspaces/elsewhere"),
        variant("s3", 3, known[0]),
        variant("s4", 4, known[1]),
      ]);
      client.session.mockResolvedValue({
        id: "x",
        time: { created: 1, updated: 1 },
        location: { directory: "/w" },
        metadata: {},
      });
      client.updateSession.mockImplementation(async (sid: string) => {
        if (sid === "s3") {
          throw new Error("boom");
        }
      });
      const res = await orch.pickVariant(project.id, "tsk_1", "s4", true);
      expect(res).toStrictEqual({
        discarded: ["s1", "s2"],
        removed: [],
        errors: ["Fix · #3: boom"],
      });
      expect(worktrees.remove).not.toHaveBeenCalled();
      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it("keeps going when one worktree can't be removed", async () => {
      const { orch, worktrees, store } = await started();
      const dirs = [
        "/workspaces/demo.worktrees/a",
        "/workspaces/demo.worktrees/b",
        "/workspaces/demo.worktrees/c",
      ];
      store.updateRuntime(project.id, {
        worktrees: dirs.map((path) => ({
          path,
          branch: path.split("/").at(-1),
        })),
      });
      store.setSessions(
        project.id,
        dirs.map((d, i) => variant(`s${i + 1}`, i + 1, d, d.split("/").at(-1)))
      );
      worktrees.remove.mockRejectedValueOnce(
        new CommandError("git worktree failed: locked", ["fatal: locked"])
      );
      const res = await orch.pickVariant(project.id, "tsk_1", "s3", true);
      expect(res.removed).toStrictEqual([dirs[1]]);
      expect(res.errors).toStrictEqual(["a: git worktree failed: locked"]);
    });

    describe("picking: running variants, foreign branches, races", () => {
      const dirs = [
        "/workspaces/demo.worktrees/fix-1",
        "/workspaces/demo.worktrees/fix-2",
        "/workspaces/demo.worktrees/fix-3",
      ];
      const rawOf = (metadata: Record<string, unknown> = {}) => ({
        id: "x",
        time: { created: 1, updated: 1 },
        location: { directory: "/w" },
        metadata,
      });

      it("interrupts discarded variants that are not idle, before removing any worktree", async () => {
        const { orch, client, worktrees, store } = await started();
        store.updateRuntime(project.id, {
          worktrees: dirs.map((path, i) => ({ path, branch: `fix-${i + 1}` })),
        });
        store.setSessions(project.id, [
          variant("s1", 1, dirs[0], "fix-1", "running"),
          variant("s2", 2, dirs[1], "fix-2"),
          variant("s3", 3, dirs[2], "fix-3", "idle"),
        ]);
        client.session.mockResolvedValue(rawOf());
        const order: string[] = [];
        client.interrupt.mockImplementation(
          async (sid: string) => void order.push(`interrupt ${sid}`)
        );
        worktrees.remove.mockImplementation(
          async () => void order.push("remove")
        );
        await orch.pickVariant(project.id, "tsk_1", "s2", true);
        expect(client.interrupt).toHaveBeenCalledOnce();
        expect(client.interrupt).toHaveBeenCalledWith("s1", dirs[0]);
        expect(order).toStrictEqual(["interrupt s1", "remove", "remove"]);
      });

      it("reports a failed interrupt without undoing the discard or stopping the removal", async () => {
        const { orch, client, worktrees, store } = await started();
        store.updateRuntime(project.id, {
          worktrees: dirs.map((path, i) => ({ path, branch: `fix-${i + 1}` })),
        });
        store.setSessions(project.id, [
          variant("s1", 1, dirs[0], "fix-1", "running"),
          variant("s2", 2, dirs[1], "fix-2"),
          variant("s3", 3, dirs[2], "fix-3", "running"),
        ]);
        client.session.mockResolvedValue(rawOf());
        client.interrupt.mockRejectedValueOnce(new Error("nope"));
        const res = await orch.pickVariant(project.id, "tsk_1", "s2", true);
        expect(res.discarded).toStrictEqual(["s1", "s3"]);
        expect(res.errors).toStrictEqual(["Fix · #1: nope"]);
        expect(res.removed).toStrictEqual([dirs[0], dirs[2]]);
        expect(worktrees.remove).toHaveBeenCalledTimes(2);
      });

      it("deletes a branch only when it is the one the task created; otherwise keeps it and says so", async () => {
        const { orch, client, worktrees, git, store } = await started();
        store.updateRuntime(project.id, {
          worktrees: [
            { path: dirs[0], branch: "fix-1" },
            { path: dirs[1], branch: "fix-2" },
            { path: dirs[2], branch: "switched" },
          ],
        });
        store.setSessions(project.id, [
          variant("s1", 1, dirs[0], "fix-1"),
          variant("s2", 2, dirs[1], "fix-2"),
          variant("s3", 3, dirs[2], "fix-3"),
        ]);
        client.session.mockResolvedValue(rawOf());
        const res = await orch.pickVariant(project.id, "tsk_1", "s2", true);
        expect(res.removed).toStrictEqual([dirs[0], dirs[2]]);
        expect(worktrees.remove).toHaveBeenCalledTimes(2);
        expect(git.deleteBranch).toHaveBeenCalledOnce();
        expect(git.deleteBranch).toHaveBeenCalledWith(
          project,
          "/workspaces/demo",
          "fix-1",
          true
        );
        expect(res.errors).toStrictEqual([
          "switched: kept — not created by this task",
        ]);
      });

      it("keeps the branch of a legacy variant without recorded branch", async () => {
        const { orch, client, git, store } = await started();
        store.updateRuntime(project.id, {
          worktrees: dirs.map((path, i) => ({ path, branch: `fix-${i + 1}` })),
        });
        store.setSessions(project.id, [
          variant("s1", 1, dirs[0]),
          variant("s2", 2, dirs[1], "fix-2"),
        ]);
        client.session.mockResolvedValue(rawOf());
        const res = await orch.pickVariant(project.id, "tsk_1", "s2", true);
        expect(res.removed).toStrictEqual([dirs[0]]);
        expect(git.deleteBranch).not.toHaveBeenCalled();
        expect(res.errors).toStrictEqual([
          "fix-1: kept — not created by this task",
        ]);
      });

      it("refuses to pick a variant that a concurrent pick already discarded", async () => {
        const { orch, client, store } = await started();
        store.setSessions(project.id, [
          variant("s1", 1, "/workspaces/demo"),
          variant("s2", 2, "/workspaces/demo"),
        ]);
        client.session.mockResolvedValue(
          rawOf({
            opendevhub: {
              task: "tsk_1",
              variant: 2,
              of: 3,
              title: "Fix",
              discarded: true,
            },
          })
        );
        await expect(
          orch.pickVariant(project.id, "tsk_1", "s2", true)
        ).rejects.toThrow(InvalidRequestError);
        expect(client.updateSession).not.toHaveBeenCalled();
      });

      it("counts a removed worktree as removed when only its branch delete fails", async () => {
        const { orch, client, git, store } = await started();
        store.updateRuntime(project.id, {
          worktrees: dirs.map((path, i) => ({ path, branch: `fix-${i + 1}` })),
        });
        store.setSessions(project.id, [
          variant("s1", 1, dirs[0], "fix-1"),
          variant("s2", 2, dirs[1], "fix-2"),
        ]);
        client.session.mockResolvedValue(rawOf());
        git.deleteBranch.mockRejectedValueOnce(new Error("not fully merged"));
        const res = await orch.pickVariant(project.id, "tsk_1", "s2", true);
        expect(res.removed).toStrictEqual([dirs[0]]);
        expect(res.errors).toStrictEqual([
          "fix-1: worktree removed, branch kept: not fully merged",
        ]);
      });
    });
  });
});

describe("task environments", () => {
  it("retains the ticket in isolated task sessions too", async () => {
    const s = await withWorktree();
    const jira = {
      key: "APP-12",
      instanceUrl: "https://jira.example.com",
      title: "Fix login",
      description: "Safari login must succeed.",
    };
    const result = await s.orch.createTask(project.id, {
      prompt: "Fix login",
      jira,
      environment: "isolated",
      variants: [{}],
    });
    expect(result.variants[0].envId).toBeDefined();
    expect(s.client.createSession.mock.calls[0][1]?.metadata).toMatchObject({
      opendevhub: { jira },
    });
  });

  it("starts each variant of an isolated task in its own container", async () => {
    const s = await withWorktree();
    const r = await s.orch.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      where: "worktree",
      environment: "isolated",
      variants: [{}, {}],
    });
    expect(r.variants.map((v) => v.branch)).toStrictEqual(["iso-1", "iso-2"]);
    expect(r.variants.every((v) => v.envId && v.sessionId && !v.error)).toBe(
      true
    );
    expect(new Set(r.variants.map((v) => v.envId)).size).toBe(2);
    expect(s.images.ensureBase).toHaveBeenCalledTimes(2);
    expect(
      s.client.createSession.mock.calls.map((c) => c[0]).sort()
    ).toStrictEqual([
      "/workspaces/demo.worktrees/iso-1",
      "/workspaces/demo.worktrees/iso-2",
    ]);
    expect(
      s.store
        .environments(project.id)
        .map((e) => e.worktree.branch)
        .sort()
    ).toStrictEqual(["iso-1", "iso-2"]);
  });

  it("brings task containers up one at a time (concurrent devcontainer up calls race in the CLI)", async () => {
    const s = await withWorktree();
    let active = 0;
    let most = 0;
    const plain = s.containers.up.getMockImplementation()!;
    s.containers.up.mockImplementation(async (t, o) => {
      if (!t.idLabels) {
        return plain(t, o);
      }
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return plain(t, o);
    });
    const r = await s.orch.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      environment: "isolated",
      variants: [{}, {}, {}],
    });
    expect(r.variants.every((v) => v.envId && !v.error)).toBeTruthy();
    expect(most).toBe(1);
  });

  it("uses the project's default when the task doesn't choose", async () => {
    const s = setup();
    s.projectSettings.mockReturnValue({ isolation: "isolated" });
    await s.orch.rescan();
    await s.orch.start(project.id);
    const r = await s.orch.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      variants: [{}],
    });
    expect(r.variants[0].envId).toBeDefined();
    const shared = await s.orch.createTask(project.id, {
      prompt: "Do it",
      title: "Sh",
      environment: "shared",
      variants: [{}],
    });
    expect(shared.variants[0].envId).toBeUndefined();
  });

  it("runs an isolated task shared, and says why, when the project can't isolate", async () => {
    const s = setup();
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: { appPort: 1 },
    });
    await s.orch.rescan();
    await s.orch.start(project.id);
    const r = await s.orch.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      environment: "isolated",
      variants: [{}],
    });
    expect(r.variants[0]).toMatchObject({
      sessionId: "ses_new",
      notice: expect.stringMatching(/shared container: appPort/u),
    });
    expect(r.variants[0].envId).toBeUndefined();
  });

  it("keeps the worktree of a variant whose container didn't start", async () => {
    const s = await withWorktree();
    s.images.ensureBase.mockRejectedValueOnce(
      new CommandError("devcontainer build failed: boom")
    );
    const r = await s.orch.createTask(project.id, {
      prompt: "Do it",
      title: "Iso",
      environment: "isolated",
      variants: [{}],
    });
    expect(r.variants[0].error).toMatch(
      /its container did not start: devcontainer build failed: boom/u
    );
    expect(r.variants[0].directory).toBe("/workspaces/demo.worktrees/iso");
    expect(s.worktrees.remove).not.toHaveBeenCalled();
  });

  it("removes a worktree's container before the worktree, and keeps the worktree when that fails", async () => {
    const { orch, containers, worktrees, store, envId } = await withEnv();
    containers.remove.mockRejectedValueOnce(
      new CommandError("docker rm failed: busy")
    );
    await expect(
      orch.removeWorktree(project.id, feat.path, false)
    ).rejects.toThrow(/kept the worktree/u);
    expect(worktrees.remove).not.toHaveBeenCalled();
    await orch.removeWorktree(project.id, feat.path, false);
    expect(containers.remove.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      worktrees.remove.mock.invocationCallOrder[0]
    );
    expect(store.environment(envId)).toBeUndefined();
  });

  it("Pick removes a discarded variant's container with its worktree", async () => {
    const { orch, store, containers, envId } = await withEnv();
    const meta = (variant: number, branch?: string) => ({
      task: "tsk_1",
      variant,
      of: 2,
      title: "T",
      ...(branch ? { branch } : {}),
    });
    store.setSessions(project.id, [
      {
        id: "ses_keep",
        projectId: project.id,
        title: "T",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "idle",
        task: meta(1),
      },
    ]);
    store.setSessions(envId, [
      {
        id: "ses_drop",
        projectId: project.id,
        envId,
        title: "T",
        directory: feat.path,
        updatedAt: 1,
        status: "idle",
        task: meta(2, "feat"),
      },
    ]);
    const r = await orch.pickVariant(project.id, "tsk_1", "ses_keep", true);
    expect(r).toStrictEqual({
      discarded: ["ses_drop"],
      removed: [feat.path],
      errors: [],
    });
    expect(containers.remove).toHaveBeenCalledWith("c2");
    expect(store.environment(envId)).toBeUndefined();
  });

  it("gives a worktree its own container from the base image", async () => {
    const {
      orch,
      store,
      containers,
      images,
      envFiles,
      runtime,
      forwarder,
      monitors,
      envId,
    } = await withEnv();
    expect(envId).toBe(featEnv);
    expect(store.environment(envId)).toMatchObject({
      projectId: project.id,
      worktree: feat,
      image: { ref: `opendevhub/${project.id}:kkkkkkkkkkkk-base` },
    });
    expect(images.ensureBase.mock.calls[0].slice(0, 3)).toStrictEqual([
      project,
      feat,
      [],
    ]);
    expect(containers.readConfig).toHaveBeenCalledWith(feat.hostPath);
    const written = envFiles.write.mock.calls[0][1];
    expect(written).toMatchObject({
      image: `opendevhub/${project.id}:kkkkkkkkkkkk-base`,
      workspaceFolder: feat.path,
      mounts: ["type=bind,source=/src/demo/.git,target=/workspaces/demo/.git"],
    });
    expect(written).not.toHaveProperty("postCreateCommand");
    expect(containers.up.mock.calls.at(-1)![0]).toStrictEqual({
      id: envId,
      path: feat.hostPath,
      idLabels: [
        `opendevhub.env=${envId}`,
        `opendevhub.env-project=${project.id}`,
      ],
      overrideConfig: `/state/envs/${envId}/devcontainer.json`,
    });
    expect(containers.up.mock.calls.at(-1)![1].mounts).toStrictEqual([
      `type=volume,source=opendevhub-opencode-${envId},target=/opendevhub/opencode`,
    ]);
    expect(containers.ensureVolume).toHaveBeenCalledWith(
      `opendevhub-opencode-${envId}`,
      [
        "opendevhub.volume=opencode",
        `opendevhub.env=${envId}`,
        `opendevhub.env-project=${project.id}`,
      ]
    );
    expect(runtime.ensureRunning.mock.calls.at(-1)![1]).toMatchObject({
      address: { host: "172.17.0.10", port: 4096 },
      containerId: "c2",
      workspaceFolder: feat.path,
    });
    expect(forwarder.open.mock.calls.at(-1)![0]).toBe(envId);
    expect(monitors.at(-1)!.opts).toMatchObject({
      envId,
      projectId: project.id,
      directory: feat.path,
    });
    expect(monitors.at(-1)!.opts.extraDirectories).toBeUndefined();
    expect(orch.opencodeAddress(envId)).toStrictEqual({
      host: "172.17.0.10",
      port: 4096,
    });
    expect(store.runtime(project.id).containerId).toBe("c1");
  });

  it("keeps listing sessions the project's opencode ran in a worktree before it got its own container", async () => {
    const { monitors } = await withEnv();
    expect(monitors[0].opts.extraDirectories!()).toStrictEqual([feat.path]);
  });

  it("records why a worktree's config can't get its own container", async () => {
    const s = await withWorktree();
    s.containers.readConfig.mockResolvedValueOnce({
      configuration: { dockerComposeFile: "c.yml" },
      workspaceFolder: "/workspaces/feat",
    });
    const { envId } = await s.orch.createEnv(project.id, feat.path);
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).containerState).toBe("error")
    );
    expect(s.store.runtime(envId).error).toMatch(/Docker Compose/u);
    expect(s.containers.up).toHaveBeenCalledOnce();
  });

  it("refuses its own container when the project's config can't run one per worktree", async () => {
    const s = setup();
    s.worktrees.list.mockResolvedValue([feat]);
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: { appPort: 3000 },
    });
    await s.orch.rescan();
    await s.orch.start(project.id);
    expect(s.store.isolation(project.id)).toStrictEqual({
      default: "shared",
      unsupported: expect.stringMatching(/appPort/u),
    });
    await expect(
      s.orch.createEnv(project.id, feat.path)
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("reads the isolation default from devcontainer.json, with config.json taking precedence", async () => {
    const s = setup();
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: {
        customizations: { opendevhub: { isolation: "isolated" } },
      },
    });
    await s.orch.rescan();
    await s.orch.start(project.id);
    expect(s.store.isolation(project.id)).toStrictEqual({
      default: "isolated",
    });
    s.projectSettings.mockReturnValue({ isolation: "shared" });
    await s.orch.rebuild(project.id);
    expect(s.store.isolation(project.id)).toStrictEqual({ default: "shared" });
  });

  it("only gives known worktrees in the mounted folder their own container, while the project runs", async () => {
    const s = await withWorktree();
    await expect(
      s.orch.createEnv(project.id, "/elsewhere")
    ).rejects.toBeInstanceOf(InvalidRequestError);
    s.store.updateRuntime(project.id, {
      worktrees: [{ path: "/tmp/wt", branch: "x" }],
    });
    await expect(s.orch.createEnv(project.id, "/tmp/wt")).rejects.toThrow(
      /mounted worktrees folder/u
    );
    await s.orch.stop(project.id);
    await expect(
      s.orch.createEnv(project.id, feat.path)
    ).rejects.toBeInstanceOf(UnavailableError);
  });

  it("stops a task container on its own, and together with the project", async () => {
    const { orch, store, containers, envId } = await withEnv();
    store.setSessions(envId, [
      {
        id: "t",
        projectId: project.id,
        envId,
        title: "t",
        directory: feat.path,
        updatedAt: 1,
        status: "idle",
      },
    ]);
    await orch.stopEnv(project.id, envId);
    expect(containers.stop).toHaveBeenCalledWith("c2");
    expect(store.runtime(envId).containerState).toBe("stopped");
    expect(store.sessionsOf(project.id).map((s) => s.id)).not.toContain("t");
    expect(store.runtime(project.id).containerState).toBe("running");
    await orch.startEnv(project.id, envId);
    expect(store.runtime(envId).opencode).toBe("healthy");
    containers.stop.mockClear();
    await orch.stop(project.id);
    expect(containers.stop.mock.calls.map((c) => c[0])).toStrictEqual([
      "c2",
      "c1",
    ]);
    expect(store.runtime(envId).containerState).toBe("stopped");
  });

  it("removes a task container, the image the CLI left for it, its config and its record", async () => {
    const { orch, store, containers, envFiles, envId } = await withEnv();
    containers.remove.mockRejectedValueOnce(
      new CommandError("docker rm failed: busy")
    );
    await expect(orch.removeEnv(project.id, envId)).rejects.toThrow(/busy/u);
    expect(store.environment(envId)).toBeDefined();
    await orch.removeEnv(project.id, envId);
    expect(containers.remove).toHaveBeenLastCalledWith("c2");
    expect(containers.removeImage).toHaveBeenCalledWith("vsc-feat-1234-uid");
    expect(containers.removeVolume).toHaveBeenCalledWith(
      `opendevhub-opencode-${envId}`
    );
    expect(envFiles.remove).toHaveBeenCalledWith(envId);
    expect(store.environment(envId)).toBeUndefined();
    expect(orch.opencodeAddress(envId)).toBeUndefined();
  });

  it("re-adopts running task containers after a restart and ignores ones it has no record of", async () => {
    const s = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
      environments: {
        [featEnv]: {
          projectId: project.id,
          worktree: feat,
          containerId: "c2",
          password: "pw",
        },
      },
    });
    const stray: ContainerInfo = {
      ...runningTask,
      id: "c3",
      name: "stray",
      envId: "demo-abc123-old-ffff",
    };
    s.containers.listManaged.mockResolvedValueOnce([
      running,
      runningTask,
      stray,
    ]);
    await s.orch.rescan();
    await s.orch.adopt();
    expect(s.store.runtime(project.id)).toMatchObject({
      containerId: "c1",
      opencode: "healthy",
    });
    expect(s.store.runtime(featEnv)).toMatchObject({
      containerId: "c2",
      containerState: "running",
      opencode: "healthy",
    });
    expect(s.monitors.map((m) => m.opts.envId)).toStrictEqual([
      project.id,
      featEnv,
    ]);
    expect(
      s.orch
        .logLines(project.id)
        .some((l) => l.includes("ignoring container stray"))
    ).toBeTruthy();
    expect(s.store.environments(project.id)).toHaveLength(1);
    expect(s.store.runtime("demo-abc123-old-ffff").containerId).toBeUndefined();
  });

  it("notices a task container stopped outside opendevhub", async () => {
    const { orch, store, containers, envId } = await withEnv();
    containers.inspect.mockImplementation(async (id?: string) =>
      id === "c2" ? { ...runningTask, running: false } : running
    );
    await orch.refreshContainers();
    expect(store.runtime(envId).containerState).toBe("stopped");
    expect(store.runtime(project.id).containerState).toBe("running");
  });

  it("sends a worktree's sessions and replies to its own opencode", async () => {
    const { orch, store, clientFor, client, envId } = await withEnv();
    clientFor.mockClear();
    await orch.startSession(project.id, feat.path);
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.10:4096");
    clientFor.mockClear();
    await orch.startSession(project.id, "/workspaces/demo");
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.9:4096");
    store.setSessions(envId, [
      {
        ...waiting({ permissions: [permission], forms: [] }),
        envId,
        directory: feat.path,
      },
    ]);
    clientFor.mockClear();
    await orch.replyPermission(project.id, "per_1", { decision: "once" });
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.10:4096");
    expect(client.replyPermission).toHaveBeenCalled();
    await orch.stopEnv(project.id, envId);
    await expect(orch.startSession(project.id, feat.path)).rejects.toThrow(
      /container is not running/u
    );
  });
});

describe("git and ssh credentials", () => {
  it("prepares credentials and the agent tunnel after the relay and before opencode", async () => {
    const { store, orch, relay, credentials, agentTunnel, tunnels, runtime } =
      setup();
    await orch.rescan();
    await orch.start(project.id);
    const token = store.runtime(project.id).relayToken!;
    expect(credentials.prepare).toHaveBeenCalledWith(
      project,
      "/src/demo",
      expect.objectContaining({ sshAgent: true })
    );
    expect(agentTunnel).toHaveBeenCalledWith(
      { host: "172.17.0.9", port: 4097, token },
      expect.anything()
    );
    expect(tunnels[0].start).toHaveBeenCalled();
    expect(relay.ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(
      credentials.prepare.mock.invocationCallOrder[0]
    );
    expect(credentials.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.ensureRunning.mock.invocationCallOrder[0]
    );
    expect(runtime.ensureRunning.mock.calls[0][1].env).toStrictEqual({
      SSH_AUTH_SOCK: "/tmp/opendevhub-ssh-agent.sock",
    });
  });

  it("shows the tunnel's status on the runtime", async () => {
    const { store, orch, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    tunnels[0].opts.onStatus({ state: "forwarded" });
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "forwarded",
      sshAgentReason: undefined,
    });
    tunnels[0].opts.onStatus({
      state: "unavailable",
      reason: "SSH_AUTH_SOCK is not set on this machine",
    });
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "unavailable",
      sshAgentReason: "SSH_AUTH_SOCK is not set on this machine",
    });
  });

  it("leaves the agent out when the project turns it off", async () => {
    const { store, orch, credentials, agentTunnel, runtime, projectSettings } =
      setup();
    projectSettings.mockReturnValue({ sshAgent: false });
    await orch.rescan();
    await orch.start(project.id);
    expect(credentials.prepare).toHaveBeenCalledWith(
      project,
      "/src/demo",
      expect.objectContaining({ sshAgent: false })
    );
    expect(agentTunnel).not.toHaveBeenCalled();
    expect(store.runtime(project.id).sshAgent).toBe("off");
    expect(runtime.ensureRunning.mock.calls[0][1].env).toBeUndefined();
  });

  it("reports the agent unavailable without a relay", async () => {
    const { store, orch, relay, agentTunnel } = setup();
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "no relay runtime",
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(agentTunnel).not.toHaveBeenCalled();
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "unavailable",
      sshAgentReason: "relay not running",
    });
    expect(orch.logLines(project.id)).toContain(
      "ssh-agent: unavailable (relay not running)"
    );
  });

  it("still starts when preparing credentials fails", async () => {
    const { store, orch, credentials } = setup();
    credentials.prepare.mockRejectedValueOnce(new Error("boom"));
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      opencode: "healthy",
      error: undefined,
    });
    expect(orch.logLines(project.id)).toContain("credentials: boom");
  });

  it("stops the tunnel and clears the status when the container stops", async () => {
    const { store, orch, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    tunnels[0].opts.onStatus({ state: "forwarded" });
    await orch.stop(project.id);
    expect(tunnels[0].stop).toHaveBeenCalled();
    expect(store.runtime(project.id).sshAgent).toBeUndefined();
  });

  it("stops every tunnel on shutdown", async () => {
    const { orch, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.shutdown();
    expect(tunnels[0].stop).toHaveBeenCalled();
  });

  it("gives an adopted running container a tunnel too", async () => {
    const { orch, containers, agentTunnel, credentials } = setup({
      projects: { [project.id]: { password: "pw", relayToken: "kept" } },
    });
    containers.listManaged.mockResolvedValue([running]);
    await orch.rescan();
    await orch.adopt();
    expect(credentials.prepare).toHaveBeenCalledOnce();
    expect(agentTunnel).toHaveBeenCalledWith(
      { host: "172.17.0.9", port: 4097, token: "kept" },
      expect.anything()
    );
  });

  it("gives a task container its own tunnel, with its own token", async () => {
    const s = await withEnv();
    expect(s.agentTunnel).toHaveBeenCalledTimes(2);
    const [main, task] = s.tunnels;
    expect(task.target.host).toBe("172.17.0.10");
    expect(task.target.token).not.toBe(main.target.token);
    expect(s.credentials.prepare.mock.calls[1][0]).toMatchObject({
      id: s.envId,
    });
  });

  it("honours sshAgent: false in a task container's own configuration, whatever the main one said", async () => {
    const s = setup();
    s.worktrees.list.mockResolvedValue([feat]);
    s.containers.readConfiguration.mockImplementation(
      async (t?: ExecTarget) => ({
        forwardPorts: [],
        portsAttributes: {},
        configuration: t?.idLabels
          ? { customizations: { opendevhub: { sshAgent: false } } }
          : undefined,
      })
    );
    await s.orch.rescan();
    await s.orch.start(project.id);
    const { envId } = await s.orch.createEnv(project.id, feat.path);
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).opencode).toBe("healthy")
    );
    expect(s.agentTunnel).toHaveBeenCalledOnce();
    expect(s.store.runtime(envId).sshAgent).toBe("off");
    expect(s.credentials.prepare.mock.calls[1][2].sshAgent).toBeFalsy();
    expect(s.runtime.ensureRunning.mock.calls[1][1].env).toBeUndefined();
  });

  it("asks for relay recovery when the tunnel loses the relay", async () => {
    const { orch, relay, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    tunnels[0].opts.onRelayLost?.();
    await vi.waitFor(() =>
      expect(relay.ensureRunning).toHaveBeenCalledTimes(2)
    );
  });
});

describe("environments on another node", () => {
  it("keep their sessions out of cleanup's removed-worktree list", async () => {
    const { orch, client, clock } = await withRemoteRunning();
    client.sessions.mockResolvedValue([
      {
        id: "ses_r",
        time: { created: 1, updated: clock.now },
        location: { directory: remoteFix.path },
      },
    ]);
    const scan = await orch.cleanupSessionScan(project.id);
    expect(scan.items.filter((i) => i.sessionId === "ses_r")).toStrictEqual([]);
  });

  it("review and commit with git in their own container", async () => {
    const { orch, box } = await withRemoteRunning();
    const data = await orch.review(project.id, remoteFix.path);
    expect(data).toMatchObject({ branch: "fix", ahead: 3 });
    expect(box.kit.git.currentBranch.mock.calls[0][0]).toMatchObject({
      id: remoteEnv,
      path: remoteFix.hostPath,
    });
    box.kit.git.isClean.mockResolvedValueOnce(false);
    await orch.commit(project.id, remoteFix.path, "fix: login");
    expect(box.kit.git.commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: remoteEnv }),
      remoteFix.path,
      "fix: login"
    );
  });

  it("update from the base after pushing it again", async () => {
    const { orch, box } = await withRemoteRunning();
    box.kit.repo.pushBase.mockClear();
    await orch.updateFromBase(project.id, remoteFix.path, "main");
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(
      project,
      box.layout(project, "/workspaces/demo"),
      "main"
    );
    expect(box.kit.git.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: remoteEnv }),
      remoteFix.path,
      "main",
      "rebase"
    );
  });

  it("bring their branch home", async () => {
    const { orch, box } = await withRemoteRunning();
    await expect(
      orch.bringHome(project.id, remoteFix.path)
    ).resolves.toStrictEqual({
      branch: "fix",
    });
    expect(box.kit.repo.bringHome).toHaveBeenCalledWith(
      project,
      box.layout(project, "/workspaces/demo"),
      "fix"
    );
    await expect(
      orch.bringHome(project.id, "/workspaces/demo")
    ).rejects.toThrow(/on this machine already/u);
  });

  it("merge into the base after bringing the branch home", async () => {
    const { orch, box, git } = await withRemoteRunning();
    await expect(
      orch.mergeIntoBase(project.id, remoteFix.path, "main", true)
    ).resolves.toStrictEqual({ branch: "fix" });
    expect(box.kit.repo.bringHome).toHaveBeenCalled();
    expect(git.mergeInto).toHaveBeenCalledWith(
      project,
      "/workspaces/demo",
      "fix",
      true
    );
    expect(box.kit.repo.bringHome.mock.invocationCallOrder[0]).toBeLessThan(
      git.mergeInto.mock.invocationCallOrder[0]
    );
  });

  it("publish from the main checkout after bringing the branch home", async () => {
    const { orch, box, publisher } = await withRemoteRunning();
    const main = { container: "/workspaces/demo", host: project.path };
    await orch.publishInfo(project.id, remoteFix.path);
    expect(publisher.info).toHaveBeenCalledWith(
      project,
      main,
      "fix",
      undefined
    );
    await orch.publish(project.id, remoteFix.path, {
      remote: "origin",
      base: "main",
      strategy: "branch",
      title: "Fix",
      description: "",
    });
    expect(box.kit.repo.bringHome).toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledWith(
      project,
      main,
      "fix",
      expect.objectContaining({ remote: "origin" })
    );
  });

  it("don't run checks or open editors yet", async () => {
    const { orch, editors } = await withRemoteRunning();
    expect(orch.checkTarget(project.id, remoteFix.path).unavailable).toBe(
      "checks don't run on other nodes yet"
    );
    expect(() => orch.openInEditor(project.id, "code", remoteFix.path)).toThrow(
      /isn't available for environments on other nodes/u
    );
    expect(editors.open).not.toHaveBeenCalled();
  });

  it("are removed with their worktree and branch on the node", async () => {
    const { orch, store, box } = await withRemoteRunning();
    await orch.removeEnv(project.id, remoteEnv);
    expect(box.kit.containers.remove).toHaveBeenCalledWith("r1");
    expect(box.kit.envFiles.remove).toHaveBeenCalledWith(remoteEnv);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalledWith(
      box.layout(project, "/workspaces/demo"),
      remoteFix
    );
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  it("keep their record when the node's worktree won't go", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.kit.repo.removeWorktree.mockRejectedValueOnce(
      new CommandError("removing worktree fix on box failed: busy")
    );
    await expect(orch.removeEnv(project.id, remoteEnv)).rejects.toThrow(
      /busy/u
    );
    expect(store.environment(remoteEnv)).toBeDefined();
  });

  it("are removed as worktrees, even while the project's container is stopped", async () => {
    const { orch, store, box, worktrees } = await withRemoteRunning();
    await orch.stop(project.id);
    store.updateRuntime(project.id, { containerState: "stopped" });
    box.kit.repo.removeWorktree.mockClear();
    await orch.removeWorktree(project.id, remoteFix.path, false);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalled();
    expect(worktrees.remove).not.toHaveBeenCalled();
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  it("are removed when another variant is picked", async () => {
    const { orch, store, box } = await withRemoteRunning();
    const local = {
      ...waiting({ permissions: [], forms: [] }),
      id: "ses_keep",
      status: "idle" as const,
      directory: "/workspaces/demo",
      task: { task: "tsk_1", variant: 1, of: 2, title: "t" },
    };
    const remote = {
      ...local,
      id: "ses_r",
      envId: remoteEnv,
      directory: remoteFix.path,
      task: { task: "tsk_1", variant: 2, of: 2, title: "t", branch: "fix" },
    };
    store.setSessions(project.id, [local]);
    store.setSessions(remoteEnv, [remote]);
    const result = await orch.pickVariant(
      project.id,
      "tsk_1",
      "ses_keep",
      true
    );
    expect(result.removed).toEqual([remoteFix.path]);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalled();
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  async function remoteTask(body: Record<string, unknown> = {}) {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    const result = await s.orch.createTask(project.id, {
      prompt: "Fix login",
      environment: "isolated",
      node: "box",
      ...body,
    });
    return { ...s, box, result };
  }

  it("place a task: push the base, worktree on the node, environment there", async () => {
    const { result, box, worktrees, store, client } = await remoteTask();
    const layout = box.layout(project, "/workspaces/demo");
    expect(box.kit.repo.ensure).toHaveBeenCalledWith(layout);
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(project, layout, "main");
    expect(box.kit.repo.addWorktree).toHaveBeenCalledWith(
      layout,
      "fix-login",
      "main"
    );
    expect(worktrees.add).not.toHaveBeenCalled();
    const v = result.variants[0];
    expect(v).toMatchObject({
      branch: "fix-login",
      directory: "/workspaces/demo.worktrees/fix-login",
      sessionId: "ses_new",
    });
    expect(store.environment(v.envId!)).toMatchObject({
      node: "box",
      worktree: { branch: "fix-login" },
    });
    expect(v.envId).toBe(
      envIdFor(
        project.id,
        "box:/workspaces/demo.worktrees/fix-login",
        "fix-login"
      )
    );
    expect(client.createSession).toHaveBeenCalledWith(
      "/workspaces/demo.worktrees/fix-login",
      expect.anything()
    );
    expect(box.kit.containers.up).toHaveBeenCalled();
  });

  it("avoid branch names the node already has, and use the requested base", async () => {
    const box = boxKit();
    box.kit.repo.branches.mockResolvedValue(["fix-login"]);
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    const result = await s.orch.createTask(project.id, {
      prompt: "Fix login",
      environment: "isolated",
      node: "box",
      base: "origin/main",
    });
    expect(result.variants[0].branch).not.toBe("fix-login");
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(
      project,
      expect.anything(),
      "origin/main"
    );
  });

  it("say when the main checkout's uncommitted changes stay behind", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    s.git.isClean.mockResolvedValue(false);
    const result = await s.orch.createTask(project.id, {
      prompt: "x",
      environment: "isolated",
      node: "box",
    });
    expect(result.variants[0].notice).toBe(
      "uncommitted changes in the main checkout are not on node box"
    );
  });

  it("refuse what can't run on a node", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    const task = (body: Record<string, unknown>) =>
      s.orch.createTask(project.id, { prompt: "x", ...body });
    await expect(task({ where: "workspace", node: "box" })).rejects.toThrow(
      InvalidRequestError
    );
    await expect(task({ environment: "shared", node: "box" })).rejects.toThrow(
      /needs a new worktree with its own container/u
    );
    await expect(
      task({ environment: "isolated", node: "nope" })
    ).rejects.toThrow("unknown node nope");
    s.git.currentBranch.mockResolvedValue(undefined);
    await expect(
      task({ environment: "isolated", node: "box" })
    ).rejects.toThrow(/detached HEAD/u);
    box.online.box = false;
    await expect(
      task({ environment: "isolated", node: "box" })
    ).rejects.toThrow("node box is unreachable");
    s.store.setIsolation(project.id, {
      default: "shared",
      unsupported: "host networking is not supported",
    });
    box.online.box = true;
    await expect(
      task({ environment: "isolated", node: "box" })
    ).rejects.toThrow(/can't run on another node: host networking/u);
  });

  it("accept their checkouts as known directories", async () => {
    const { orch, result } = await remoteTask();
    await expect(
      orch.review(project.id, result.variants[0].directory!)
    ).resolves.toMatchObject({ branch: "fix" });
  });

  it("keep a local worktree from taking a remote environment's path", async () => {
    const { orch } = await remoteTask();
    await expect(
      orch.createWorktree(project.id, { branch: "fix-login" })
    ).rejects.toThrow(/used by a task on node box/u);
  });

  it("are parked when their node drops: watching stops, state and sessions stay", async () => {
    const { orch, store, monitors, forwarder, box } = await withRemoteRunning();
    const session = {
      ...waiting({ permissions: [], forms: [] }),
      id: "ses_r",
      envId: remoteEnv,
      directory: remoteFix.path,
      status: "idle" as const,
    };
    store.setSessions(remoteEnv, [session]);
    box.online.box = false;
    await orch.nodeOffline("box");
    expect(monitors.find((m) => m.opts.envId === remoteEnv)?.stopped).toBe(
      true
    );
    expect(forwarder.close).toHaveBeenCalledWith(remoteEnv);
    expect(box.routes[0].close).toHaveBeenCalled();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
    expect(store.sessionsOf(project.id).map((s) => s.id)).toContain("ses_r");
    await expect(orch.promptSession(project.id, "ses_r", "hi")).rejects.toThrow(
      "node box is unreachable"
    );
  });

  it("are adopted again when their node comes back", async () => {
    const { orch, store, monitors, box } = await withRemoteRunning();
    box.online.box = false;
    await orch.nodeOffline("box");
    box.online.box = true;
    box.kit.containers.listManaged.mockResolvedValue([box.info]);
    await orch.nodeOnline("box");
    expect(store.runtime(remoteEnv)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
    });
    expect(
      monitors.filter(
        (m) => m.opts.envId === remoteEnv && m.started && !m.stopped
      )
    ).toHaveLength(1);
  });

  it("are marked stopped when their container is gone after the node comes back", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.kit.containers.listManaged.mockResolvedValue([]);
    await orch.nodeOnline("box");
    expect(store.runtime(remoteEnv).containerState).toBe("stopped");
  });

  it("are left alone by the refresh while offline, or when ssh fails", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.kit.containers.inspect.mockRejectedValueOnce(
      new CommandError("docker inspect could not run: ssh exited 255")
    );
    await orch.refreshContainers();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
    box.online.box = false;
    box.kit.containers.inspect.mockClear();
    await orch.refreshContainers();
    expect(box.kit.containers.inspect).not.toHaveBeenCalled();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("start with that node's tools, mounting the node's repository", async () => {
    const { orch, store, containers, images, box } = await withRemote();
    await orch.startEnv(project.id, remoteEnv);
    expect(box.kit.images.ensureBase).toHaveBeenCalledWith(
      project,
      remoteFix,
      [],
      expect.any(Function),
      false
    );
    expect(images.ensureBase).not.toHaveBeenCalled();
    expect(box.kit.containers.readConfig).toHaveBeenCalledWith(
      remoteFix.hostPath
    );
    const config = box.kit.envFiles.write.mock.calls[0][1];
    expect(config.mounts).toContain(
      `type=bind,source=/home/tim/.opendevhub/repos/${project.id}/demo/.git,target=/workspaces/demo/.git`
    );
    expect(box.kit.containers.up).toHaveBeenCalledWith(
      {
        id: remoteEnv,
        path: remoteFix.hostPath,
        idLabels: envLabels(remoteEnv, project.id),
        overrideConfig: `/home/tim/.opendevhub/envs/${remoteEnv}/devcontainer.json`,
      },
      expect.anything()
    );
    expect(containers.up).toHaveBeenCalledOnce();
    expect(box.kit.network.route).toHaveBeenCalled();
    expect(box.kit.runtime.ensureRunning).toHaveBeenCalled();
    expect(store.runtime(remoteEnv)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "r1",
    });
  });

  it("start while the project's own container is stopped", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    s.store.putEnvironment({
      id: remoteEnv,
      projectId: project.id,
      worktree: remoteFix,
      node: "box",
    });
    await s.orch.startEnv(project.id, remoteEnv);
    expect(s.store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("fail with 'node box is unreachable' while it's offline, without touching their state", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.online.box = false;
    expect(() => orch.stopEnv(project.id, remoteEnv)).toThrow(UnavailableError);
    expect(() => orch.startEnv(project.id, remoteEnv)).toThrow(
      "node box is unreachable"
    );
    expect(store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("are skipped when the project stops while their node is offline", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.online.box = false;
    await orch.stop(project.id);
    expect(store.runtime(project.id).containerState).toBe("stopped");
    expect(box.kit.containers.stop).not.toHaveBeenCalled();
  });
});

describe("starting tasks in the background", () => {
  async function started() {
    const s = setup();
    await s.orch.rescan();
    await s.orch.start(project.id);
    let n = 0;
    s.client.createSession.mockImplementation(async (directory: string) => ({
      id: `ses_${++n}`,
      location: { directory },
    }));
    return s;
  }
  const startingOf = (s: { store: StateStore }, task: string) =>
    s.store.snapshot().projects[0].starting?.find((t) => t.task === task);

  it("answers once the request is checked, and reports each variant's steps as it goes", async () => {
    const s = await started();
    let release!: () => void;
    s.worktrees.add.mockImplementationOnce(
      (_p, a) =>
        new Promise(
          (r) =>
            (release = () =>
              r({
                path: `${a.root.container}/fix-login`,
                hostPath: `${a.root.host}/fix-login`,
                branch: a.branch,
              }))
        )
    );
    const result = await s.orch.startTask(project.id, {
      prompt: "Fix login",
      environment: "shared",
    });
    expect(result.variants).toStrictEqual([]);
    await vi.waitFor(() =>
      expect(startingOf(s, result.task)?.variants[0]).toMatchObject({
        step: "worktree",
        branch: "fix-login",
      })
    );
    expect(startingOf(s, result.task)).toMatchObject({
      title: "Fix login",
      of: 1,
    });
    release();
    await vi.waitFor(() =>
      expect(startingOf(s, result.task)?.variants[0]).toMatchObject({
        step: "session",
        sessionId: "ses_1",
      })
    );
  });

  it("still refuses bad requests right away", async () => {
    const s = await started();
    await expect(s.orch.startTask(project.id, { prompt: " " })).rejects.toThrow(
      InvalidRequestError
    );
    s.store.updateRuntime(project.id, { opencode: "unhealthy" });
    await expect(s.orch.startTask(project.id, { prompt: "x" })).rejects.toThrow(
      UnavailableError
    );
    expect(s.store.snapshot().projects[0].starting).toBeUndefined();
  });

  it("records a variant's failure and its log, and starts the others", async () => {
    const s = await started();
    s.worktrees.add.mockImplementationOnce(async (_p, a) => {
      a.onLine("worktree: preparing");
      throw new CommandError("git worktree add failed: boom", ["fatal: boom"]);
    });
    const { task } = await s.orch.startTask(project.id, {
      prompt: "Fix",
      environment: "shared",
      variants: [{}, {}],
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[1].step).toBe("session")
    );
    expect(startingOf(s, task)?.variants[0]).toMatchObject({
      step: "failed",
      error: "git worktree add failed: boom",
    });
    expect(startingOf(s, task)?.variants[0].log).toContain(
      "worktree: preparing"
    );
  });

  it("shows an isolated variant's image and container steps and their log lines", async () => {
    const s = await started();
    let built!: () => void;
    s.images.ensureBase.mockImplementationOnce(
      (
        p: Project,
        _w: EnvWorktree,
        _k: string[],
        onLine: (l: string) => void
      ) =>
        new Promise((r) => {
          onLine("image: building opendevhub/demo:k-base");
          built = () =>
            r({
              key: "k".repeat(64),
              ref: `opendevhub/${p.id}:kkkkkkkkkkkk-base`,
            });
        })
    );
    s.worktrees.add.mockImplementationOnce(async (_p, a) => ({
      path: `${a.root.container}/fix`,
      hostPath: `${a.root.host}/fix`,
      branch: a.branch,
    }));
    const { task } = await s.orch.startTask(project.id, {
      prompt: "Fix",
      environment: "isolated",
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].step).toBe("image")
    );
    expect(
      startingOf(s, task)?.variants[0].log.some((l) =>
        l.includes("image: building")
      )
    ).toBeTruthy();
    built();
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].step).toBe("session")
    );
  });

  it("marks every variant failed when the whole task can't start", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    box.kit.repo.pushBase.mockRejectedValueOnce(
      new CommandError("pushing main to box failed: denied")
    );
    const { task } = await s.orch.startTask(project.id, {
      prompt: "x",
      environment: "isolated",
      node: "box",
      variants: [{}, {}],
    });
    await vi.waitFor(() =>
      expect(
        startingOf(s, task)?.variants.every((v) => v.step === "failed")
      ).toBeTruthy()
    );
    expect(startingOf(s, task)?.variants[0]).toMatchObject({
      node: "box",
      error: "pushing main to box failed: denied",
    });
  });

  it("checks a remote task's base before answering", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    s.git.currentBranch.mockResolvedValue(undefined);
    await expect(
      s.orch.startTask(project.id, {
        prompt: "x",
        environment: "isolated",
        node: "box",
      })
    ).rejects.toThrow(/detached HEAD/u);
  });

  it("dismisses a failed variant", async () => {
    const s = await started();
    s.worktrees.add.mockRejectedValueOnce(new Error("boom"));
    const { task } = await s.orch.startTask(project.id, {
      prompt: "x",
      environment: "shared",
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].step).toBe("failed")
    );
    s.orch.dismissStarting(project.id, task);
    expect(startingOf(s, task)).toBeUndefined();
    expect(() => s.orch.dismissStarting(project.id, task)).toThrow(
      NotFoundError
    );
  });
});
