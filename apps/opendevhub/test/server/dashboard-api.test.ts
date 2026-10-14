import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { InferRequestType } from "hono/client";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { InvalidNodeError, InvalidRootError } from "../../src/server/config";
import { createDashboardApp } from "../../src/server/dashboard-api";
import type { DashboardHub, PushPort } from "../../src/server/dashboard-api";
import { openDatabase } from "../../src/server/db/database";
import { EventStore } from "../../src/server/db/events";
import {
  ForgejoPresetStore,
  JiraPresetStore,
} from "../../src/server/db/filter-presets";
import { ProjectStore } from "../../src/server/db/projects";
import { ProvenanceStore } from "../../src/server/db/provenance";
import { TodoStore } from "../../src/server/db/todos";
import { CommandError } from "../../src/server/environments/containers";
import { EditorUnavailableError } from "../../src/server/environments/editors";
import {
  AlreadyAnsweredError,
  BusyError,
  NotFoundError,
  UnavailableError,
} from "../../src/server/errors";
import { InvalidRequestError } from "../../src/server/git/worktrees";
import {
  FileForgejoSettings,
  Forgejo,
} from "../../src/server/integrations/forgejo";
import { FileJiraSettings, Jira } from "../../src/server/integrations/jira";
import { InvalidSubscriptionError } from "../../src/server/notifications/push";
import type { PushMessage } from "../../src/server/notifications/push";
import { DevcontainerExistsError } from "../../src/server/projects/onboarding";
import type { OnboardingPort } from "../../src/server/projects/onboarding";
import { StateStore } from "../../src/server/projects/state";
import type { ActivityPage, Provenance } from "../../src/shared/activity";
import { readProjectAppearance } from "../../src/shared/project-appearance";
import type { ProjectAppearance } from "../../src/shared/project-appearance";
import type {
  Candidate,
  CheckRun,
  AgentOption,
  ChecksConfig,
  ChecksView,
  CleanupItem,
  CleanupPlan,
  ChatLookup,
  ChatStartRequest,
  ChatStartResult,
  ChatSuggestions,
  MakeTaskRequest,
  CleanupResult,
  ComposerCommand,
  ComposerSendRequest,
  ComposerSendResult,
  ModelsInfo,
  PickResult,
  Project,
  SessionDetail,
  StoredAiReview,
  TaskResult,
  TicketLinks,
} from "../../src/shared/types";
import {
  createTask as createTaskViaRpc,
  fetchModels as fetchModelsViaRpc,
  postAction as postActionViaRpc,
  replyPermission as replyPermissionViaRpc,
} from "../../src/web/api";
import { api as rpcApi } from "../../src/web/rpc";
import { MemorySecretStore } from "../helpers/secrets";
import { memoryStores, stateStores } from "../helpers/stores";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/x",
};
const added: Candidate = {
  path: "/src/new-app",
  name: "new-app",
  root: "/src",
  stack: "node",
};
const newProject: Project = {
  id: "new-app-def456",
  name: "new-app",
  path: "/src/new-app",
  devcontainerPath: "/src/new-app/.devcontainer/devcontainer.json",
};

function setup(webDir?: string) {
  const store = new StateStore({
    ...stateStores(),
    port: 7777,
  });
  store.setProjects([project]);
  store.updateRuntime(project.id, { password: "secret" });
  const hub = {
    chat: {
      start: vi.fn(
        async (
          _id: string,
          _req: ChatStartRequest
        ): Promise<ChatStartResult> => ({
          chat: "c_1",
        })
      ),
      lookup: vi.fn((_id: string, _chat: string): ChatLookup => ({
        adoptedBy: { n: 1, task: "tsk_1" },
      })),
      archive: vi.fn((_id: string, _chat: string) => {}),
      brief: vi.fn(async (_id: string, _chat: string) => ({ brief: "Goal" })),
      suggestions: vi.fn(
        async (_id: string, _chat: string): Promise<ChatSuggestions> => ({
          pullRequests: [],
          tickets: ["APP-42"],
        })
      ),
      makeTask: vi.fn(
        async (_id: string, _chat: string, _body: MakeTaskRequest) => ({
          task: "tsk_2",
        })
      ),
    },
    environments: {
      createEnv: vi.fn(async (_id: string, _path: string) => ({
        envId: "demo-abc123-x-0a1b",
      })),
      startEnv: vi.fn((_id: string, _env: string) => Promise.resolve()),
      stopEnv: vi.fn((_id: string, _env: string) => Promise.resolve()),
      rebuildEnv: vi.fn((_id: string, _env: string) => Promise.resolve()),
      restartEnvOpencode: vi.fn((_id: string, _env: string) =>
        Promise.resolve()
      ),
      removeEnv: vi.fn(async (_id: string, _env: string) => {}),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      rebuild: vi.fn(() => Promise.resolve()),
      restartOpencode: vi.fn(() => Promise.resolve()),
      rescan: vi.fn(async () => {}),
      logLines: vi.fn(() => ["a", "b"]),
      onLog: vi.fn(() => () => {}),
    },
    checkouts: {
      branches: vi.fn((_id: string) => [
        {
          createdAt: 1,
          createdBy: { by: "pull" as const, url: "https://f.example/pulls/1" },
          id: 1,
          name: "review/pr-1",
          prUrl: "https://f.example/pulls/1",
        },
      ]),
      bringHome: vi.fn(async (_id: string, _dir: string) => ({
        branch: "fix",
      })),
      refreshWorktrees: vi.fn(async () => []),
      createWorktree: vi.fn(async () => ({
        worktree: { path: "/workspaces/demo.worktrees/x", branch: "x" },
      })),
      removeWorktree: vi.fn(async () => {}),
      openInEditor: vi.fn(async () => {}),
    },
    sessions: {
      startSession: vi.fn(
        async (
          _id: string,
          _dir: string,
          _title?: string,
          _prompt?: string,
          _options?: { reviewOf?: number }
        ) => ({ sessionId: "ses_1" })
      ),
      generateIn: vi.fn(
        async (
          _id: string,
          _dir: string,
          _prompt: string,
          options: {
            sessionId?: string;
            title: string;
            timeoutMs?: number;
            reviewOf?: number;
          }
        ) => ({
          sessionId: options.sessionId ?? "ses_ai",
          text: '```json\n{"summary":"ok","findings":[{"file":"a.ts","line":3,"severity":"major","body":"Off by one"}]}\n```',
        })
      ),
      replyPermission: vi.fn(
        async (
          _id: string,
          _rid: string,
          _reply: { decision: string; message?: string }
        ) => {}
      ),
      replyForm: vi.fn(
        async (_id: string, _fid: string, _answer: unknown) => {}
      ),
      cancelForm: vi.fn(async (_id: string, _fid: string) => {}),
      promptSession: vi.fn(
        async (_id: string, _sid: string, _text: string) => {}
      ),
      sendMessage: vi.fn(
        async (
          _id: string,
          _sid: string,
          _req: ComposerSendRequest
        ): Promise<ComposerSendResult> => ({ kind: "prompt", queued: false })
      ),
      composerCommands: vi.fn(
        async (_id: string, _dir: string): Promise<ComposerCommand[]> => [
          { name: "new", hub: true },
        ]
      ),
      composerAgents: vi.fn(
        async (_id: string, _dir: string): Promise<AgentOption[]> => [
          { id: "explore", name: "Explore" },
        ]
      ),
      findFiles: vi.fn(async (_id: string, _dir: string, _query: string) => [
        "src/a.ts",
      ]),
      removeSession: vi.fn(async (_id: string, _sid: string) => {}),
      startTaskConversation: vi.fn(
        async (_id: string, _sid: string) => "ses_new"
      ),
      archiveTaskConversation: vi.fn(async (_id: string, _sid: string) => {}),
      sessionDetail: vi.fn(
        async (_id: string, _sid: string): Promise<SessionDetail> => {
          throw new NotFoundError(_sid, "session");
        }
      ),
      models: vi.fn(async (_id: string): Promise<ModelsInfo> => ({
        models: [],
        agents: [],
      })),
    },
    reviews: {
      review: vi.fn(
        async (
          _id: string,
          directory: string,
          _o?: { base?: string; file?: string }
        ) => ({
          directory,
          mode: "branch" as const,
          ahead: 0,
          behind: 0,
          dirty: false,
          pushed: false,
          workspace: { clean: true },
          files: [],
        })
      ),
      reviewImage: vi.fn(
        async (
          _id: string,
          _directory: string,
          o: { file: string; side: "old" | "new" }
        ): Promise<{ bytes: Buffer; type: string } | undefined> =>
          o.side === "old"
            ? undefined
            : { bytes: Buffer.from([0x89, 0x50]), type: "image/png" }
      ),
      commitMessage: vi.fn(async (_id: string, _dir: string) => "feat: x"),
      commit: vi.fn(async (_id: string, _dir: string, _m: string) => {}),
      updateFromBase: vi.fn(
        async (_id: string, _dir: string, _base: string) => ({
          strategy: "rebase" as const,
        })
      ),
      mergeIntoBase: vi.fn(
        async (_id: string, _dir: string, _base: string, _ff: boolean) => ({
          branch: "x",
        })
      ),
      publishInfo: vi.fn(
        async (_id: string, _dir: string, _remote?: string) => ({
          remotes: ["origin"],
          remote: "origin",
          forge: { kind: "unknown" as const },
          strategies: ["branch" as const],
          strategy: "branch" as const,
          pushFrom: "host" as const,
        })
      ),
      publishSuggestion: vi.fn(async (_id: string, _dir: string) => ({
        title: "t",
        description: "d",
      })),
      publish: vi.fn(async (_id: string, _dir: string, _req: unknown) => ({
        strategy: "branch" as const,
        pushedFrom: "host" as const,
        output: [],
      })),
    },
    tasks: {
      startTask: vi.fn(
        async (
          _id: string,
          _b: Record<string, unknown>
        ): Promise<TaskResult> => ({ task: "tsk_1", variants: [] })
      ),
      dismissStarting: vi.fn((_id: string, _task: string) => {}),
      archiveTask: vi.fn((_id: string, _task: string) => {}),
      archivedTasks: vi.fn((_id: string) => []),
      restoreTask: vi.fn((_id: string, _task: string) => {}),
      deleteArchivedTask: vi.fn((_id: string, _task: string) => {}),
      createDraft: vi.fn((_id: string, _b: Record<string, unknown>) => ({
        task: "tsk_d",
      })),
      draftFromTicket: vi.fn((_id: string, _b: Record<string, unknown>) => ({
        task: "tsk_j",
      })),
      editDraft: vi.fn(
        (_id: string, _task: string, _b: Record<string, unknown>) => {}
      ),
      startDraft: vi.fn(
        async (
          _id: string,
          task: string,
          _b: Record<string, unknown>
        ): Promise<TaskResult> => ({ task, variants: [] })
      ),
      pickVariant: vi.fn(
        async (
          _id: string,
          _t: string,
          _s: string,
          _r: boolean
        ): Promise<PickResult> => ({
          discarded: ["ses_2"],
          removed: [],
          errors: [],
        })
      ),
    },
  } satisfies DashboardHub;
  const onboarding = {
    list: vi.fn(async () => ({ roots: ["/src"], candidates: [added] })),
    add: vi.fn(async (_path: string, _stack: unknown) => added),
  } satisfies OnboardingPort;
  const push = {
    publicKey: vi.fn(() => "BPubKey"),
    browsers: vi.fn(() => [
      {
        endpoint: "https://push.example.com/1",
        origin: "http://localhost:7777",
      },
    ]),
    subscribe: vi.fn((raw: unknown) => {
      if (!(raw as { endpoint?: unknown }).endpoint) {
        throw new InvalidSubscriptionError("subscription needs an endpoint");
      }
    }),
    unsubscribe: vi.fn((_endpoint: string) => {}),
    send: vi.fn(async (_m: PushMessage, _endpoint?: string) => 1),
  } satisfies PushPort;
  // Rescanning after a write discovers the new project.
  hub.environments.rescan.mockImplementation(async () =>
    store.setProjects([project, newProject])
  );
  const cleanup = {
    scan: vi.fn(
      async () => ({ scannedAt: 1, projects: [], items: [] }) as CleanupPlan
    ),
    apply: vi.fn(async (_items: CleanupItem[]): Promise<CleanupResult> => ({
      results: [],
      freedBytes: 0,
    })),
  };
  const config: ChecksConfig = {
    checks: [],
    source: "none",
    devcontainer: [],
    errors: [],
  };
  const run: CheckRun = {
    directory: "/w",
    dirty: false,
    startedAt: 1,
    results: [],
  };
  const checks = {
    view: vi.fn(
      async (_id: string, _dir?: string): Promise<ChecksView> => config
    ),
    latest: vi.fn((_id: string, _dir: string) => ({ run })),
    start: vi.fn(
      async (
        _id: string,
        _dir: string,
        _opts?: { names?: string[]; approve?: string[] }
      ) => run
    ),
    saveSettings: vi.fn(async (_id: string, _checks: unknown) => config),
  };
  return {
    store,
    hub,
    onboarding,
    push,
    cleanup,
    checks,
    app: createDashboardApp({
      store,
      hub,
      onboarding,
      push,
      cleanup,
      checks,
      webDir,
    }),
  };
}

