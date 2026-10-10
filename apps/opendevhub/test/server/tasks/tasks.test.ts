import { describe, expect, it, vi } from "vitest";

import { CommandError } from "../../../src/server/environments/containers";
import {
  BusyError,
  NotFoundError,
  UnavailableError,
} from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import type { RawModel } from "../../../src/server/opencode/client";
import {
  OpencodeClient,
  OpencodeHttpError,
} from "../../../src/server/opencode/client";
import { StateStore } from "../../../src/server/projects/state";
import { parseTaskMeta } from "../../../src/server/tasks/request";
import type {
  EnvWorktree,
  Project,
  SessionSummary,
} from "../../../src/shared/types";
import { startFakeOpencode } from "../../helpers/fake-opencode";
import { project, running, boxKit, setup } from "../../helpers/hub";

describe("tasks", () => {
  async function started() {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    let n = 0;
    s.client.createSession.mockImplementation(async (directory: string) => ({
      id: `ses_${++n}`,
      location: { directory },
    }));
    return s;
  }

  it("associates each created worktree and session with its Jira ticket", async () => {
    const { hub, client, store, worktrees } = await started();
    const jira = {
      key: "APP-12",
      instanceUrl: "https://jira.example.com",
      title: "Fix login",
      description: "Safari login must succeed.",
    };
    const prompt = `Implement APP-12: Fix login\n\n${jira.description}`;
    const result = await hub.tasks.createTask(project.id, {
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
      expect(result.variants.some((v) => v.directory === directory)).toBe(true);
    }
    expect(store.startingTask(project.id, result.task)?.jira).toStrictEqual(
      jira
    );
    expect(worktrees.add.mock.calls.map(([, a]) => a.origin)).toStrictEqual([
      "https://jira.example.com/browse/APP-12",
      "https://jira.example.com/browse/APP-12",
    ]);
    expect(
      client.prompt.mock.calls.every(([, text]) => text === prompt)
    ).toBeTruthy();
  });

  it("starts one variant in a new worktree named after the prompt, tagged with the task", async () => {
    const { hub, client, worktrees, git, monitors } = await started();
    git.localBranches.mockResolvedValueOnce(["main", "fix-the-login-bug"]);
    const res = await hub.tasks.createTask(project.id, {
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
    const { hub, store } = await started();
    store.updateRuntime(project.id, {
      worktrees: [{ path: "/workspaces/demo.worktrees/ship", branch: "ship" }],
    });
    const res = await hub.tasks.createTask(project.id, { prompt: "Ship" });
    expect(res.variants[0].branch).toBe("ship-2");
  });

  it("runs in the main checkout without a worktree", async () => {
    const { hub, client, worktrees } = await started();
    const res = await hub.tasks.createTask(project.id, {
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
    const { hub, client, worktrees } = await started();
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
    const res = await hub.tasks.createTask(project.id, {
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
    ).toStrictEqual(["Add caching · a", "Add caching · b", "Add caching · c"]);
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
    expect(hub.environments.logLines(project.id).join("\n")).toMatch(
      /variant 2 \(cache-b\) failed/u
    );
  });

  it("records a failed worktree on its variant and still refreshes the list", async () => {
    const { hub, worktrees, store } = await started();
    worktrees.add.mockRejectedValueOnce(
      new CommandError("git worktree failed: invalid reference: nope", [
        "fatal: invalid reference: nope",
      ])
    );
    worktrees.list.mockResolvedValueOnce([
      { path: "/workspaces/demo.worktrees/x-2", branch: "x-2" },
    ]);
    const res = await hub.tasks.createTask(project.id, {
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
    expect(hub.environments.logLines(project.id)).toContain(
      "fatal: invalid reference: nope"
    );
  });

  it("falls back to the known worktrees plus the new ones when the list fails", async () => {
    const { hub, worktrees, store } = await started();
    store.updateRuntime(project.id, {
      worktrees: [{ path: "/workspaces/demo.worktrees/old", branch: "old" }],
    });
    worktrees.list.mockRejectedValueOnce(new Error("git down"));
    const res = await hub.tasks.createTask(project.id, {
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
    const { hub, worktrees } = await started();
    // 95 + "-model-a" = 103 characters, over validateBranch's 100.
    const long = "b".repeat(95);
    await expect(
      hub.tasks.createTask(project.id, {
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
      await s.hub.environments.rescan();
      await s.hub.environments.start(project.id);
      const jira = {
        key: "APP-12",
        instanceUrl: "https://jira.example.com",
        title: "Login",
        description: "Fix login in Safari.",
      };
      const res = await s.hub.tasks.createTask(project.id, {
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
    const { hub, store, worktrees } = await started();
    await expect(
      hub.tasks.createTask(project.id, { prompt: " " })
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      hub.tasks.createTask(project.id, {
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
            (release = () => r({ path: `${a.root.container}/y`, branch: "y" }))
        )
    );
    const first = hub.tasks.createTask(project.id, { prompt: "y" });
    await vi.waitFor(() => expect(release).toBeDefined());
    // A second task waits for the lock instead of failing; other git work still says busy.
    const second = hub.tasks.createTask(project.id, { prompt: "z" });
    expect(() =>
      hub.checkouts.createWorktree(project.id, { branch: "z" })
    ).toThrow(BusyError);
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
      hub.tasks.createTask(project.id, { prompt: "x" })
    ).rejects.toThrow(UnavailableError);
    store.updateRuntime(project.id, { opencode: "unhealthy" });
    await expect(
      hub.tasks.createTask(project.id, { prompt: "x", where: "workspace" })
    ).rejects.toThrow(UnavailableError);
  });

  it("starts a spec-first task by running opsx-propose with the prompt in each variant's session", async () => {
    const { hub, client } = await started();
    client.commands.mockResolvedValue([{ name: "opsx-propose" }]);
    const result = await hub.tasks.createTask(project.id, {
      prompt: "Add dark mode",
      spec: true,
      variants: [{}, {}],
    });
    expect(result.variants.every((v) => v.sessionId)).toBe(true);
    expect(client.commands.mock.calls.map(([dir]) => dir)).toStrictEqual(
      result.variants.map((v) => v.directory)
    );
    expect(client.command.mock.calls).toStrictEqual(
      result.variants.map((v) => [
        v.sessionId,
        "opsx-propose",
        "Add dark mode",
        v.directory,
      ])
    );
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.createSession.mock.calls[0][1]?.metadata).toMatchObject({
      opendevhub: { spec: { phase: "propose" } },
    });
  });

  it("starts a task implementing an approved change by running opsx-apply in each variant's worktree", async () => {
    const { hub, client, worktrees } = await started();
    client.commands.mockResolvedValue([{ name: "opsx-apply" }]);
    const spec = {
      change: "add-dark-mode",
      phase: "implement",
      proposedIn: "tsk_1",
    } as const;
    await hub.tasks.startTask(
      project.id,
      {
        base: "dark-mode",
        prompt: "add-dark-mode",
        variants: [{}, {}],
        where: "worktree",
      },
      spec
    );
    await vi.waitFor(() => expect(client.command).toHaveBeenCalledTimes(2));
    expect(worktrees.add.mock.calls.map(([, a]) => a.base)).toStrictEqual([
      "dark-mode",
      "dark-mode",
    ]);
    expect(client.command.mock.calls.map((c) => c.slice(1, 3))).toStrictEqual([
      ["opsx-apply", "add-dark-mode"],
      ["opsx-apply", "add-dark-mode"],
    ]);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.createSession.mock.calls[0][1]?.metadata).toMatchObject({
      opendevhub: { spec },
    });
  });

  it("fails a spec-first variant whose opencode has no opsx-propose, before creating its session", async () => {
    const { hub, client } = await started();
    const result = await hub.tasks.createTask(project.id, {
      prompt: "Add dark mode",
      spec: true,
    });
    expect(result.variants[0].error).toMatch(/opsx-propose/u);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("starts a session with a first prompt when creating a worktree", async () => {
    const { hub, client, worktrees } = await started();
    worktrees.list.mockResolvedValue([
      { path: "/workspaces/demo.worktrees/feature-y", branch: "feature/y" },
    ]);
    const res = await hub.checkouts.createWorktree(project.id, {
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
    const { hub, client, clock } = await started();
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
    const info = await hub.sessions.models(project.id);
    expect(info).toStrictEqual({
      models: [{ id: "m1", providerID: "p", name: "M1", variants: ["high"] }],
      default: { id: "m1", providerID: "p" },
      agents: [{ id: "build", name: "Build" }],
    });
    expect(JSON.stringify(info)).not.toContain("secret");
    expect(client.models).toHaveBeenCalledWith("/workspaces/demo");
    await hub.sessions.models(project.id);
    expect(client.models).toHaveBeenCalledOnce();
    clock.now += 60_001;
    await hub.sessions.models(project.id);
    expect(client.models).toHaveBeenCalledTimes(2);
  });

  it("offers OpenSpec's workflow when opencode has opsx commands, with whether the container has the CLI", async () => {
    const { hub, client, containers } = await started();
    client.commands.mockResolvedValue(
      ["opsx-propose", "opsx-apply", "opsx-explore"].map((name) => ({ name }))
    );
    containers.exec.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "",
      stdout: "",
      timedOut: false,
    });
    const info = await hub.sessions.models(project.id);
    expect(info.spec).toStrictEqual({
      missing: ["opsx-update", "opsx-archive"],
      cli: false,
    });
    expect(client.commands).toHaveBeenCalledWith("/workspaces/demo");
    expect(containers.exec.mock.calls[0][1].slice(0, 2)).toStrictEqual([
      "sh",
      "-c",
    ]);
  });

  it("leaves OpenSpec out when opencode has no opsx command or can't list commands", async () => {
    const { hub, client, containers } = await started();
    client.commands.mockRejectedValueOnce(new Error("404"));
    expect(await hub.sessions.models(project.id)).not.toHaveProperty("spec");
    expect(containers.exec).not.toHaveBeenCalled();
  });

  it("retries once when a fresh opencode answers empty", async () => {
    const { hub, client, delay } = await started();
    client.models.mockResolvedValueOnce([]);
    client.agents.mockResolvedValueOnce([]);
    const info = await hub.sessions.models(project.id);
    expect(info.models).toStrictEqual([
      { id: "m1", providerID: "p", name: "M1", variants: [] },
    ]);
    expect(info.agents).toStrictEqual([{ id: "build", name: "Build" }]);
    expect(client.models).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1500);
  });

  it("never caches a list that is still empty after the retry", async () => {
    const { hub, client } = await started();
    client.models.mockResolvedValue([]);
    client.agents.mockResolvedValue([]);
    client.defaultModel.mockResolvedValue(undefined);
    await expect(hub.sessions.models(project.id)).resolves.toStrictEqual({
      models: [],
      agents: [],
    });
    expect(client.models).toHaveBeenCalledTimes(2);
    await hub.sessions.models(project.id);
    expect(client.models).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failed model lookup, and forgets the cache when opencode restarts", async () => {
    const { hub, client } = await started();
    client.models.mockRejectedValueOnce(new Error("boom"));
    await expect(hub.sessions.models(project.id)).rejects.toThrow("boom");
    await hub.sessions.models(project.id);
    await hub.environments.restartOpencode(project.id);
    await hub.sessions.models(project.id);
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
    const { hub, client, worktrees, git, store } = await started();
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

    const res = await hub.tasks.pickVariant(project.id, "tsk_1", "s2", true);

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
    const { hub, client, worktrees, store } = await started();
    store.setSessions(project.id, [
      variant("s1", 1, "/workspaces/demo"),
      variant("s2", 2, "/workspaces/demo"),
    ]);
    client.updateSession.mockRejectedValueOnce(new Error("opencode down"));
    await expect(
      hub.tasks.pickVariant(project.id, "tsk_1", "s2", false)
    ).resolves.toStrictEqual({
      discarded: [],
      removed: [],
      errors: ["Fix · #1: opencode down"],
    });
    expect(worktrees.remove).not.toHaveBeenCalled();
    await expect(
      hub.tasks.pickVariant(project.id, "tsk_1", "nope", false)
    ).rejects.toThrow(NotFoundError);
  });

  it("removes nothing for variants in the main checkout, in unknown folders, or whose discard failed", async () => {
    const { hub, client, worktrees, git, store } = await started();
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
    const res = await hub.tasks.pickVariant(project.id, "tsk_1", "s4", true);
    expect(res).toStrictEqual({
      discarded: ["s1", "s2"],
      removed: [],
      errors: ["Fix · #3: boom"],
    });
    expect(worktrees.remove).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("keeps going when one worktree can't be removed", async () => {
    const { hub, worktrees, store } = await started();
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
    const res = await hub.tasks.pickVariant(project.id, "tsk_1", "s3", true);
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
      const { hub, client, worktrees, store } = await started();
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
      await hub.tasks.pickVariant(project.id, "tsk_1", "s2", true);
      expect(client.interrupt).toHaveBeenCalledOnce();
      expect(client.interrupt).toHaveBeenCalledWith("s1", dirs[0]);
      expect(order).toStrictEqual(["interrupt s1", "remove", "remove"]);
    });

    it("reports a failed interrupt without undoing the discard or stopping the removal", async () => {
      const { hub, client, worktrees, store } = await started();
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
      const res = await hub.tasks.pickVariant(project.id, "tsk_1", "s2", true);
      expect(res.discarded).toStrictEqual(["s1", "s3"]);
      expect(res.errors).toStrictEqual(["Fix · #1: nope"]);
      expect(res.removed).toStrictEqual([dirs[0], dirs[2]]);
      expect(worktrees.remove).toHaveBeenCalledTimes(2);
    });

    it("deletes a branch only when it is the one the task created; otherwise keeps it and says so", async () => {
      const { hub, client, worktrees, git, store } = await started();
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
      const res = await hub.tasks.pickVariant(project.id, "tsk_1", "s2", true);
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
      const { hub, client, git, store } = await started();
      store.updateRuntime(project.id, {
        worktrees: dirs.map((path, i) => ({ path, branch: `fix-${i + 1}` })),
      });
      store.setSessions(project.id, [
        variant("s1", 1, dirs[0]),
        variant("s2", 2, dirs[1], "fix-2"),
      ]);
      client.session.mockResolvedValue(rawOf());
      const res = await hub.tasks.pickVariant(project.id, "tsk_1", "s2", true);
      expect(res.removed).toStrictEqual([dirs[0]]);
      expect(git.deleteBranch).not.toHaveBeenCalled();
      expect(res.errors).toStrictEqual([
        "fix-1: kept — not created by this task",
      ]);
    });

    it("refuses to pick a variant that a concurrent pick already discarded", async () => {
      const { hub, client, store } = await started();
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
        hub.tasks.pickVariant(project.id, "tsk_1", "s2", true)
      ).rejects.toThrow(InvalidRequestError);
      expect(client.updateSession).not.toHaveBeenCalled();
    });

    it("counts a removed worktree as removed when only its branch delete fails", async () => {
      const { hub, client, git, store } = await started();
      store.updateRuntime(project.id, {
        worktrees: dirs.map((path, i) => ({ path, branch: `fix-${i + 1}` })),
      });
      store.setSessions(project.id, [
        variant("s1", 1, dirs[0], "fix-1"),
        variant("s2", 2, dirs[1], "fix-2"),
      ]);
      client.session.mockResolvedValue(rawOf());
      git.deleteBranch.mockRejectedValueOnce(new Error("not fully merged"));
      const res = await hub.tasks.pickVariant(project.id, "tsk_1", "s2", true);
      expect(res.removed).toStrictEqual([dirs[0]]);
      expect(res.errors).toStrictEqual([
        "fix-1: worktree removed, branch kept: not fully merged",
      ]);
    });
  });
});

describe("starting tasks in the background", () => {
  async function started() {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
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
    const result = await s.hub.tasks.startTask(project.id, {
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
    await expect(
      s.hub.tasks.startTask(project.id, { prompt: " " })
    ).rejects.toThrow(InvalidRequestError);
    s.store.updateRuntime(project.id, { opencode: "unhealthy" });
    await expect(
      s.hub.tasks.startTask(project.id, { prompt: "x" })
    ).rejects.toThrow(UnavailableError);
    expect(s.store.snapshot().projects[0].starting).toBeUndefined();
  });

  it("records a variant's failure and its log, and starts the others", async () => {
    const s = await started();
    s.worktrees.add.mockImplementationOnce(async (_p, a) => {
      a.onLine("worktree: preparing");
      throw new CommandError("git worktree add failed: boom", ["fatal: boom"]);
    });
    const { task } = await s.hub.tasks.startTask(project.id, {
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
    const { task } = await s.hub.tasks.startTask(project.id, {
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
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    box.kit.repo.pushBase.mockRejectedValueOnce(
      new CommandError("pushing main to box failed: denied")
    );
    const { task } = await s.hub.tasks.startTask(project.id, {
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
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.git.currentBranch.mockResolvedValue(undefined);
    await expect(
      s.hub.tasks.startTask(project.id, {
        prompt: "x",
        environment: "isolated",
        node: "box",
      })
    ).rejects.toThrow(/detached HEAD/u);
  });

  it("dismisses a failed variant", async () => {
    const s = await started();
    s.worktrees.add.mockRejectedValueOnce(new Error("boom"));
    const { task } = await s.hub.tasks.startTask(project.id, {
      prompt: "x",
      environment: "shared",
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].step).toBe("failed")
    );
    s.hub.tasks.dismissStarting(project.id, task);
    expect(startingOf(s, task)).toBeUndefined();
    expect(() => s.hub.tasks.dismissStarting(project.id, task)).toThrow(
      NotFoundError
    );
  });
});
