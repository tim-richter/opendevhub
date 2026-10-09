import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { InvalidNodeError, InvalidRootError } from "../../src/server/config";
import { createDashboardApp } from "../../src/server/dashboard-api";
import type { DashboardHub, PushPort } from "../../src/server/dashboard-api";
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
import type {
  Candidate,
  CheckRun,
  ChecksConfig,
  ChecksView,
  CleanupItem,
  CleanupPlan,
  CleanupResult,
  ModelsInfo,
  PickResult,
  Project,
  SessionDetail,
  TaskResult,
} from "../../src/shared/types";
import { MemorySecretStore } from "../helpers/secrets";

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
    port: 7777,
    persisted: { projects: {} },
    persist: () => {},
  });
  store.setProjects([project]);
  store.updateRuntime(project.id, { password: "secret" });
  const hub = {
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
        async (_id: string, _dir: string, _title?: string, _prompt?: string) =>
          "ses_1"
      ),
      generateIn: vi.fn(
        async (
          _id: string,
          _dir: string,
          _prompt: string,
          options: { sessionId?: string; title: string; timeoutMs?: number }
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
      removeSession: vi.fn(async (_id: string, _sid: string) => {}),
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
    subscribe: vi.fn((raw: unknown) => {
      if (!(raw as { endpoint?: unknown }).endpoint) {
        throw new InvalidSubscriptionError("subscription needs an endpoint");
      }
    }),
    unsubscribe: vi.fn((_endpoint: string) => {}),
    send: vi.fn(async (_m: PushMessage) => 2),
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
              state: "open",
              url: "https://forge.example/team/repo/pulls/7",
              number: 7,
            },
            commitId: sha,
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
    expect(hub.checkouts.createWorktree).toHaveBeenCalledWith("p", {
      branch: "review/pr-7",
      pull: {
        url: "https://forge.example/team/repo/pulls/7",
        number: 7,
        commitId: sha,
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
    const [, , title, prompt] = hub.sessions.startSession.mock.calls[0];
    expect(title).toBe("AI review: PR #7 Fix it");
    expect(prompt).toContain(`First check that HEAD is ${sha}`);

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
    const [, , quickPrompt, options] = hub.sessions.generateIn.mock.calls[1];
    expect(quickPrompt).toContain("diff --git a/a.ts b/a.ts");
    expect(options.sessionId).toBeUndefined();
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

    await expect((await post("/api/push/test")).json()).resolves.toStrictEqual({
      sent: 2,
    });
    expect(push.send).toHaveBeenCalledWith({
      tag: "test",
      title: "opendevhub",
      body: "Notifications work.",
      url: "/",
    });
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