describe("dashboard API", () => {
  it("protects Jira settings and routes tickets, search, pagination and linked tasks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-jira-api-"));
    try {
      const deps = setup();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("secret-token rejected", { status: 401 })
        );
      const secrets = new MemorySecretStore();
      const jira = new Jira(new FileJiraSettings(dir, secrets), fetcher);
      const app = createDashboardApp({ ...deps, jira });
      expect((await app.request("/api/jira/tickets")).status).toBe(412);
      expect(fetcher).not.toHaveBeenCalled();
      const post = (body: unknown, origin?: string) =>
        app.request("/api/jira/settings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify(body),
        });
      const saved = await post({
        enabled: true,
        url: "https://jira.example.com",
        token: "secret-token",
      });
      expect(saved.status).toBe(200);
      await expect(saved.json()).resolves.toStrictEqual({
        enabled: true,
        url: "https://jira.example.com",
        hasToken: true,
      });
      const view = await app.request("/api/jira/settings");
      expect(view.headers.get("cache-control")).toBe("no-store");
      await expect(view.text()).resolves.not.toContain("secret-token");
      const failed = await app.request("/api/jira/tickets");
      expect(failed.status).toBe(502);
      await expect(failed.text()).resolves.not.toContain("secret-token");
      expect(
        (
          await post(
            { enabled: false, url: "https://jira.example.com" },
            "https://attacker.example.com"
          )
        ).status
      ).toBe(403);
      expect(
        (await post({ enabled: true, url: "https://other.example.com" })).status
      ).toBe(400);
      const tickets = vi
        .spyOn(jira, "tickets")
        .mockResolvedValue({ tickets: [], total: 0 });
      const ticket = vi
        .spyOn(jira, "ticket")
        .mockResolvedValue({ key: "APP-12" } as never);
      await expect(
        (await app.request("/api/jira/tickets?search=login&startAt=50")).json()
      ).resolves.toStrictEqual({ tickets: [], total: 0 });
      expect(tickets).toHaveBeenCalledWith({
        scope: "assigned",
        search: "login",
        sort: "updated",
        startAt: 50,
        status: "any",
      });
      await app.request(
        "/api/jira/tickets?scope=board&board=4&sprint=1&project=APP&status=open&sort=rank"
      );
      expect(tickets).toHaveBeenLastCalledWith({
        board: 4,
        project: "APP",
        scope: "board",
        search: "",
        sort: "rank",
        sprint: true,
        startAt: 0,
        status: "open",
      });
      for (const query of [
        "startAt=1e2",
        "scope=board",
        "scope=assigned&board=4",
        "scope=filter&filter=abc",
        "project=app",
        "status=closed",
        "sprint=1",
      ]) {
        expect((await app.request(`/api/jira/tickets?${query}`)).status).toBe(
          400
        );
      }
      const columns = vi
        .spyOn(jira, "columns")
        .mockResolvedValue([{ name: "To Do", statusIds: ["1"] }]);
      await expect(
        (await app.request("/api/jira/boards/4/columns")).json()
      ).resolves.toStrictEqual([{ name: "To Do", statusIds: ["1"] }]);
      expect(columns).toHaveBeenCalledWith(4);
      for (const board of ["0", "abc", "1e2"]) {
        expect(
          (await app.request(`/api/jira/boards/${board}/columns`)).status
        ).toBe(400);
      }
      await expect(
        (await app.request("/api/jira/tickets/APP-12")).json()
      ).resolves.toStrictEqual({ key: "APP-12" });
      expect(ticket).toHaveBeenCalledWith("APP-12");
      const source = {
        key: "APP-12",
        instanceUrl: "https://jira.example.com",
        title: "Login",
        description: "Fix login",
      };
      const body = {
        prompt: "Fix login",
        jira: source,
        where: "worktree",
        variants: [{}],
      };
      await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(deps.hub.tasks.startTask).toHaveBeenCalledWith(project.id, body);
      await expect(
        (await app.request("/api/projects")).text()
      ).resolves.not.toContain("secret-token");
      await post({
        enabled: false,
        url: "https://jira.example.com",
        clearToken: true,
      });
      expect(secrets.values.size).toBe(0);
      expect((await new FileJiraSettings(dir, secrets).view()).hasToken).toBe(
        false
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect((await setup().app.request("/api/jira/settings")).status).toBe(412);
  });

  it("persists private Forgejo settings through the API without exposing the token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-forgejo-api-"));
    try {
      const { store, hub, onboarding, push, cleanup, checks } = setup();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("unauthorized secret-token", { status: 401 })
        );
      const secrets = new MemorySecretStore();
      const forgejo = new Forgejo(
        new FileForgejoSettings(dir, secrets),
        fetcher
      );
      const app = createDashboardApp({
        store,
        hub,
        onboarding,
        push,
        cleanup,
        checks,
        forgejo,
      });
      const post = (body: unknown, origin?: string) =>
        app.request("/api/forgejo/settings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify(body),
        });
      expect((await app.request("/api/forgejo/pulls")).status).toBe(412);
      expect(fetcher).not.toHaveBeenCalled();
      const saved = await post({
        enabled: true,
        url: "https://forge.example.com",
        token: "secret-token",
      });
      expect(saved.status).toBe(200);
      await expect(saved.json()).resolves.toStrictEqual({
        enabled: true,
        url: "https://forge.example.com",
        hasToken: true,
      });
      const res = await app.request("/api/forgejo/settings");
      expect(res.headers.get("cache-control")).toBe("no-store");
      await expect(res.text()).resolves.not.toContain("secret-token");
      const failed = await app.request("/api/forgejo/pulls");
      expect(failed.status).toBe(502);
      await expect(failed.text()).resolves.not.toContain("secret-token");
      expect(
        (
          await post(
            { enabled: false, url: "https://forge.example.com" },
            "https://attacker.example.com"
          )
        ).status
      ).toBe(403);
      expect((await forgejo.view()).enabled).toBeTruthy();
      expect(
        (await post({ enabled: true, url: "https://other.example.com" })).status
      ).toBe(400);
      await expect(
        (await app.request("/api/projects")).text()
      ).resolves.not.toContain("secret-token");
      await post({
        enabled: false,
        url: "https://forge.example.com",
        clearToken: true,
      });
      await expect(
        new FileForgejoSettings(dir, secrets).view()
      ).resolves.toStrictEqual({
        enabled: false,
        url: "https://forge.example.com",
        hasToken: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes reviews and creates worktrees only for the displayed open PR commit", async () => {
    const { store, hub, onboarding, push, cleanup, checks } = setup();
    const sha = "a".repeat(40);
    const forgejo = {
      view: vi.fn(),
      save: vi.fn(),
      pulls: vi.fn(),
      diff: vi.fn(
        async () =>
          ({
            pull: {
              owner: "team",
              repo: "repo",
              state: "open",
              url: "https://forge.example/team/repo/pulls/7",
              number: 7,
            },
            commitId: sha,
            head: "feature/login",
            headRepository: "fork/repo",
          }) as never
      ),
      test: vi.fn(),
      inbox: vi.fn(),
      details: vi.fn(),
      patch: vi.fn(),
      comments: vi.fn(),
      reviews: vi.fn(),
      reviewComments: vi.fn(),
      approvals: vi.fn(),
      checks: vi.fn(),
      review: vi.fn(async () => ({ sent: true as const })),
    };
    const app = createDashboardApp({
      store,
      hub,
      onboarding,
      push,
      cleanup,
      checks,
      forgejo,
    });
    const post = (route: string, body: unknown) =>
      app.request(`/api/forgejo/pulls/team/repo/7/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const review = {
      commitId: sha,
      event: "COMMENT",
      body: "Looks good",
      comments: [],
    };
    expect((await post("reviews", review)).status).toBe(200);
    expect(forgejo.review).toHaveBeenCalledWith("team", "repo", "7", review);
    expect(
      (
        await post("worktree", {
          projectId: "p",
          branch: "review/pr-7",
          commitId: "b".repeat(40),
        })
      ).status
    ).toBe(400);
    expect(hub.checkouts.createWorktree).not.toHaveBeenCalled();
    expect(
      (
        await post("worktree", {
          projectId: "p",
          branch: "review/pr-7",
          commitId: sha,
        })
      ).status
    ).toBe(200);
    // The worktree checks out the PR's own head branch, whatever the request names.
    expect(hub.checkouts.createWorktree).toHaveBeenCalledWith("p", {
      branch: "feature/login",
      pull: {
        url: "https://forge.example/team/repo/pulls/7",
        number: 7,
        commitId: sha,
        headRepository: "fork/repo",
        repo: { owner: "team", repo: "repo" },
      },
    });
  });

  it("runs AI reviews only for the displayed PR commit", async () => {
    const { store, hub, onboarding, push, cleanup, checks } = setup();
    const sha = "a".repeat(40);
    const details = {
      pull: {
        owner: "team",
        repo: "repo",
        number: 7,
        title: "Fix it",
        url: "https://forge.example/team/repo/pulls/7",
        state: "open",
      },
      body: "Fixes the thing",
      base: "main",
      head: "fix",
      headSha: sha,
    };
    const forgejo = {
      view: vi.fn(),
      save: vi.fn(),
      pulls: vi.fn(),
      diff: vi.fn(),
      test: vi.fn(),
      inbox: vi.fn(),
      details: vi.fn(async () => details as never),
      patch: vi.fn(async () => ({ patch: "diff --git a/a.ts b/a.ts" })),
      comments: vi.fn(),
      reviews: vi.fn(),
      reviewComments: vi.fn(),
      approvals: vi.fn(),
      checks: vi.fn(),
    };
    const { links } = memoryStores();
    const app = createDashboardApp({
      store,
      hub,
      onboarding,
      push,
      cleanup,
      checks,
      forgejo,
      links,
    });
    const post = (route: string, body: unknown) =>
      app.request(`/api/forgejo/pulls/team/repo/7/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const where = { projectId: "p", directory: "/workspaces/repo" };
    expect(
      (await post("ai-review/session", { ...where, commitId: "b".repeat(40) }))
        .status
    ).toBe(400);
    expect(hub.sessions.startSession).not.toHaveBeenCalled();

    const started = await post("ai-review/session", {
      ...where,
      commitId: sha,
    });
    expect(await started.json()).toEqual({ sessionId: "ses_1" });
    const [, , title, prompt, options] =
      hub.sessions.startSession.mock.calls[0];
    expect(title).toBe("AI review: PR #7 Fix it");
    expect(prompt).toContain(`First check that HEAD is ${sha}`);
    const pull = links.pull("https://forge.example/team/repo/pulls/7");
    expect(pull).toMatchObject({
      baseBranch: "main",
      forge: "forgejo",
      headBranch: "fix",
      number: 7,
      state: "open",
      title: "Fix it",
    });
    expect(options).toStrictEqual({ reviewOf: pull?.id });

    const collected = await post("ai-review", {
      ...where,
      commitId: sha,
      sessionId: "ses_1",
    });
    expect(await collected.json()).toEqual({
      sessionId: "ses_1",
      summary: "ok",
      findings: [
        {
          file: "a.ts",
          line: 3,
          side: "new",
          severity: "major",
          body: "Off by one",
        },
      ],
    });
    expect(forgejo.patch).not.toHaveBeenCalled();

    const quick = await post("ai-review", { ...where, commitId: sha });
    expect((await quick.json()).sessionId).toBe("ses_ai");
    const [, , quickPrompt, quickOptions] =
      hub.sessions.generateIn.mock.calls[1];
    expect(quickPrompt).toContain("diff --git a/a.ts b/a.ts");
    expect(quickOptions.sessionId).toBeUndefined();
    expect(quickOptions.reviewOf).toBe(pull?.id);
    const listed = await app.request(
      "/api/forgejo/pulls/team/repo/7/ai-reviews"
    );
    expect(
      ((await listed.json()) as { reviews: StoredAiReview[] }).reviews.map(
        (r) => [r.mode, r.sessionId, r.headSha, r.findings.length]
      )
    ).toStrictEqual([
      ["quick", "ses_ai", sha, 1],
      ["session", "ses_1", sha, 1],
    ]);
  });

  it("answers link lookups, empty for what opendevhub never touched", async () => {
    const { store, hub, onboarding, push, cleanup, checks } = setup();
    const dbs = memoryStores();
    dbs.projects.upsertAll([
      {
        devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
        id: "demo",
        name: "demo",
        path: "/src/demo",
      },
    ]);
    dbs.tasks.createTask({
      createdAt: 1,
      id: "tsk_01JA0000000000000000000001",
      jira: {
        description: "",
        instanceUrl: "https://jira.example",
        key: "APP-42",
        title: "Add login",
      },
      projectId: "demo",
      prompt: "Add login",
      title: "Add login",
      variants: [{}],
    });
    const app = createDashboardApp({
      store,
      hub,
      onboarding,
      push,
      cleanup,
      checks,
      links: dbs.links,
    });
    const ticket = await app.request(
      "/api/links/ticket?instance=https%3A%2F%2Fjira.example&key=APP-42"
    );
    expect(ticket.status).toBe(200);
    expect(
      ((await ticket.json()) as TicketLinks).tasks.map((t) => t.title)
    ).toStrictEqual(["Add login"]);
    await expect(
      (
        await app.request(
          "/api/links/pull?url=https%3A%2F%2Fforge.example%2Fo%2Fr%2Fpulls%2F1"
        )
      ).json()
    ).resolves.toStrictEqual({ branches: [], reviewTasks: [], reviews: [] });
    expect(
      (await app.request("/api/links/ticket?instance=x&key=APP-42")).status
    ).toBe(400);
    expect(
      (
        await app.request(
          "/api/links/ticket?instance=https%3A%2F%2Fjira.example&key=nope"
        )
      ).status
    ).toBe(400);
    expect((await app.request("/api/links/pull?url=javascript:1")).status).toBe(
      400
    );
  });

  it("routes Forgejo PR lists and selected diffs", async () => {
    const { store, hub, onboarding, push, cleanup, checks } = setup();
    const forgejo = {
      view: vi.fn(),
      save: vi.fn(),
      pulls: vi.fn(),
      diff: vi.fn(),
      test: vi.fn(async () => ({ username: "alice", version: "11" })),
      inbox: vi.fn(async () => ({ username: "alice", pulls: [] })),
      details: vi.fn(async () => ({ body: "PR description" }) as never),
      patch: vi.fn(async () => ({ patch: "test diff" })),
      comments: vi.fn(async () => ({ items: [] })),
      reviews: vi.fn(async () => ({ items: [] })),
      reviewComments: vi.fn(async () => []),
      approvals: vi.fn(async () => ({
        approvedBy: ["bob"],
        base: "main",
        changesRequestedBy: [],
        required: 2,
      })),
      checks: vi.fn(async () => ({
        items: [],
        state: "success",
        sha: "a".repeat(40),
      })),
    };
    const app = createDashboardApp({
      store,
      hub,
      onboarding,
      push,
      cleanup,
      checks,
      forgejo,
    });
    await expect(
      (await app.request("/api/forgejo/pulls")).json()
    ).resolves.toStrictEqual({ username: "alice", pulls: [] });
    await expect(
      (await app.request("/api/forgejo/pulls/team/demo/7")).json()
    ).resolves.toStrictEqual({ body: "PR description" });
    expect(forgejo.details).toHaveBeenCalledWith(
      "team",
      "demo",
      "7",
      expect.any(AbortSignal)
    );
    await expect(
      (await app.request("/api/forgejo/pulls/team/demo/7/patch")).json()
    ).resolves.toStrictEqual({ patch: "test diff" });
    await app.request(
      "/api/forgejo/pulls?state=open&inbox=assigned&page=2&q=fix&repository=team%2Fdemo&org=team&team=web"
    );
    expect(forgejo.inbox).toHaveBeenLastCalledWith(
      {
        state: "open",
        inbox: "assigned",
        page: 2,
        q: "fix",
        repository: "team/demo",
        org: "team",
        team: "web",
      },
      expect.any(AbortSignal)
    );
    await app.request("/api/forgejo/pulls/team/demo/7/comments?page=3");
    expect(forgejo.comments).toHaveBeenCalledWith(
      "team",
      "demo",
      "7",
      3,
      expect.any(AbortSignal)
    );
    await app.request("/api/forgejo/pulls/team/demo/7/reviews?page=2");
    expect(forgejo.reviews).toHaveBeenCalledWith(
      "team",
      "demo",
      "7",
      2,
      expect.any(AbortSignal)
    );
    await expect(
      (await app.request("/api/forgejo/pulls/team/demo/7/approvals")).json()
    ).resolves.toStrictEqual({
      approvedBy: ["bob"],
      base: "main",
      changesRequestedBy: [],
      required: 2,
    });
    expect(forgejo.approvals).toHaveBeenCalledWith(
      "team",
      "demo",
      "7",
      expect.any(AbortSignal)
    );
    await app.request("/api/forgejo/pulls/team/demo/7/reviews/9/comments");
    expect(forgejo.reviewComments).toHaveBeenCalledWith(
      "team",
      "demo",
      "7",
      "9",
      expect.any(AbortSignal)
    );
    await app.request(`/api/forgejo/checks/team/demo/${"a".repeat(40)}?page=4`);
    expect(forgejo.checks).toHaveBeenCalledWith(
      "team",
      "demo",
      "a".repeat(40),
      4,
      expect.any(AbortSignal)
    );
    const tested = await app.request("/api/forgejo/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://forge.example" }),
    });
    expect(tested.headers.get("cache-control")).toBe("no-store");
    await expect(tested.json()).resolves.toStrictEqual({
      username: "alice",
      version: "11",
    });
    expect(
      (
        await app.request("/api/forgejo/test", {
          method: "POST",
          headers: { origin: "https://other.example", host: "localhost" },
        })
      ).status
    ).toBe(403);
    expect((await setup().app.request("/api/forgejo/settings")).status).toBe(
      412
    );
  });

  it("serves a usage report for a day, today by default", async () => {
    const report = {
      total: { cost: 1, tokens: 1 },
      today: { cost: 0, tokens: 0 },
      day: "2026-10-01",
      dayTotal: { cost: 1, tokens: 1 },
      projects: [],
      days: [],
    };
    const usage = { report: vi.fn((_day: string, _today: string) => report) };
    const { store, hub, onboarding, push, cleanup, checks } = setup();
    const app = createDashboardApp({
      store,
      hub,
      onboarding,
      push,
      cleanup,
      checks,
      usage,
    });
    const res = await app.request("/api/usage?day=2026-10-01");
    await expect(res.json()).resolves.toStrictEqual(report);
    const today = usage.report.mock.calls[0][1];
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    await app.request("/api/usage");
    expect(usage.report).toHaveBeenLastCalledWith(today, today);
    expect((await app.request("/api/usage?day=2026-13-40")).status).toBe(400);
    expect((await app.request("/api/usage?day=yesterday")).status).toBe(400);
  });

  it("says usage is unavailable when there is no ledger", async () => {
    const { app } = setup();
    expect((await app.request("/api/usage")).status).toBe(412);
  });

  it("serves the push key and adds, removes and tests subscriptions", async () => {
    const { app, push } = setup();
    const post = (url: string, body?: unknown) =>
      app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    await expect(
      (await app.request("/api/push/key")).json()
    ).resolves.toStrictEqual({
      publicKey: "BPubKey",
    });

    const sub = {
      endpoint: "https://push.example.com/1",
      keys: { p256dh: "k", auth: "a" },
    };
    expect((await post("/api/push/subscribe", sub)).status).toBe(200);
    expect(push.subscribe).toHaveBeenCalledWith(sub);
    const bad = await post("/api/push/subscribe", { keys: {} });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toStrictEqual({
      error: "subscription needs an endpoint",
    });

    expect(
      (await post("/api/push/unsubscribe", { endpoint: sub.endpoint })).status
    ).toBe(200);
    expect(push.unsubscribe).toHaveBeenCalledWith(sub.endpoint);

    await expect(
      (await app.request("/api/push/browsers")).json()
    ).resolves.toStrictEqual(push.browsers());
    expect((await post("/api/push/test")).status).toBe(400);
    expect(push.send).not.toHaveBeenCalled();
    await expect(
      (await post("/api/push/test", { endpoint: sub.endpoint })).json()
    ).resolves.toStrictEqual({
      sent: 1,
    });
    expect(push.send).toHaveBeenCalledWith(
      {
        tag: "test",
        title: "opendevhub",
        body: "Notifications work.",
        url: "/",
      },
      sub.endpoint
    );
  });

  it("GET /api/projects returns the snapshot without passwords", async () => {
    const { app } = setup();
    const res = await app.request("/api/projects");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).projects[0].project.id).toBe(project.id);
  });

  it.each([
    ["start", "start"],
    ["stop", "stop"],
    ["rebuild", "rebuild"],
    ["restart-opencode", "restartOpencode"],
  ] as const)("POST %s triggers environments.%s", async (route, method) => {
    const { app, hub } = setup();
    const res = await app.request(`/api/projects/${project.id}/${route}`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    expect(hub.environments[method]).toHaveBeenCalledWith(project.id);
  });

  it("maps BusyError to 409 and NotFoundError to 404", async () => {
    const { app, hub } = setup();
    hub.environments.start.mockImplementationOnce(() => {
      throw new BusyError(project.id);
    });
    expect(
      (
        await app.request(`/api/projects/${project.id}/start`, {
          method: "POST",
        })
      ).status
    ).toBe(409);
    hub.environments.start.mockImplementationOnce(() => {
      throw new NotFoundError("x");
    });
    expect(
      (await app.request(`/api/projects/x/start`, { method: "POST" })).status
    ).toBe(404);
  });

  it("creates, starts, stops and removes a worktree's own container", async () => {
    const { app, hub } = setup();
    const post = (url: string, body?: unknown) =>
      app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    const created = await post(`/api/projects/${project.id}/envs`, {
      path: "/w/x",
    });
    await expect(created.json()).resolves.toStrictEqual({
      envId: "demo-abc123-x-0a1b",
    });
    expect(hub.environments.createEnv).toHaveBeenCalledWith(project.id, "/w/x");
    expect(
      (await post(`/api/projects/${project.id}/envs/e1/start`)).status
    ).toBe(202);
    expect(hub.environments.startEnv).toHaveBeenCalledWith(project.id, "e1");
    expect(
      (await post(`/api/projects/${project.id}/envs/e1/stop`)).status
    ).toBe(202);
    expect(hub.environments.stopEnv).toHaveBeenCalledWith(project.id, "e1");
    expect(
      (await post(`/api/projects/${project.id}/envs/e1/remove`)).status
    ).toBe(200);
    expect(hub.environments.removeEnv).toHaveBeenCalledWith(project.id, "e1");
    hub.environments.startEnv.mockImplementationOnce(() => {
      throw new NotFoundError("e9", "environment");
    });
    expect(
      (await post(`/api/projects/${project.id}/envs/e9/start`)).status
    ).toBe(404);
  });

  it("worktree routes pass the JSON body and return the result", async () => {
    const { app, hub } = setup();
    const post = (route: string, body: unknown) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await post("worktrees", {
      branch: "x",
      base: "main",
      startSession: true,
    });
    expect(created.status).toBe(200);
    expect(hub.checkouts.createWorktree).toHaveBeenCalledWith(project.id, {
      branch: "x",
      base: "main",
      startSession: true,
    });
    await expect(created.json()).resolves.toMatchObject({
      worktree: { branch: "x" },
    });
    await post("worktrees/remove", { path: "/p", force: "yes" });
    expect(hub.checkouts.removeWorktree).toHaveBeenCalledWith(
      project.id,
      "/p",
      false,
      false
    );
    await expect(
      (await post("sessions", { directory: "/d" })).json()
    ).resolves.toStrictEqual({ sessionId: "ses_1" });
    await expect(
      (await post("open", { editor: "zed", directory: "/d" })).json()
    ).resolves.toStrictEqual({ ok: true });
    expect(hub.checkouts.openInEditor).toHaveBeenCalledWith(
      project.id,
      "zed",
      "/d"
    );
    expect((await post("worktrees/refresh", {})).status).toBe(200);
    const branches = await app.request(`/api/projects/${project.id}/branches`);
    await expect(branches.json()).resolves.toMatchObject({
      branches: [{ name: "review/pr-1", prUrl: "https://f.example/pulls/1" }],
    });
    expect(hub.checkouts.branches).toHaveBeenCalledWith(project.id);
  });

  it.each([
    [new InvalidRequestError("bad"), 400],
    [new EditorUnavailableError("no"), 400],
    [new NotFoundError("x"), 404],
    [new BusyError("x"), 409],
    [new UnavailableError("stopped"), 412],
    [new CommandError("git worktree failed: fatal"), 422],
    [new Error("boom"), 500],
  ])("maps %s to %i with its message", async (err, status) => {
    const { app, hub } = setup();
    hub.checkouts.openInEditor.mockImplementationOnce(() => {
      throw err;
    });
    const res = await app.request(`/api/projects/${project.id}/open`, {
      method: "POST",
    });
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toStrictEqual({ error: err.message });
  });

  it("rejects cross-site POST actions with a mismatched Origin", async () => {
    const { app, hub } = setup();
    const res = await app.request(`/api/projects/${project.id}/start`, {
      method: "POST",
      headers: { origin: "http://evil.example", host: "localhost:7777" },
    });
    expect(res.status).toBe(403);
    expect(hub.environments.start).not.toHaveBeenCalled();
  });

  it("allows same-origin POST actions (Origin matches Host)", async () => {
    const { app, hub } = setup();
    const res = await app.request(`/api/projects/${project.id}/start`, {
      method: "POST",
      headers: { origin: "http://localhost:7777", host: "localhost:7777" },
    });
    expect(res.status).toBe(202);
    expect(hub.environments.start).toHaveBeenCalledWith(project.id);
  });

  it("sets X-Frame-Options: DENY on responses", async () => {
    const { app } = setup();
    const res = await app.request("/api/projects");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses actions while preflight has errors", async () => {
    const { app, store, hub } = setup();
    store.setPreflight({ errors: ["Docker daemon is not reachable"] });
    const res = await app.request(`/api/projects/${project.id}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(412);
    expect(hub.environments.start).not.toHaveBeenCalled();
  });

  it("rescan re-runs discovery and returns the snapshot", async () => {
    const { app, hub } = setup();
    const res = await app.request("/api/projects/rescan", { method: "POST" });
    expect(res.status).toBe(200);
    expect(hub.environments.rescan).toHaveBeenCalled();
  });

  it("saves roots, rescans and returns the snapshot", async () => {
    const deps = setup();
    const saveRoots = vi.fn((input: unknown) => {
      if (!Array.isArray(input) || input.includes("rel")) {
        throw new InvalidRootError("bad root");
      }
      deps.store.setRoots(input as string[]);
    });
    const app = createDashboardApp({ ...deps, saveRoots });
    const post = (roots: unknown) =>
      app.request("/api/settings/roots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots }),
      });
    const res = await post(["/code"]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roots: string[] }).roots).toStrictEqual([
      "/code",
    ]);
    expect(deps.hub.environments.rescan).toHaveBeenCalledOnce();
    expect((await post(["rel"])).status).toBe(400);
    expect(deps.hub.environments.rescan).toHaveBeenCalledOnce();
  });

  it("renames a project, and reports when renaming isn't wired", async () => {
    const deps = setup();
    const renameProject = vi.fn(async (_id: string, _name: string) => {});
    const app = createDashboardApp({ ...deps, renameProject });
    const post = (target: typeof app, body: unknown) =>
      target.request(`/api/projects/${project.id}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(app, { name: "Acme" })).status).toBe(200);
    expect(renameProject).toHaveBeenCalledWith(project.id, "Acme");
    expect((await post(app, { name: 3 })).status).toBe(400);
    expect((await post(deps.app, { name: "Acme" })).status).toBe(412);
  });

  it("accepts two or three project initials and palette colors", async () => {
    const deps = setup();
    const save = vi.fn((id: string, appearance: ProjectAppearance) => {
      expect(id).toBe(project.id);
      return appearance;
    });
    const app = createDashboardApp({
      ...deps,
      projectAppearance: { save },
    });
    const post = (body: unknown) =>
      app.request(`/api/projects/${project.id}/appearance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const saved = await post({ shortName: "OD", color: "violet" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toStrictEqual({
      shortName: "OD",
      color: "violet",
    });
    expect(save).toHaveBeenCalledWith(project.id, {
      shortName: "OD",
      color: "violet",
    });
    expect((await post({ shortName: "ODE", color: "blue" })).status).toBe(200);
    expect(save).toHaveBeenLastCalledWith(project.id, {
      shortName: "ODE",
      color: "blue",
    });
    expect((await post({ shortName: "", color: "" })).status).toBe(200);
    expect(save).toHaveBeenLastCalledWith(project.id, {
      shortName: undefined,
      color: undefined,
    });
    expect((await post({ shortName: "O", color: "red" })).status).toBe(400);
    expect((await post({ shortName: "ODEV", color: "red" })).status).toBe(400);
    expect((await post({ shortName: "12", color: "red" })).status).toBe(400);
    expect((await post({ shortName: "OD", color: "chartreuse" })).status).toBe(
      400
    );
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("includes saved project appearance in dashboard snapshots", () => {
    const store = new StateStore({
      ...stateStores(),
      port: 7777,
      projectAppearance: () => ({ shortName: "OD", color: "blue" }),
    });
    store.setProjects([project]);
    expect(store.snapshot().projects[0]?.appearance).toStrictEqual({
      shortName: "OD",
      color: "blue",
    });

    store.setProjectAppearance(project.id, { shortName: "DH", color: "teal" });
    expect(store.snapshot().projects[0]?.appearance).toStrictEqual({
      shortName: "DH",
      color: "teal",
    });
  });

  it("reads three-letter names from project settings", () => {
    expect(
      readProjectAppearance({ shortName: "ode", color: "violet" })
    ).toStrictEqual({ shortName: "ODE", color: "violet" });
    expect(readProjectAppearance({ shortName: "four" })).toStrictEqual({});
  });

  it("answers an unknown API path with a JSON 404, not the page", async () => {
    const { app } = setup();
    const res = await app.request("/api/projects/x/nonexistent");
    expect(res.status).toBe(404);
    expect(await res.json()).toStrictEqual({
      error: "no such API route: GET /api/projects/x/nonexistent",
    });
  });

  it("reads and saves a project's own forwarded ports", async () => {
    const deps = setup();
    let saved = [3000];
    const projectPorts = {
      get: vi.fn((_id: string) => saved),
      save: vi.fn(async (_id: string, ports: number[]) => {
        saved = ports;
      }),
    };
    const app = createDashboardApp({ ...deps, projectPorts });
    const url = `/api/projects/${project.id}/ports`;
    const post = (target: typeof app, body: unknown) =>
      target.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(await (await app.request(url)).json()).toStrictEqual({
      ports: [3000],
    });
    const res = await post(app, { ports: [3000, 8080] });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ports: [3000, 8080] });
    expect(projectPorts.save).toHaveBeenCalledWith(project.id, [3000, 8080]);
    expect((await post(app, { ports: [0] })).status).toBe(400);
    expect((await post(app, { ports: ["80"] })).status).toBe(400);
    expect((await post(deps.app, { ports: [] })).status).toBe(412);
  });

  it("reads and saves a project's host ports", async () => {
    const deps = setup();
    let saved = [9222];
    const projectHostPorts = {
      get: vi.fn((_id: string) => saved),
      save: vi.fn(async (_id: string, ports: number[]) => {
        if (ports.includes(3000)) {
          throw new InvalidRequestError(
            "port 3000 is already a forwarded port of this project"
          );
        }
        saved = ports;
      }),
    };
    const app = createDashboardApp({ ...deps, projectHostPorts });
    const url = `/api/projects/${project.id}/host-ports`;
    const post = (target: typeof app, body: unknown) =>
      target.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(await (await app.request(url)).json()).toStrictEqual({
      ports: [9222],
    });
    const res = await post(app, { ports: [9222, 5432] });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ports: [9222, 5432] });
    expect(projectHostPorts.save).toHaveBeenCalledWith(
      project.id,
      [9222, 5432]
    );
    const overlap = await post(app, { ports: [3000] });
    expect(overlap.status).toBe(400);
    expect(await overlap.json()).toStrictEqual({
      error: "port 3000 is already a forwarded port of this project",
    });
    expect((await post(app, { ports: [0] })).status).toBe(400);
    expect((await post(app, { ports: [70_000] })).status).toBe(400);
    expect((await post(deps.app, { ports: [] })).status).toBe(412);
  });

  it("reads and saves the global and a project's personalization, rejecting what the CLI can't use", async () => {
    const deps = setup();
    const view = { personalization: { features: {} } };
    const personalization = {
      get: vi.fn(() => view),
      save: vi.fn((_p: unknown) => view),
    };
    const projectView = {
      effective: { features: {}, setupCommands: [] },
      global: { features: {} },
      personalization: { features: {}, inheritGlobal: true },
      rebuildNeeded: false,
    };
    const projectPersonalization = {
      get: vi.fn((_id: string) => projectView),
      save: vi.fn((_id: string, _p: unknown) => projectView),
    };
    const app = createDashboardApp({
      ...deps,
      personalization,
      projectPersonalization,
    });
    const put = (target: typeof app, url: string, body: unknown) =>
      target.request(url, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
    const global = "/api/settings/personalization";
    const own = `/api/projects/${project.id}/personalization`;
    expect(await (await app.request(global)).json()).toStrictEqual(view);
    expect(await (await app.request(own)).json()).toStrictEqual(projectView);
    const body = {
      dotfiles: { repository: "tim/dotfiles" },
      features: { "ghcr.io/x/features/git-town:1": {} },
      mounts: [{ source: "~/notes", target: "/home/node/notes", type: "bind" }],
      setupCommand: "echo hi",
    };
    expect((await put(app, global, body)).status).toBe(200);
    expect(personalization.save).toHaveBeenCalledWith(body);
    expect(
      (await put(app, own, { ...body, inheritGlobal: false })).status
    ).toBe(200);
    expect(projectPersonalization.save).toHaveBeenCalledWith(project.id, {
      ...body,
      inheritGlobal: false,
    });
    expect(
      (await put(app, global, { features: { "./local": {} } })).status
    ).toBe(400);
    expect(
      (
        await put(app, global, {
          dotfiles: { repository: "--upload-pack=x" },
          features: {},
        })
      ).status
    ).toBe(400);
    expect(
      (
        await put(app, global, {
          features: {},
          mounts: [{ source: "~/x", target: "/opendevhub/x", type: "bind" }],
        })
      ).status
    ).toBe(400);
    expect((await put(app, own, body)).status).toBe(400);
    expect((await put(deps.app, global, body)).status).toBe(412);
  });

  it("serves the git setup and tests a host", async () => {
    const deps = setup();
    const view = {
      agent: { keys: [], running: true },
      hosts: [],
      identity: { name: "Dev" },
      keyFiles: [],
      projects: [],
      signing: { enabled: false },
    };
    const gitSetup = {
      test: vi.fn(async (host: string) => ({ message: host, ok: true })),
      view: vi.fn(async () => view),
    };
    const app = createDashboardApp({ ...deps, gitSetup });
    await expect(
      (await app.request("/api/settings/git")).json()
    ).resolves.toStrictEqual(view);
    const res = await app.request("/api/settings/git/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "code.example.com" }),
    });
    await expect(res.json()).resolves.toStrictEqual({
      message: "code.example.com",
      ok: true,
    });
    expect((await deps.app.request("/api/settings/git")).status).toBe(412);
  });

  it("GET logs returns buffered lines", async () => {
    const { app } = setup();
    await expect(
      (await app.request(`/api/projects/${project.id}/logs`)).json()
    ).resolves.toStrictEqual({ lines: ["a", "b"] });
  });

  it("GET /api/events starts with a snapshot event", async () => {
    const { app } = setup();
    const res = await app.request("/api/events");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    expect(text).not.toContain("secret");
    await reader.cancel();
  });

  it("serves the SPA with index.html fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-web-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html>app</html>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    const { app } = setup(dir);
    await expect((await app.request("/")).text()).resolves.toContain("app");
    await expect((await app.request("/some/route")).text()).resolves.toContain(
      "app"
    );
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("explains how to build the UI when no webDir is available", async () => {
    const { app } = setup(undefined);
    const res = await app.request("/");
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toContain("npm run build");
  });
  describe("responding", () => {
    const send = (
      app: ReturnType<typeof setup>["app"],
      method: string,
      route: string,
      body: unknown,
      origin?: string
    ) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method,
        headers: {
          "content-type": "application/json",
          host: "localhost:7777",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      });

    it("forwards permission replies, form answers and dismissals", async () => {
      const { app, hub } = setup();
      expect(
        (
          await send(app, "POST", "permissions/per_1", {
            decision: "reject",
            message: "no",
          })
        ).status
      ).toBe(200);
      expect(hub.sessions.replyPermission).toHaveBeenCalledWith(
        project.id,
        "per_1",
        { decision: "reject", message: "no" }
      );
      expect(
        (await send(app, "POST", "forms/frm_1", { answer: { db: "pg" } }))
          .status
      ).toBe(200);
      expect(hub.sessions.replyForm).toHaveBeenCalledWith(project.id, "frm_1", {
        db: "pg",
      });
      expect((await send(app, "DELETE", "forms/frm_1", undefined)).status).toBe(
        200
      );
      expect(hub.sessions.cancelForm).toHaveBeenCalledWith(project.id, "frm_1");
    });

    it("removes a session, and answers 404 for one it doesn't list", async () => {
      const { app, hub } = setup();
      expect(
        (await send(app, "DELETE", "sessions/ses_1", undefined)).status
      ).toBe(200);
      expect(hub.sessions.removeSession).toHaveBeenCalledWith(
        project.id,
        "ses_1"
      );
      hub.sessions.removeSession.mockRejectedValueOnce(
        new NotFoundError("ses_9", "session")
      );
      expect(
        (await send(app, "DELETE", "sessions/ses_9", undefined)).status
      ).toBe(404);
    });

    it("maps unknown ids to 404, already answered to 409 and invalid answers to 400 with the message", async () => {
      const { app, hub } = setup();
      hub.sessions.replyPermission.mockRejectedValueOnce(
        new NotFoundError("per_x", "permission request")
      );
      expect(
        (await send(app, "POST", "permissions/per_x", { decision: "once" }))
          .status
      ).toBe(404);

      hub.sessions.replyPermission.mockRejectedValueOnce(
        new AlreadyAnsweredError()
      );
      const gone = await send(app, "POST", "permissions/per_1", {
        decision: "once",
      });
      expect(gone.status).toBe(409);
      await expect(gone.json()).resolves.toStrictEqual({
        error: "already answered",
      });

      hub.sessions.replyForm.mockRejectedValueOnce(
        new InvalidRequestError("db is required")
      );
      const invalid = await send(app, "POST", "forms/frm_1", { answer: {} });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toStrictEqual({
        error: "db is required",
      });
    });

    it("blocks cross-site replies", async () => {
      const { app, hub } = setup();
      const res = await send(
        app,
        "POST",
        "permissions/per_1",
        { decision: "once" },
        "http://evil.example"
      );
      expect(res.status).toBe(403);
      expect(hub.sessions.replyPermission).not.toHaveBeenCalled();
    });
  });
  describe("review", () => {
    const post = (
      app: ReturnType<typeof setup>["app"],
      route: string,
      body: unknown
    ) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("serves review data for a directory with an optional base, mode and file", async () => {
      const { app, hub } = setup();
      const res = await app.request(
        `/api/projects/${project.id}/review?directory=%2Fw%2Fx&base=main&mode=branch&file=a.ts`
      );
      expect(res.status).toBe(200);
      expect((await res.json()).directory).toBe("/w/x");
      expect(hub.reviews.review).toHaveBeenCalledWith(project.id, "/w/x", {
        base: "main",
        mode: "branch",
        file: "a.ts",
        from: undefined,
        session: undefined,
      });
      await app.request(
        `/api/projects/${project.id}/review?directory=%2Fw%2Fx`
      );
      expect(hub.reviews.review).toHaveBeenLastCalledWith(project.id, "/w/x", {
        base: undefined,
        mode: "working",
        file: undefined,
        from: undefined,
        session: undefined,
      });
      await app.request(
        `/api/projects/${project.id}/review?directory=%2Fw%2Fx&mode=turn&session=ses_1&from=msg_2`
      );
      expect(hub.reviews.review).toHaveBeenLastCalledWith(project.id, "/w/x", {
        base: undefined,
        mode: "turn",
        file: undefined,
        from: "msg_2",
        session: "ses_1",
      });
      expect(
        (
          await app.request(
            `/api/projects/${project.id}/review?directory=%2Fw%2Fx&mode=committed`
          )
        ).status
      ).toBe(400);
      hub.reviews.review.mockRejectedValueOnce(
        new InvalidRequestError(
          "/etc is neither the workspace nor a known worktree"
        )
      );
      expect(
        (
          await app.request(
            `/api/projects/${project.id}/review?directory=%2Fetc`
          )
        ).status
      ).toBe(400);
    });

    it("serves one version of a changed image", async () => {
      const { app, hub } = setup();
      const res = await app.request(
        `/api/projects/${project.id}/review/image?directory=%2Fw%2Fx&file=img%2Flogo.png&side=new&mode=branch&base=main`
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await res.arrayBuffer())).toStrictEqual(
        new Uint8Array([0x89, 0x50])
      );
      expect(hub.reviews.reviewImage).toHaveBeenCalledWith(project.id, "/w/x", {
        base: "main",
        file: "img/logo.png",
        mode: "branch",
        side: "new",
      });
      const image = (query: string) =>
        app.request(`/api/projects/${project.id}/review/image?${query}`);
      expect(
        (await image("directory=%2Fw%2Fx&file=logo.png&side=old")).status
      ).toBe(404);
      expect(
        (await image("directory=%2Fw%2Fx&file=logo.png&side=both")).status
      ).toBe(400);
      hub.reviews.reviewImage.mockRejectedValueOnce(
        new InvalidRequestError("not an image in the checkout: a.ts")
      );
      expect(
        (await image("directory=%2Fw%2Fx&file=a.ts&side=new")).status
      ).toBe(400);
    });

    it("runs commit, update and merge, and suggests commit messages", async () => {
      const { app, hub } = setup();
      await expect(
        (await post(app, "review/commit-message", { directory: "/w" })).json()
      ).resolves.toStrictEqual({ message: "feat: x" });
      expect(
        (await post(app, "review/commit", { directory: "/w", message: "m" }))
          .status
      ).toBe(200);
      expect(hub.reviews.commit).toHaveBeenCalledWith(project.id, "/w", "m");
      await expect(
        (
          await post(app, "review/update", { directory: "/w", base: "main" })
        ).json()
      ).resolves.toStrictEqual({ strategy: "rebase" });
      await expect(
        (
          await post(app, "review/merge", {
            directory: "/w",
            base: "main",
            ffOnly: true,
          })
        ).json()
      ).resolves.toStrictEqual({ branch: "x" });
      expect(hub.reviews.mergeIntoBase).toHaveBeenCalledWith(
        project.id,
        "/w",
        "main",
        true
      );
      hub.reviews.commit.mockRejectedValueOnce(
        new CommandError("git has no user.name/user.email in the container.")
      );
      const failed = await post(app, "review/commit", {
        directory: "/w",
        message: "m",
      });
      expect(failed.status).toBe(422);
      expect((await failed.json()).error).toMatch(/user\.name/u);
    });

    it("answers a session's detail, 404 for an unknown session", async () => {
      const { app, hub } = setup();
      const missing = await app.request(
        `/api/projects/${project.id}/sessions/ses_x`
      );
      expect(missing.status).toBe(404);
      hub.sessions.sessionDetail.mockResolvedValueOnce({
        createdAt: 1,
        more: false,
        session: {
          directory: "/w",
          id: "ses_1",
          projectId: project.id,
          status: "idle",
          title: "Fix",
          updatedAt: 2,
        },
        subagents: [],
        transcript: [],
        turns: [],
      });
      const res = await app.request(
        `/api/projects/${project.id}/sessions/ses_1`
      );
      expect(res.status).toBe(200);
      expect((await res.json()).session.title).toBe("Fix");
      expect(hub.sessions.sessionDetail).toHaveBeenLastCalledWith(
        project.id,
        "ses_1"
      );
    });

    it("sends a composer message and serves a checkout's commands, agents and files", async () => {
      const { app, hub } = setup();
      const message = {
        text: "explain @a.ts",
        mentions: [{ kind: "file", start: 8, end: 13, name: "a.ts" }],
      };
      const sent = await post(app, "sessions/ses_1/send", message);
      expect(sent.status).toBe(200);
      expect(await sent.json()).toStrictEqual({
        kind: "prompt",
        queued: false,
      });
      expect(hub.sessions.sendMessage).toHaveBeenCalledWith(
        project.id,
        "ses_1",
        message
      );
      expect(
        (
          await post(app, "sessions/ses_1/send", {
            text: "x",
            mentions: [{ kind: "skill", start: 0, end: 1, name: "x" }],
          })
        ).status
      ).toBe(400);
      const base = `/api/projects/${project.id}/composer`;
      const dir = "directory=%2Fw";
      expect(
        await (await app.request(`${base}/commands?${dir}`)).json()
      ).toStrictEqual({ commands: [{ name: "new", hub: true }] });
      expect(
        await (await app.request(`${base}/agents?${dir}`)).json()
      ).toStrictEqual({ agents: [{ id: "explore", name: "Explore" }] });
      expect(
        await (await app.request(`${base}/files?${dir}&query=a`)).json()
      ).toStrictEqual({ files: ["src/a.ts"] });
      expect(hub.sessions.findFiles).toHaveBeenCalledWith(
        project.id,
        "/w",
        "a"
      );
      expect((await app.request(`${base}/files?${dir}`)).status).toBe(400);
    });

    it("starts a chat with its target and first message, and refuses a malformed target", async () => {
      const { app, hub } = setup();
      const body = {
        target: { kind: "checkout", directory: "/w" },
        message: { text: "/opsx-propose add x" },
      };
      const res = await post(app, "chat", body);
      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({ chat: "c_1" });
      expect(hub.chat.start).toHaveBeenCalledWith(project.id, body);
      expect(
        (
          await post(app, "chat", {
            target: { kind: "checkout" },
            message: { text: "x" },
          })
        ).status
      ).toBe(400);
      expect(
        (await post(app, "chat", { target: { kind: "elsewhere" } })).status
      ).toBe(400);
    });

    it("looks up, archives, briefs and makes a task of a chat", async () => {
      const { app, hub } = setup();
      const chat = `/api/projects/${project.id}/chats/c_1`;
      expect(await (await app.request(chat)).json()).toStrictEqual({
        adoptedBy: { n: 1, task: "tsk_1" },
      });
      expect(await (await app.request(`${chat}/brief`)).json()).toStrictEqual({
        brief: "Goal",
      });
      expect(
        await (await app.request(`${chat}/suggestions`)).json()
      ).toStrictEqual({ pullRequests: [], tickets: ["APP-42"] });
      expect((await post(app, "chats/c_1/archive", {})).status).toBe(200);
      expect(hub.chat.archive).toHaveBeenCalledWith(project.id, "c_1");
      const body = {
        brief: "b",
        spec: true,
        title: "Dark mode",
        variants: [{ agent: "plan" }],
      };
      const made = await post(app, "chats/c_1/task", body);
      expect(await made.json()).toStrictEqual({ task: "tsk_2" });
      expect(hub.chat.makeTask).toHaveBeenCalledWith(project.id, "c_1", body);
      expect((await post(app, "chats/c_1/task", { title: "x" })).status).toBe(
        400
      );
    });

    it("creates, edits and starts drafts, and drafts from a ticket", async () => {
      const { app, hub } = setup();
      const draft = await post(app, "drafts", { prompt: "", title: "Later" });
      expect(await draft.json()).toStrictEqual({ task: "tsk_d" });
      const jira = {
        description: "d",
        instanceUrl: "https://jira.example",
        key: "APP-42",
        title: "Dark mode",
      };
      expect(
        await (await post(app, "drafts/ticket", { jira })).json()
      ).toStrictEqual({ task: "tsk_j" });
      expect(hub.tasks.draftFromTicket).toHaveBeenCalledWith(project.id, {
        jira,
      });
      expect((await post(app, "drafts/ticket", {})).status).toBe(400);
      const edit = await app.request(
        `/api/projects/${project.id}/tasks/tsk_d/draft`,
        {
          body: JSON.stringify({ prompt: "p" }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        }
      );
      expect(edit.status).toBe(200);
      expect(hub.tasks.editDraft).toHaveBeenCalledWith(project.id, "tsk_d", {
        prompt: "p",
      });
      const started = await post(app, "tasks/tsk_d/start", { prompt: "p" });
      expect(await started.json()).toStrictEqual({
        task: "tsk_d",
        variants: [],
      });
    });

    it("prompts a session, starts one with a prompt, and removes a worktree with its branch", async () => {
      const { app, hub } = setup();
      expect(
        (await post(app, "sessions/ses_1/prompt", { text: "fix" })).status
      ).toBe(200);
      expect(hub.sessions.promptSession).toHaveBeenCalledWith(
        project.id,
        "ses_1",
        "fix"
      );
      await post(app, "sessions", {
        directory: "/w",
        title: "Review",
        prompt: "look",
      });
      expect(hub.sessions.startSession).toHaveBeenLastCalledWith(
        project.id,
        "/w",
        "Review",
        "look"
      );
      await post(app, "worktrees/remove", {
        path: "/w",
        force: false,
        deleteBranch: true,
      });
      expect(hub.checkouts.removeWorktree).toHaveBeenLastCalledWith(
        project.id,
        "/w",
        false,
        true
      );
    });
  });
  describe("publish", () => {
    const post = (
      app: ReturnType<typeof setup>["app"],
      route: string,
      body: unknown
    ) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("serves publish info, suggestions and publishes", async () => {
      const { app, hub } = setup();
      const info = await app.request(
        `/api/projects/${project.id}/publish?directory=%2Fw&remote=fork`
      );
      expect(info.status).toBe(200);
      expect(hub.reviews.publishInfo).toHaveBeenCalledWith(
        project.id,
        "/w",
        "fork"
      );
      await expect(
        (await post(app, "publish/suggest", { directory: "/w" })).json()
      ).resolves.toStrictEqual({ title: "t", description: "d" });
      const body = {
        directory: "/w",
        remote: "origin",
        base: "main",
        strategy: "branch",
        title: "T",
        description: "D",
      };
      expect((await post(app, "publish", body)).status).toBe(200);
      expect(hub.reviews.publish).toHaveBeenCalledWith(project.id, "/w", {
        remote: "origin",
        base: "main",
        strategy: "branch",
        title: "T",
        description: "D",
      });
      hub.reviews.publish.mockRejectedValueOnce(
        new CommandError(
          "the branch on origin has commits this one doesn't (pushed from elsewhere, or rebased); pull them in with `git pull origin x`, then publish again"
        )
      );
      const rejected = await post(app, "publish", body);
      expect(rejected.status).toBe(422);
      expect((await rejected.json()).error).toMatch(/git pull origin/u);
    });
  });
  describe("tasks", () => {
    const post = (
      app: ReturnType<typeof setup>["app"],
      route: string,
      body: unknown
    ) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("starts tasks, lists models, picks a variant and passes a worktree's first prompt", async () => {
      const { app, hub } = setup();
      const body = { prompt: "Fix it", variants: [{}] };
      const res = await post(app, "tasks", body);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual({
        task: "tsk_1",
        variants: [],
      });
      expect(hub.tasks.startTask).toHaveBeenCalledWith(project.id, body);
      const dismissed = await app.request(
        `/api/projects/${project.id}/tasks/tsk_1/starting`,
        { method: "DELETE" }
      );
      expect(dismissed.status).toBe(200);
      expect(hub.tasks.dismissStarting).toHaveBeenCalledWith(
        project.id,
        "tsk_1"
      );
      const archived = await post(app, "tasks/tsk_1/archive", {});
      expect(archived.status).toBe(200);
      expect(hub.tasks.archiveTask).toHaveBeenCalledWith(project.id, "tsk_1");
      const archivedList = await app.request(
        `/api/projects/${project.id}/tasks/archived`
      );
      expect(archivedList.status).toBe(200);
      await expect(archivedList.json()).resolves.toStrictEqual([]);
      expect(hub.tasks.archivedTasks).toHaveBeenCalledWith(project.id);
      expect((await post(app, "tasks/tsk_1/restore", {})).status).toBe(200);
      expect(hub.tasks.restoreTask).toHaveBeenCalledWith(project.id, "tsk_1");
      expect(
        (
          await app.request(`/api/projects/${project.id}/tasks/tsk_1`, {
            method: "DELETE",
          })
        ).status
      ).toBe(200);
      expect(hub.tasks.deleteArchivedTask).toHaveBeenCalledWith(
        project.id,
        "tsk_1"
      );
      hub.tasks.archiveTask.mockImplementationOnce(() => {
        throw new NotFoundError("tsk_2", "task");
      });
      expect((await post(app, "tasks/tsk_2/archive", {})).status).toBe(404);
      await expect(
        (await app.request(`/api/projects/${project.id}/models`)).json()
      ).resolves.toStrictEqual({ models: [], agents: [] });
      await expect(
        (
          await post(app, "tasks/tsk_1/pick", {
            sessionId: "ses_1",
            removeWorktrees: true,
          })
        ).json()
      ).resolves.toStrictEqual({
        discarded: ["ses_2"],
        removed: [],
        errors: [],
      });
      expect(hub.tasks.pickVariant).toHaveBeenCalledWith(
        project.id,
        "tsk_1",
        "ses_1",
        true
      );
      await post(app, "worktrees", {
        branch: "b",
        startSession: true,
        prompt: "go",
      });
      expect(hub.checkouts.createWorktree).toHaveBeenLastCalledWith(
        project.id,
        {
          branch: "b",
          base: undefined,
          startSession: true,
          prompt: "go",
        }
      );
    });

    it("maps task errors to statuses", async () => {
      const { app, hub } = setup();
      hub.tasks.startTask.mockRejectedValueOnce(
        new InvalidRequestError("the prompt is empty")
      );
      const bad = await post(app, "tasks", { prompt: "" });
      expect(bad.status).toBe(400);
      await expect(bad.json()).resolves.toStrictEqual({
        error: "the prompt is empty",
      });
      hub.tasks.startTask.mockRejectedValueOnce(new BusyError(project.id));
      expect((await post(app, "tasks", { prompt: "x" })).status).toBe(409);
      hub.tasks.pickVariant.mockRejectedValueOnce(
        new NotFoundError("ses_9", "variant")
      );
      expect(
        (await post(app, "tasks/tsk_1/pick", { sessionId: "ses_9" })).status
      ).toBe(404);
      hub.sessions.models.mockRejectedValueOnce(
        new UnavailableError(
          "opencode is not running — start the project first"
        )
      );
      expect(
        (await app.request(`/api/projects/${project.id}/models`)).status
      ).toBe(412);
    });

    it("blocks cross-site task creation", async () => {
      const { app, hub } = setup();
      const res = await app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example",
          host: "localhost:7777",
        },
        body: JSON.stringify({ prompt: "x" }),
      });
      expect(res.status).toBe(403);
      expect(hub.tasks.startTask).not.toHaveBeenCalled();
    });
  });
});

describe("add project", () => {
  const post = (app: ReturnType<typeof setup>["app"], body: unknown) =>
    app.request("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("GET candidates returns the onboarding list", async () => {
    const { app } = setup();
    await expect(
      (await app.request("/api/onboarding/candidates")).json()
    ).resolves.toStrictEqual({ roots: ["/src"], candidates: [added] });
  });

  it("writes, rescans, starts the new project and returns its id", async () => {
    const { app, onboarding, hub } = setup();
    const res = await post(app, { path: "/src/new-app", stack: "node" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({
      projectId: newProject.id,
      started: true,
    });
    expect(onboarding.add).toHaveBeenCalledWith("/src/new-app", "node");
    expect(hub.environments.rescan).toHaveBeenCalled();
    expect(hub.environments.start).toHaveBeenCalledWith(newProject.id);
  });

  it("writes but does not start while preflight has errors", async () => {
    const { app, store, hub } = setup();
    store.setPreflight({ errors: ["docker not found"] });
    const res = await post(app, { path: "/src/new-app", stack: "node" });
    await expect(res.json()).resolves.toStrictEqual({
      projectId: newProject.id,
      started: false,
      error: "docker not found",
    });
    expect(hub.environments.start).not.toHaveBeenCalled();
  });

  it.each([
    [new InvalidRequestError("unknown stack x"), 400],
    [new NotFoundError("/etc", "repo without a devcontainer"), 404],
    [new DevcontainerExistsError("/src/new-app"), 409],
    [new Error("EACCES: permission denied"), 500],
  ])("maps %s to %i without rescanning", async (err, status) => {
    const { app, onboarding, hub } = setup();
    onboarding.add.mockRejectedValueOnce(err);
    const res = await post(app, { path: "/src/new-app", stack: "node" });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(err.message);
    expect(hub.environments.rescan).not.toHaveBeenCalled();
  });

  it("passes a missing path through as an empty string", async () => {
    const { app, onboarding } = setup();
    await post(app, { stack: "node" });
    expect(onboarding.add).toHaveBeenCalledWith("", "node");
  });

  it("blocks a cross-site POST", async () => {
    const { app, onboarding } = setup();
    const res = await app.request("/api/onboarding", {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        host: "localhost:7777",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "/src/new-app", stack: "node" }),
    });
    expect(res.status).toBe(403);
    expect(onboarding.add).not.toHaveBeenCalled();
  });
});

describe("cleanup endpoints", () => {
  it("scans on GET", async () => {
    const { app, cleanup } = setup();
    const res = await app.request("/api/cleanup");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({
      scannedAt: 1,
      projects: [],
      items: [],
    });
    expect(cleanup.scan).toHaveBeenCalled();
  });

  it("applies the parsed selection on POST", async () => {
    const { app, cleanup } = setup();
    const res = await app.request("/api/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ kind: "container", containerId: "c1" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(cleanup.apply.mock.calls[0][0]).toMatchObject([
      { id: "container:c1", kind: "container" },
    ]);
  });

  it("answers 400 for a malformed body and 409 while an apply runs", async () => {
    const { app, cleanup } = setup();
    const post = (body: unknown) =>
      app.request("/api/cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ items: "x" })).status).toBe(400);
    cleanup.apply.mockRejectedValueOnce(new BusyError("cleanup"));
    expect((await post({ items: [] })).status).toBe(409);
  });
});

describe("activity endpoints", () => {
  const withActivity = () => {
    const deps = setup();
    const dbs = memoryStores();
    dbs.projects.upsertAll([
      {
        devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
        id: "demo",
        name: "demo",
        path: "/src/demo",
      },
    ]);
    // Only the tasks' events.
    dbs.db.exec("DELETE FROM events");
    for (const id of ["tsk_1", "tsk_2", "tsk_3"]) {
      dbs.tasks.createTask({
        createdAt: 1,
        id,
        projectId: "demo",
        prompt: id,
        title: `Task ${id}`,
        variants: [{}],
      });
    }
    const app = createDashboardApp({
      ...deps,
      activity: new EventStore(dbs.db),
      provenance: new ProvenanceStore(dbs.db),
    });
    return { app, dbs };
  };

  it("pages the feed and filters it by project, task and entity", async () => {
    const { app } = withActivity();
    const get = async (query: string) => {
      const res = await app.request(`/api/activity${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as ActivityPage;
    };
    const first = await get("?limit=2");
    expect(first.events.map((e) => e.taskTitle)).toStrictEqual([
      "Task tsk_3",
      "Task tsk_2",
    ]);
    const rest = await get(`?limit=2&before=${first.next}`);
    expect(rest.events.map((e) => e.taskId)).toStrictEqual(["tsk_1"]);
    expect(rest.next).toBe(undefined);
    expect((await get("?project=demo")).events).toHaveLength(3);
    expect((await get("?project=other")).events).toHaveLength(0);
    expect((await get("?task=tsk_2")).events.map((e) => e.verb)).toStrictEqual([
      "task.started",
    ]);
    expect(
      (await get("?entity=task:tsk_1")).events.map((e) => e.object.id)
    ).toStrictEqual(["tsk_1"]);
  });

  it("rejects bad cursors, limits and entities", async () => {
    const { app } = withActivity();
    for (const query of [
      "?before=0",
      "?before=x",
      "?limit=201",
      "?entity=task",
      "?entity=thing:1",
      "?entity=task:",
    ]) {
      expect((await app.request(`/api/activity${query}`)).status).toBe(400);
    }
  });

  it("serves an entity's provenance, 404 for an unknown one, and 412 without the log", async () => {
    const { app } = withActivity();
    const res = await app.request(
      `/api/provenance/variant/${encodeURIComponent("tsk_1/1")}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Provenance;
    expect(body.trail.map((s) => s.label)).toStrictEqual([
      "demo",
      "Task tsk_1",
      "Variant 1",
    ]);
    expect((await app.request("/api/provenance/task/nope")).status).toBe(404);
    expect((await app.request("/api/provenance/thing/1")).status).toBe(404);
    expect((await setup().app.request("/api/activity")).status).toBe(412);
  });
});

describe("checks endpoints", () => {
  const post = (
    app: ReturnType<typeof setup>["app"],
    route: string,
    body: unknown
  ) =>
    app.request(`/api/projects/demo-abc123/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists the checks, with a directory's run when given", async () => {
    const { app, checks } = setup();
    expect((await app.request("/api/projects/demo-abc123/checks")).status).toBe(
      200
    );
    await app.request("/api/projects/demo-abc123/checks?directory=%2Fw");
    expect(checks.view.mock.calls).toStrictEqual([
      ["demo-abc123", undefined],
      ["demo-abc123", "/w"],
    ]);
    const latest = await app.request(
      "/api/projects/demo-abc123/checks/run?directory=%2Fw"
    );
    await expect(latest.json()).resolves.toMatchObject({
      run: { directory: "/w" },
    });
  });

  it("starts a run with only well-formed names and approvals", async () => {
    const { app, checks } = setup();
    expect(
      (
        await post(app, "checks/run", {
          directory: "/w",
          names: ["test", 3],
          approve: ["docker build ."],
        })
      ).status
    ).toBe(200);
    expect(checks.start).toHaveBeenCalledWith("demo-abc123", "/w", {
      names: ["test"],
      approve: ["docker build ."],
    });
    await post(app, "checks/run", { directory: "/w" });
    expect(checks.start).toHaveBeenLastCalledWith("demo-abc123", "/w", {});
  });

  it("maps a run already going to 409 and a bad request to 400", async () => {
    const { app, checks } = setup();
    checks.start.mockRejectedValueOnce(new BusyError("/w"));
    expect((await post(app, "checks/run", { directory: "/w" })).status).toBe(
      409
    );
    checks.saveSettings.mockRejectedValueOnce(
      new InvalidRequestError("checks must be a list")
    );
    expect((await post(app, "checks/settings", { checks: "x" })).status).toBe(
      400
    );
  });

  it("saves or clears the project's own list", async () => {
    const { app, checks } = setup();
    await post(app, "checks/settings", {
      checks: [{ name: "t", command: "true" }],
    });
    await post(app, "checks/settings", { checks: null });
    expect(checks.saveSettings.mock.calls).toStrictEqual([
      ["demo-abc123", [{ name: "t", command: "true" }]],
      ["demo-abc123", null],
    ]);
  });
});
describe("node endpoints", () => {
  function withNodes() {
    const base = setup();
    const nodes = {
      add: vi.fn(async (input: { ssh: unknown; label?: unknown }) => {
        if (input.ssh === "-bad") {
          throw new InvalidNodeError("invalid ssh destination");
        }
        return {
          id: "box",
          label: "Box",
          ssh: String(input.ssh),
          state: "connecting" as const,
        };
      }),
      remove: vi.fn(async (id: string) => {
        if (id !== "box") {
          throw new NotFoundError(`no node ${id}`);
        }
      }),
    };
    const app = createDashboardApp({
      store: base.store,
      hub: base.hub,
      onboarding: base.onboarding,
      push: base.push,
      cleanup: base.cleanup,
      checks: base.checks,
      nodes,
    });
    return { app, nodes };
  }
  const post = (app: ReturnType<typeof createDashboardApp>, body: unknown) =>
    app.request("/api/nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("adds a node", async () => {
    const { app, nodes } = withNodes();
    const res = await post(app, { ssh: "tim@box", label: "Box" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "box",
      ssh: "tim@box",
    });
    expect(nodes.add).toHaveBeenCalledWith({ ssh: "tim@box", label: "Box" });
  });

  it("answers 400 for an invalid destination", async () => {
    const { app } = withNodes();
    expect((await post(app, { ssh: "-bad" })).status).toBe(400);
  });

  it("removes a node, and answers 404 for an unknown one", async () => {
    const { app, nodes } = withNodes();
    expect(
      (await app.request("/api/nodes/box", { method: "DELETE" })).status
    ).toBe(200);
    expect(nodes.remove).toHaveBeenCalledWith("box");
    expect(
      (await app.request("/api/nodes/nope", { method: "DELETE" })).status
    ).toBe(404);
  });

  it("answers 412 when nodes aren't available", async () => {
    const { app } = setup();
    expect((await post(app, { ssh: "tim@box" })).status).toBe(412);
  });
});

