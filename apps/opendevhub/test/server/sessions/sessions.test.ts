import { describe, expect, it, vi } from "vitest";

import { USER } from "../../../src/server/db/events";
import {
  AlreadyAnsweredError,
  NotFoundError,
  UnavailableError,
} from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import { OpencodeHttpError } from "../../../src/server/opencode/client";
import { FILE_SEARCH_LIMIT } from "../../../src/server/sessions/sessions";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_MAX,
} from "../../../src/shared/types";
import {
  project,
  running,
  setup,
  waiting,
  permission,
  form,
} from "../../helpers/hub";

describe("removeSession", () => {
  it("deletes a listed session through its environment's opencode, stopping it first when busy", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
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
    await s.hub.sessions.removeSession(project.id, "ses_1");
    expect(s.client.interrupt).not.toHaveBeenCalled();
    expect(s.client.deleteSession).toHaveBeenCalledWith(
      "ses_1",
      "/workspaces/demo"
    );
    expect(s.hub.environments.logLines(project.id)).toContain(
      "removed session Idle one"
    );
    expect(s.monitors[0].reconciled).toBeGreaterThan(reconciled);
    await s.hub.sessions.removeSession(project.id, "ses_2");
    expect(s.client.interrupt).toHaveBeenCalledWith(
      "ses_2",
      "/workspaces/demo"
    );
    await expect(
      s.hub.sessions.removeSession(project.id, "nope")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("killShell", () => {
  it("kills a session's background shell in the directory opencode listed it for", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.store.setSessions(project.id, [
      {
        id: "ses_1",
        projectId: project.id,
        title: "Idle one",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "idle",
        shells: [
          {
            command: "pnpm test",
            directory: "/workspaces/demo.worktrees/x",
            id: "sh_1",
            sessionId: "ses_child",
            startedAt: 1,
          },
        ],
      },
    ]);
    const { reconciled } = s.monitors[0];
    await s.hub.sessions.killShell(project.id, "ses_1", "sh_1");
    expect(s.client.killShell).toHaveBeenCalledWith(
      "sh_1",
      "/workspaces/demo.worktrees/x"
    );
    expect(s.hub.environments.logLines(project.id)).toContain(
      "killed background command pnpm test"
    );
    expect(s.monitors[0].reconciled).toBeGreaterThan(reconciled);
    await expect(
      s.hub.sessions.killShell(project.id, "ses_1", "sh_9")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("task conversations", () => {
  it("closes a running conversation without deleting it, then starts a fresh one", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.tasks.createTask({
      id: "task_1",
      projectId: project.id,
      title: "Implement login",
      prompt: "Login",
      createdAt: 1,
      variants: [{}],
    });
    s.tasks.attachSession(
      "task_1",
      1,
      { sessionId: "ses_1", envId: project.id, directory: "/workspaces/demo" },
      USER
    );
    s.store.setSessions(project.id, [
      {
        id: "ses_1",
        projectId: project.id,
        title: "Implement login",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "running",
      },
    ]);

    s.store.updateRuntime(project.id, { opencodeVersion: "2.1.0" });
    await s.hub.sessions.archiveTaskConversation(project.id, "ses_1");
    await vi.waitFor(() =>
      expect(s.client.setArchived).toHaveBeenCalledWith(
        "ses_1",
        true,
        "/workspaces/demo"
      )
    );
    expect(s.client.interrupt).toHaveBeenCalledWith(
      "ses_1",
      "/workspaces/demo"
    );
    expect(s.client.deleteSession).not.toHaveBeenCalled();
    expect(s.store.sessionsOf(project.id)).toStrictEqual([]);
    expect(s.tasks.bySession("ses_1")?.task.id).toBe("task_1");
    await expect(
      s.hub.sessions.startTaskConversation(project.id, "ses_1")
    ).resolves.toBe("ses_new");
    expect(s.tasks.get("task_1")?.variants[0].sessionId).toBe("ses_new");
  });

  it("briefs a new task conversation before any prompt reaches it", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.tasks.createTask({
      id: "task_1",
      projectId: project.id,
      title: "Implement login",
      prompt: "Add a login page",
      createdAt: 1,
      variants: [{}],
    });
    s.tasks.attachSession(
      "task_1",
      1,
      { sessionId: "ses_1", envId: project.id, directory: "/workspaces/demo" },
      USER
    );
    s.store.setSessions(project.id, [
      {
        id: "ses_1",
        projectId: project.id,
        title: "First attempt",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    const order: string[] = [];
    s.client.putInstruction.mockImplementation(async () => {
      order.push("brief");
    });
    s.client.prompt.mockImplementation(async () => {
      order.push("prompt");
    });

    await s.hub.sessions.startTaskConversation(project.id, "ses_1");
    expect(s.client.putInstruction).toHaveBeenCalledWith(
      "ses_new",
      "opendevhub-task",
      expect.any(String),
      "/workspaces/demo"
    );
    const briefing = s.client.putInstruction.mock.calls[0][2] as string;
    expect(briefing).toContain("**Implement login**");
    expect(briefing).toContain("Add a login page");
    expect(briefing).toContain("- Base: `main`");
    expect(briefing).toContain("- b2 second\n- a1 first");
    expect(briefing).toContain("1. First attempt");
    expect(s.client.prompt).not.toHaveBeenCalled();

    const { sessionId } = await s.hub.sessions.startInCheckout(
      project.id,
      "/workspaces/demo",
      "Next step",
      "carry on",
      "ses_1"
    );
    expect(sessionId).toBe("ses_new_2");
    expect(order).toStrictEqual(["brief", "brief", "prompt"]);
  });

  it("shows a task conversation's briefing first in its transcript", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.tasks.createTask({
      id: "task_1",
      projectId: project.id,
      title: "Implement login",
      prompt: "Login",
      createdAt: 1,
      variants: [{}],
    });
    s.tasks.attachSession(
      "task_1",
      1,
      { sessionId: "ses_1", envId: project.id, directory: "/workspaces/demo" },
      USER
    );
    s.store.setSessions(project.id, [
      {
        id: "ses_1",
        projectId: project.id,
        title: "Implement login",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    s.client.instructions.mockResolvedValue([
      { key: "opendevhub-task", value: "# Task briefing" },
    ]);
    const detail = await s.hub.sessions.sessionDetail(project.id, "ses_1");
    expect(detail.transcript).toStrictEqual([
      {
        created: 1,
        id: "opendevhub-task",
        role: "briefing",
        text: "# Task briefing",
      },
    ]);
    expect(s.client.instructions).toHaveBeenCalledWith(
      "ses_1",
      "/workspaces/demo"
    );
  });

  it("starts the conversation and sends its prompt when opencode has no instructions route", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.tasks.createTask({
      id: "task_1",
      projectId: project.id,
      title: "Implement login",
      prompt: "Login",
      createdAt: 1,
      variants: [{}],
    });
    s.tasks.attachSession(
      "task_1",
      1,
      { sessionId: "ses_1", envId: project.id, directory: "/workspaces/demo" },
      USER
    );
    s.client.putInstruction.mockRejectedValue(
      new OpencodeHttpError(
        404,
        "/api/experimental/session/ses_new/instructions"
      )
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      s.hub.sessions.startTaskConversation(project.id, "ses_1", {
        prompt: "go",
      })
    ).resolves.toBe("ses_new");
    expect(s.client.prompt).toHaveBeenCalledWith(
      "ses_new",
      "go",
      undefined,
      "/workspaces/demo",
      {}
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/task task_1, session ses_new: not attached.*404/u)
    );
    warn.mockRestore();
  });

  it("starts a review of a task's checkout as a conversation in that task, not a chat", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.tasks.createTask({
      id: "task_1",
      projectId: project.id,
      title: "Implement login",
      prompt: "Login",
      createdAt: 1,
      variants: [{}],
    });
    s.tasks.attachSession(
      "task_1",
      1,
      { sessionId: "ses_1", envId: project.id, directory: "/workspaces/demo" },
      USER
    );

    await expect(
      s.hub.sessions.startInCheckout(
        project.id,
        "/workspaces/demo",
        "Review changes",
        "Review it",
        "ses_1"
      )
    ).resolves.toStrictEqual({ sessionId: "ses_new" });
    expect(s.client.createSession).toHaveBeenLastCalledWith(
      "/workspaces/demo",
      expect.objectContaining({ title: "Review changes" })
    );
    expect(s.client.prompt).toHaveBeenLastCalledWith(
      "ses_new",
      "Review it",
      undefined,
      "/workspaces/demo",
      {}
    );
    expect(s.tasks.bySession("ses_new")?.task.id).toBe("task_1");
    expect(s.dbs.chats.listForProject(project.id)).toStrictEqual([]);
  });

  it("starts a review as a chat when the page's conversation isn't a task's", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    const started = await s.hub.sessions.startInCheckout(
      project.id,
      "/workspaces/demo",
      "Review changes",
      "Review it",
      "ses_unknown"
    );
    expect(started.chat).toBeDefined();
    expect(s.tasks.bySession(started.sessionId)).toBeUndefined();
  });
});

describe("responding", () => {
  async function running() {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.store.setSessions(project.id, [
      waiting({ permissions: [permission], forms: [form] }),
    ]);
    return s;
  }

  it("replies as the asking subagent session, in the root session's directory, then reconciles", async () => {
    const { hub, client, monitors } = await running();
    await hub.sessions.replyPermission(project.id, "per_1", {
      decision: "always",
    });
    expect(client.replyPermission).toHaveBeenCalledWith(
      "ses_child",
      "per_1",
      { decision: "always" },
      "/workspaces/demo.worktrees/x"
    );
    expect(monitors.at(-1)!.reconciled).toBe(1);
  });

  it("passes a reject reason through", async () => {
    const { hub, client } = await running();
    await hub.sessions.replyPermission(project.id, "per_1", {
      decision: "reject",
      message: "use pnpm",
    });
    expect(client.replyPermission.mock.calls[0][2]).toStrictEqual({
      decision: "reject",
      message: "use pnpm",
    });
  });

  it("answers and cancels forms", async () => {
    const { hub, client } = await running();
    await hub.sessions.replyForm(project.id, "frm_1", { db: "postgres" });
    expect(client.replyForm).toHaveBeenCalledWith(
      "ses_root",
      "frm_1",
      { db: "postgres" },
      "/workspaces/demo.worktrees/x"
    );
    await hub.sessions.cancelForm(project.id, "frm_1");
    expect(client.cancelForm).toHaveBeenCalledWith(
      "ses_root",
      "frm_1",
      "/workspaces/demo.worktrees/x"
    );
  });

  it("only forwards ids it listed itself", async () => {
    const { hub, client } = await running();
    await expect(
      hub.sessions.replyPermission(project.id, "per_other", {
        decision: "once",
      })
    ).rejects.toThrow(NotFoundError);
    await expect(
      hub.sessions.replyForm(project.id, "per_1", {})
    ).rejects.toThrow(NotFoundError);
    await expect(
      hub.sessions.replyPermission("nope", "per_1", { decision: "once" })
    ).rejects.toThrow(NotFoundError);
    expect(client.replyPermission).not.toHaveBeenCalled();
    expect(client.replyForm).not.toHaveBeenCalled();
  });

  it("validates the decision and the answer", async () => {
    const { hub } = await running();
    await expect(
      hub.sessions.replyPermission(project.id, "per_1", { decision: "yes" })
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      hub.sessions.replyForm(project.id, "frm_1", ["a"])
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      hub.sessions.replyForm(project.id, "frm_1", null)
    ).rejects.toThrow(InvalidRequestError);
  });

  it("turns opencode's not-found and already-settled into AlreadyAnsweredError, and still reconciles", async () => {
    const { hub, client, monitors } = await running();
    client.replyPermission.mockRejectedValueOnce(
      new OpencodeHttpError(404, "/x")
    );
    await expect(
      hub.sessions.replyPermission(project.id, "per_1", { decision: "once" })
    ).rejects.toThrow(AlreadyAnsweredError);
    client.replyForm.mockRejectedValueOnce(
      new OpencodeHttpError(409, "/x", "FormAlreadySettledError")
    );
    await expect(
      hub.sessions.replyForm(project.id, "frm_1", {})
    ).rejects.toThrow(AlreadyAnsweredError);
    expect(monitors.at(-1)!.reconciled).toBe(2);
  });

  it("surfaces opencode's message for an invalid answer, and keeps other failures as they are", async () => {
    const { hub, client } = await running();
    client.replyForm.mockRejectedValueOnce(
      new OpencodeHttpError(
        400,
        "/x",
        "FormInvalidAnswerError",
        "db is required"
      )
    );
    await expect(
      hub.sessions.replyForm(project.id, "frm_1", {})
    ).rejects.toThrow(
      expect.objectContaining({
        name: "InvalidRequestError",
        message: "db is required",
      })
    );
    client.replyForm.mockRejectedValueOnce(new OpencodeHttpError(500, "/x"));
    await expect(
      hub.sessions.replyForm(project.id, "frm_1", {})
    ).rejects.toBeInstanceOf(OpencodeHttpError);
  });

  it("needs opencode running", async () => {
    const { hub, store } = setup();
    await hub.environments.rescan();
    store.setSessions(project.id, [
      waiting({ permissions: [permission], forms: [] }),
    ]);
    await expect(
      hub.sessions.replyPermission(project.id, "per_1", { decision: "once" })
    ).rejects.toThrow(UnavailableError);
  });
});

describe("sessions started outside a task", () => {
  async function started() {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    return s;
  }
  const onlyTask = (s: Awaited<ReturnType<typeof started>>) => {
    const tasks = s.tasks.listForProject(project.id);
    expect(tasks).toHaveLength(1);
    return tasks[0];
  };
  const onlyChat = (s: Awaited<ReturnType<typeof started>>) => {
    const chats = s.dbs.chats.listForProject(project.id);
    expect(chats).toHaveLength(1);
    return chats[0];
  };

  it("records a session started in the main checkout as a chat, claiming the directory meanwhile", async () => {
    const s = await started();
    const claimed: boolean[] = [];
    s.client.createSession.mockImplementationOnce(async (directory) => {
      claimed.push(s.tasks.isClaimed(project.id, directory));
      return { id: "ses_m", location: { directory } };
    });
    const started2 = await s.hub.sessions.startSession(
      project.id,
      "/workspaces/demo",
      "Look around"
    );
    expect(started2.sessionId).toBe("ses_m");
    expect(claimed).toStrictEqual([true]);
    expect(s.tasks.isClaimed(project.id, "/workspaces/demo")).toBeFalsy();
    expect(onlyChat(s)).toMatchObject({
      createdAt: s.clock.now,
      directory: "/workspaces/demo",
      envId: project.id,
      id: started2.chat,
      origin: "hub",
      sessionId: "ses_m",
      step: "session",
      title: "Look around",
    });
    expect(onlyChat(s).branch).toBeUndefined();
    expect(s.tasks.listForProject(project.id)).toStrictEqual([]);
  });

  it("records the branch and worktree of a new worktree started with a conversation", async () => {
    const s = await started();
    const path = "/workspaces/demo.worktrees/feature-login";
    s.worktrees.list.mockResolvedValue([{ branch: "feature/login", path }]);
    const created = await s.hub.checkouts.createWorktree(project.id, {
      branch: "feature/login",
      startSession: true,
    });
    expect(onlyChat(s)).toMatchObject({
      branch: "feature/login",
      directory: path,
      origin: "hub",
      title: "feature/login",
    });
    expect(onlyChat(s).worktreeId).toBeDefined();
    expect(created).toMatchObject({ chat: onlyChat(s).id });
  });

  it("records a new session made to generate text as an internal chat, and none for a reused one", async () => {
    const s = await started();
    const { sessionId } = await s.hub.sessions.generateIn(
      project.id,
      "/workspaces/demo",
      "Write a commit message",
      { title: "Commit message" }
    );
    expect(s.dbs.chats.bySession(sessionId)).toMatchObject({
      origin: "internal",
      title: "Commit message",
    });
    expect(s.dbs.chats.listForProject(project.id)).toStrictEqual([]);
    expect(s.tasks.listForProject(project.id)).toStrictEqual([]);
  });

  it("gives an AI review session, in a checkout or quick, a review task of its pull request", async () => {
    const s = await started();
    const pull = s.links.ensurePull("https://forge.example/o/r/pulls/12");
    await s.hub.sessions.startSession(
      project.id,
      "/workspaces/demo",
      "AI review: PR #12",
      undefined,
      { reviewOf: pull.id }
    );
    expect(onlyTask(s)).toMatchObject({ kind: "review" });
    const [task] = s.tasks.listForProject(project.id);
    s.tasks.archive(task.id);
    await s.hub.sessions.generateIn(
      project.id,
      "/workspaces/demo",
      "Review the diff",
      { reviewOf: pull.id, title: "AI review: PR #12" }
    );
    expect(onlyTask(s)).toMatchObject({ kind: "review" });
    expect(s.links.forPull(pull.url).reviewTasks).toHaveLength(2);
  });

  it("leaves no chat or claim behind when opencode refuses the session", async () => {
    const s = await started();
    s.client.createSession.mockRejectedValueOnce(new Error("down"));
    await expect(
      s.hub.sessions.startSession(project.id, "/workspaces/demo")
    ).rejects.toThrow("down");
    expect(s.dbs.chats.listForProject(project.id)).toStrictEqual([]);
    expect(s.tasks.isClaimed(project.id, "/workspaces/demo")).toBeFalsy();
  });
});

describe("composer", () => {
  const ws = "/workspaces/demo";
  async function started(status: "idle" | "running" = "idle") {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.store.setSessions(project.id, [
      {
        id: "ses_1",
        projectId: project.id,
        title: "Chat",
        directory: ws,
        updatedAt: 1,
        status,
      },
    ]);
    s.client.commands.mockResolvedValue([
      { name: "opsx-propose", description: "Propose a change" },
      { name: "new", description: "opencode's own new" },
    ]);
    return s;
  }

  it("rejects a directory that isn't one of the project's checkouts, asking opencode nothing", async () => {
    const { hub, client } = await started();
    await expect(
      hub.sessions.findFiles(project.id, "/etc", "pass")
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      hub.sessions.composerCommands(project.id, "/elsewhere")
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      hub.sessions.composerAgents(project.id, "/elsewhere")
    ).rejects.toThrow(InvalidRequestError);
    expect(client.findFiles).not.toHaveBeenCalled();
    expect(client.commands).not.toHaveBeenCalled();
    expect(client.agents).not.toHaveBeenCalled();
  });

  it("caps file search and finds nothing where opencode has no file search", async () => {
    const { hub, client } = await started();
    client.findFiles.mockResolvedValueOnce(["src/a.ts"]);
    await expect(
      hub.sessions.findFiles(project.id, ws, "a")
    ).resolves.toStrictEqual(["src/a.ts"]);
    expect(client.findFiles).toHaveBeenCalledWith(ws, "a", FILE_SEARCH_LIMIT);
    expect(FILE_SEARCH_LIMIT).toBe(50);
    client.findFiles.mockRejectedValueOnce(
      new OpencodeHttpError(404, "/api/fs/find")
    );
    await expect(
      hub.sessions.findFiles(project.id, ws, "a")
    ).resolves.toStrictEqual([]);
  });

  it("lists hub commands first, marks the opencode command one hides, and caches per checkout", async () => {
    const { hub, client } = await started();
    const commands = await hub.sessions.composerCommands(project.id, ws);
    expect(commands.map((c) => [c.name, c.hub, c.shadowed])).toStrictEqual([
      ["new", true, undefined],
      ["interrupt", true, undefined],
      ["opsx-propose", undefined, undefined],
      ["new", undefined, true],
    ]);
    await hub.sessions.composerCommands(project.id, ws);
    expect(client.commands).toHaveBeenCalledOnce();
  });

  it("offers visible subagents for mentions", async () => {
    const { hub, client } = await started();
    client.agents.mockResolvedValue([
      { id: "build", name: "Build", mode: "primary" },
      { id: "explore", name: "Explore", mode: "subagent", description: "Find" },
      { id: "both", name: "Both", mode: "all" },
      { id: "hidden", name: "Hidden", mode: "subagent", hidden: true },
    ]);
    await expect(
      hub.sessions.composerAgents(project.id, ws)
    ).resolves.toStrictEqual([
      { id: "explore", name: "Explore", description: "Find" },
      { id: "both", name: "Both" },
    ]);
  });

  it("runs a known opencode command with its arguments and their mentions, queued while running", async () => {
    const { hub, client } = await started("running");
    const text = "/opsx-propose dark mode for @src/a.ts";
    await expect(
      hub.sessions.sendMessage(project.id, "ses_1", {
        text,
        mentions: [{ kind: "file", start: 28, end: 37, name: "src/a.ts" }],
      })
    ).resolves.toStrictEqual({
      kind: "command",
      name: "opsx-propose",
      queued: true,
    });
    expect(client.command).toHaveBeenCalledWith(
      "ses_1",
      "opsx-propose",
      "dark mode for @src/a.ts",
      ws,
      {
        delivery: "queue",
        files: [
          {
            uri: "file:///workspaces/demo/src/a.ts",
            name: "src/a.ts",
            mention: { start: 14, end: 23, text: "@src/a.ts" },
          },
        ],
      }
    );
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("sends anything else as a prompt, unknown slash names included", async () => {
    const { hub, client } = await started();
    for (const text of ["/etc/hosts is wrong", "/nope do it", "fix it /new"]) {
      await expect(
        hub.sessions.sendMessage(project.id, "ses_1", { text })
      ).resolves.toStrictEqual({ kind: "prompt", queued: false });
      expect(client.prompt).toHaveBeenLastCalledWith(
        "ses_1",
        text,
        undefined,
        ws,
        {}
      );
    }
    expect(client.command).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("interrupts a working conversation without sending the agent anything", async () => {
    const { hub, client } = await started("running");
    await expect(
      hub.sessions.sendMessage(project.id, "ses_1", { text: "/interrupt" })
    ).resolves.toStrictEqual({ kind: "interrupt" });
    expect(client.interrupt).toHaveBeenCalledWith("ses_1", ws);
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.command).not.toHaveBeenCalled();
    const idle = await started("idle");
    await expect(
      idle.hub.sessions.sendMessage(project.id, "ses_1", { text: "/interrupt" })
    ).rejects.toThrow(InvalidRequestError);
    expect(idle.client.interrupt).not.toHaveBeenCalled();
  });

  it("starts a fresh task conversation without copying context or making a separate chat", async () => {
    const { hub, client, tasks } = await started();
    tasks.createTask({
      id: "task_1",
      projectId: project.id,
      title: "Implement login",
      prompt: "Login",
      createdAt: 1,
      variants: [{}],
    });
    tasks.attachSession(
      "task_1",
      1,
      { sessionId: "ses_1", envId: project.id, directory: ws },
      USER
    );
    await expect(
      hub.sessions.sendMessage(project.id, "ses_1", { text: "/new" })
    ).resolves.toStrictEqual({ kind: "new", sessionId: "ses_new" });
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.command).not.toHaveBeenCalled();
    expect(tasks.bySession("ses_1")?.task.id).toBe("task_1");
    expect(tasks.bySession("ses_new")?.task.id).toBe("task_1");
    expect(tasks.get("task_1")?.variants[0].sessionId).toBe("ses_new");
  });

  it("briefs a task conversation /new starts, then prompts it with the rest", async () => {
    const { hub, client, tasks } = await started();
    tasks.createTask({
      id: "task_1",
      projectId: project.id,
      title: "Implement login",
      prompt: "Login",
      createdAt: 1,
      variants: [{}],
    });
    tasks.attachSession(
      "task_1",
      1,
      { sessionId: "ses_1", envId: project.id, directory: ws },
      USER
    );
    const order: string[] = [];
    client.putInstruction.mockImplementation(async (_sid, key) => {
      order.push(key);
    });
    client.prompt.mockImplementation(async (_sid, text) => {
      order.push(text);
    });
    await hub.sessions.sendMessage(project.id, "ses_1", {
      text: "/new fix the failing test",
    });
    expect(order).toStrictEqual(["opendevhub-task", "fix the failing test"]);
  });

  it("starts a new conversation in the same checkout with /new, prompting it with the rest", async () => {
    const { hub, client } = await started();
    await expect(
      hub.sessions.sendMessage(project.id, "ses_1", { text: "/new look at it" })
    ).resolves.toMatchObject({ kind: "new", sessionId: "ses_new" });
    expect(client.createSession).toHaveBeenCalledWith(ws, { title: undefined });
    expect(client.prompt).toHaveBeenCalledWith(
      "ses_new",
      "look at it",
      undefined,
      ws,
      {}
    );
    expect(client.command).not.toHaveBeenCalled();
  });

  it("switches the conversation's model before sending, unless it already uses it", async () => {
    const { hub, client, store } = await started();
    const model = { id: "gpt-5", providerID: "openai", variant: "high" };
    await hub.sessions.sendMessage(project.id, "ses_1", { text: "hi", model });
    expect(client.switchModel).toHaveBeenCalledWith("ses_1", model, ws);
    expect(client.switchModel.mock.invocationCallOrder[0]).toBeLessThan(
      client.prompt.mock.invocationCallOrder[0]
    );
    store.setSessions(project.id, [
      {
        id: "ses_1",
        projectId: project.id,
        title: "Chat",
        directory: ws,
        updatedAt: 2,
        status: "idle",
        model,
      },
    ]);
    await hub.sessions.sendMessage(project.id, "ses_1", {
      text: "again",
      model,
    });
    expect(client.switchModel).toHaveBeenCalledTimes(1);
  });

  it("switches the conversation's agent before sending when one is chosen", async () => {
    const { hub, client } = await started();
    await hub.sessions.sendMessage(project.id, "ses_1", {
      text: "hi",
      agent: "plan",
    });
    expect(client.switchAgent).toHaveBeenCalledWith("ses_1", "plan", ws);
    expect(client.switchAgent.mock.invocationCallOrder[0]).toBeLessThan(
      client.prompt.mock.invocationCallOrder[0]
    );
    await hub.sessions.sendMessage(project.id, "ses_1", { text: "again" });
    expect(client.switchAgent).toHaveBeenCalledTimes(1);
  });

  it("starts /new on the chosen agent", async () => {
    const { hub, client } = await started();
    await hub.sessions.sendMessage(project.id, "ses_1", {
      text: "/new go",
      agent: "plan",
    });
    expect(client.createSession).toHaveBeenCalledWith(ws, {
      title: undefined,
      agent: "plan",
    });
    expect(client.switchAgent).not.toHaveBeenCalled();
  });

  it("starts /new on the chosen model", async () => {
    const { hub, client } = await started();
    const model = { id: "gpt-5", providerID: "openai" };
    await hub.sessions.sendMessage(project.id, "ses_1", {
      text: "/new go",
      model,
    });
    expect(client.createSession).toHaveBeenCalledWith(ws, {
      title: undefined,
      model,
    });
    expect(client.switchModel).not.toHaveBeenCalled();
  });

  it("sends attached files as data: URL attachments after the mentions", async () => {
    const { hub, client } = await started();
    const url = `data:image/png;base64,${Buffer.from("png bytes").toString("base64")}`;
    await hub.sessions.sendMessage(project.id, "ses_1", {
      text: "what is @a.ts",
      mentions: [{ kind: "file", start: 8, end: 13, name: "a.ts" }],
      attachments: [{ name: "shot.png", url }],
    });
    expect(client.prompt).toHaveBeenCalledWith(
      "ses_1",
      "what is @a.ts",
      undefined,
      ws,
      {
        files: [
          {
            uri: "file:///workspaces/demo/a.ts",
            name: "a.ts",
            mention: { start: 8, end: 13, text: "@a.ts" },
          },
          { name: "shot.png", uri: url },
        ],
      }
    );
  });

  it("refuses an attachment that isn't base64, is too big, or one too many", async () => {
    const { hub, client } = await started();
    const send = (attachments: { name: string; url: string }[]) =>
      hub.sessions.sendMessage(project.id, "ses_1", {
        text: "hi",
        attachments,
      });
    await expect(
      send([{ name: "a.txt", url: "data:text/plain,hello" }])
    ).rejects.toThrow(InvalidRequestError);
    const big = "A".repeat(Math.ceil((ATTACHMENT_MAX_BYTES + 3) / 3) * 4);
    await expect(
      send([{ name: "big.bin", url: `data:;base64,${big}` }])
    ).rejects.toThrow(/larger than 20 MB/u);
    const small = { name: "a.txt", url: "data:text/plain;base64,aGk=" };
    await expect(
      send(Array.from({ length: ATTACHMENTS_MAX + 1 }, () => small))
    ).rejects.toThrow(InvalidRequestError);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("refuses an empty message, a mention that doesn't match the text, and one outside the checkout", async () => {
    const { hub, client } = await started();
    const send = (text: string, name: string, start: number) =>
      hub.sessions.sendMessage(project.id, "ses_1", {
        text,
        mentions: [{ kind: "file", start, end: start + name.length + 1, name }],
      });
    await expect(
      hub.sessions.sendMessage(project.id, "ses_1", { text: "  " })
    ).rejects.toThrow(InvalidRequestError);
    await expect(send("see @a.ts", "a.ts", 0)).rejects.toThrow(
      InvalidRequestError
    );
    await expect(send("@../secret", "../secret", 0)).rejects.toThrow(
      InvalidRequestError
    );
    expect(client.prompt).not.toHaveBeenCalled();
  });
});