describe("forgejo preset endpoints", () => {
  const withPresets = () => {
    const base = setup();
    return createDashboardApp({
      store: base.store,
      hub: base.hub,
      onboarding: base.onboarding,
      push: base.push,
      cleanup: base.cleanup,
      checks: base.checks,
      forgejoPresets: new ForgejoPresetStore(openDatabase(":memory:")),
    });
  };
  const send = (
    app: ReturnType<typeof createDashboardApp>,
    method: string,
    url: string,
    body: unknown
  ) =>
    app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const filters = { inbox: "review", state: "open", authors: ["alex"] };

  it("saves, lists, updates and deletes presets", async () => {
    const app = withPresets();
    const created = await send(app, "POST", "/api/forgejo/presets", {
      name: "  Alex  ",
      filters,
    });
    await expect(created.json()).resolves.toStrictEqual({
      filters,
      id: 1,
      name: "Alex",
    });
    const renamed = await send(app, "PUT", "/api/forgejo/presets/1", {
      name: "Alex's",
    });
    expect(renamed.status).toBe(200);
    const list = await app.request("/api/forgejo/presets");
    await expect(list.json()).resolves.toStrictEqual({
      presets: [{ filters, id: 1, name: "Alex's" }],
    });
    expect(
      (await app.request("/api/forgejo/presets/1", { method: "DELETE" })).status
    ).toBe(200);
    expect(
      (await app.request("/api/forgejo/presets/1", { method: "DELETE" })).status
    ).toBe(404);
  });

  it("answers 409 for a taken name and 400 for bad filters", async () => {
    const app = withPresets();
    await send(app, "POST", "/api/forgejo/presets", { name: "A", filters });
    expect(
      (await send(app, "POST", "/api/forgejo/presets", { name: "a", filters }))
        .status
    ).toBe(409);
    expect(
      (
        await send(app, "POST", "/api/forgejo/presets", {
          name: "B",
          filters: { ...filters, authors: ["not a login"] },
        })
      ).status
    ).toBe(400);
    expect(
      (await send(app, "POST", "/api/forgejo/presets", { name: " ", filters }))
        .status
    ).toBe(400);
  });

  it("answers 412 when presets aren't available", async () => {
    const { app } = setup();
    expect((await app.request("/api/forgejo/presets")).status).toBe(412);
  });
});

describe("jira preset endpoints", () => {
  const withPresets = () => {
    const base = setup();
    return createDashboardApp({
      store: base.store,
      hub: base.hub,
      onboarding: base.onboarding,
      push: base.push,
      cleanup: base.cleanup,
      checks: base.checks,
      jiraPresets: new JiraPresetStore(openDatabase(":memory:")),
    });
  };
  const send = (
    app: ReturnType<typeof createDashboardApp>,
    method: string,
    url: string,
    body: unknown
  ) =>
    app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const filters = {
    board: 7,
    jql: "labels = api",
    scope: "board",
    search: "",
    sort: "rank",
    status: "open",
  };

  it("saves, lists and deletes presets, keeping JQL on one line", async () => {
    const app = withPresets();
    const created = await send(app, "POST", "/api/jira/presets", {
      name: "API board",
      filters: { ...filters, jql: "labels = api\n" },
    });
    await expect(created.json()).resolves.toStrictEqual({
      filters,
      id: 1,
      name: "API board",
    });
    const list = await app.request("/api/jira/presets");
    await expect(list.json()).resolves.toStrictEqual({
      presets: [{ filters, id: 1, name: "API board" }],
    });
    expect(
      (await app.request("/api/jira/presets/1", { method: "DELETE" })).status
    ).toBe(200);
  });

  it("answers 400 for a view whose board does not fit its scope", async () => {
    const app = withPresets();
    expect(
      (
        await send(app, "POST", "/api/jira/presets", {
          name: "Bad",
          filters: { ...filters, scope: "assigned" },
        })
      ).status
    ).toBe(400);
  });
});

describe("bring home", () => {
  it("fetches a remote checkout's branch", async () => {
    const { app, hub } = setup();
    const res = await app.request(
      `/api/projects/${project.id}/review/bring-home`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: "/workspaces/demo.worktrees/fix" }),
      }
    );
    await expect(res.json()).resolves.toStrictEqual({ branch: "fix" });
    expect(hub.checkouts.bringHome).toHaveBeenCalledWith(
      project.id,
      "/workspaces/demo.worktrees/fix"
    );
  });
});

describe("Hono RPC contract", () => {
  it("infers request fields and successful responses from server routes", () => {
    const taskRoute = rpcApi.projects[":id"].tasks;
    type Input = InferRequestType<typeof taskRoute.$post>["json"];
    expectTypeOf<Input["prompt"]>().toEqualTypeOf<string>();
    expectTypeOf<Input["where"]>().toEqualTypeOf<
      "workspace" | "worktree" | "existing" | undefined
    >();
    expectTypeOf<
      Awaited<ReturnType<typeof createTaskViaRpc>>
    >().toEqualTypeOf<TaskResult>();
    expectTypeOf<
      Awaited<ReturnType<typeof fetchModelsViaRpc>>
    >().toEqualTypeOf<ModelsInfo>();
  });

  it("round-trips frontend RPC calls through real routes, including encoded IDs and errors", async () => {
    const { app, hub } = setup();
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      app.request(new Request(new URL(input, "http://localhost:7777"), init))
    );
    try {
      await expect(fetchModelsViaRpc("demo/id?")).resolves.toStrictEqual({
        models: [],
        agents: [],
      });
      expect(hub.sessions.models).toHaveBeenCalledWith("demo/id?");
      const task = {
        prompt: "Fix",
        where: "worktree",
        variants: [{}],
      } as const;
      await expect(
        createTaskViaRpc(project.id, { ...task, variants: [{}] })
      ).resolves.toStrictEqual({ task: "tsk_1", variants: [] });
      expect(hub.tasks.startTask).toHaveBeenCalledWith(project.id, task);
      await postActionViaRpc(project.id, "rebuild-no-cache");
      expect(hub.environments.rebuild).toHaveBeenCalledWith(project.id, true);
      hub.sessions.replyPermission.mockRejectedValueOnce(
        new AlreadyAnsweredError()
      );
      await expect(
        replyPermissionViaRpc(project.id, "per/1", "once")
      ).resolves.toBe("gone");
      hub.sessions.models.mockRejectedValueOnce(
        new UnavailableError("Start the project first")
      );
      await expect(fetchModelsViaRpc(project.id)).rejects.toThrow(
        "Start the project first"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects malformed JSON and wrong body/query shapes before invoking domain operations", async () => {
    const { app, hub } = setup();
    const post = (body: string) =>
      app.request(`/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    const malformed = await post("{");
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toContain("application/json");
    const wrongShape = await post(JSON.stringify({ prompt: 42 }));
    expect(wrongShape.status).toBe(400);
    expect(hub.tasks.startTask).not.toHaveBeenCalled();
    expect(
      (await app.request(`/api/projects/${project.id}/review?mode=invalid`))
        .status
    ).toBe(400);
    expect(hub.reviews.review).not.toHaveBeenCalled();
  });
});

describe("to-do endpoints", () => {
  const withTodos = () => {
    const base = setup();
    const db = openDatabase(":memory:");
    new ProjectStore(db).upsertAll([
      {
        devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
        id: "demo",
        name: "demo",
        path: "/src/demo",
      },
    ]);
    return createDashboardApp({
      store: base.store,
      hub: base.hub,
      onboarding: base.onboarding,
      push: base.push,
      cleanup: base.cleanup,
      checks: base.checks,
      todos: new TodoStore(db, () => 1000),
    });
  };
  const send = (
    app: ReturnType<typeof createDashboardApp>,
    method: string,
    url: string,
    body: unknown
  ) =>
    app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("adds, lists, checks off and deletes items", async () => {
    const app = withTodos();
    const added = await send(app, "POST", "/api/projects/demo/todos", {
      text: "  Ship it  ",
    });
    await expect(added.json()).resolves.toStrictEqual({
      createdAt: 1000,
      done: false,
      id: 1,
      text: "Ship it",
    });
    const checked = await send(app, "PATCH", "/api/projects/demo/todos/1", {
      done: true,
    });
    expect(checked.status).toBe(200);
    const list = await app.request("/api/projects/demo/todos");
    await expect(list.json()).resolves.toStrictEqual({
      todos: [{ createdAt: 1000, done: true, id: 1, text: "Ship it" }],
    });
    expect(
      (await app.request("/api/projects/demo/todos/1", { method: "DELETE" }))
        .status
    ).toBe(200);
    expect(
      (await app.request("/api/projects/demo/todos/1", { method: "DELETE" }))
        .status
    ).toBe(404);
  });

  it("answers 400 for empty text, 404 for an unknown project and 412 without a store", async () => {
    const app = withTodos();
    expect(
      (await send(app, "POST", "/api/projects/demo/todos", { text: " " }))
        .status
    ).toBe(400);
    expect(
      (await send(app, "POST", "/api/projects/nope/todos", { text: "x" }))
        .status
    ).toBe(404);
    expect((await setup().app.request("/api/projects/demo/todos")).status).toBe(
      412
    );
  });
});
