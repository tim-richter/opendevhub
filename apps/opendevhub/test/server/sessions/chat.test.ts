import { describe, expect, it, vi } from "vitest";

import { CommandError } from "../../../src/server/environments/containers";
import { NotFoundError } from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import { FIRST_TURN_TIMEOUT_MS } from "../../../src/server/tasks/checkout-setup";
import { project, setup } from "../../helpers/hub";

describe("chat", () => {
  const ws = "/workspaces/demo";
  async function started() {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.client.commands.mockResolvedValue([{ name: "opsx-propose" }]);
    return s;
  }

  /** A chat in a new worktree whose session exists, its first prompt sent. */
  async function worktreeChat(s: Awaited<ReturnType<typeof started>>) {
    const { chat } = await s.hub.chat.start(project.id, {
      target: { kind: "worktree" },
      message: { text: "add a dark mode toggle" },
    });
    await vi.waitFor(() => expect(s.dbs.chats.get(chat)?.step).toBe("session"));
    s.client.prompt.mockClear();
    s.client.command.mockClear();
    return chat;
  }

  it("starts a chat in a new worktree, with a branch named from the message, and creates no task", async () => {
    const s = await started();
    const { chat, sessionId } = await s.hub.chat.start(project.id, {
      target: { kind: "worktree" },
      message: { text: "add a dark mode toggle" },
    });
    expect(sessionId).toBeUndefined();
    expect(s.dbs.chats.get(chat)).toMatchObject({
      origin: "hub",
      title: "add a dark mode toggle",
    });
    await vi.waitFor(() => expect(s.client.prompt).toHaveBeenCalledOnce());
    const [session, text, , directory] = s.client.prompt.mock.calls[0];
    expect(text).toBe("add a dark mode toggle");
    expect(directory).not.toBe(ws);
    expect(s.dbs.chats.get(chat)).toMatchObject({
      branch: "add-a-dark-mode-toggle",
      directory,
      sessionId: session,
      step: "session",
    });
    expect(s.dbs.chats.get(chat)?.worktreeId).toBeDefined();
    expect(s.tasks.listForProject(project.id)).toStrictEqual([]);
    const snapshot = s.store.snapshot().projects[0];
    expect(snapshot.chats.map((c) => c.id)).toStrictEqual([chat]);
    expect(snapshot.tasks).toStrictEqual([]);
  });

  it("records a failed worktree on the chat", async () => {
    const s = await started();
    s.worktrees.add.mockRejectedValueOnce(
      new CommandError("git worktree failed: invalid reference: nope", [])
    );
    const { chat } = await s.hub.chat.start(project.id, {
      target: { kind: "worktree" },
      message: { text: "add a dark mode toggle" },
    });
    await vi.waitFor(() => expect(s.dbs.chats.get(chat)?.step).toBe("failed"));
    expect(s.dbs.chats.get(chat)?.error).toBe(
      "git worktree failed: invalid reference: nope"
    );
    expect(s.client.createSession).not.toHaveBeenCalled();
  });

  it("starts a chat in a checkout, runs the message's command there, and creates no task", async () => {
    const s = await started();
    const { chat, sessionId } = await s.hub.chat.start(project.id, {
      target: { kind: "checkout", directory: ws },
      message: { text: "/opsx-propose add dark mode" },
    });
    expect(sessionId).toBe("ses_new");
    expect(s.dbs.chats.get(chat)).toMatchObject({
      directory: ws,
      origin: "hub",
      sessionId: "ses_new",
    });
    expect(s.tasks.listForProject(project.id)).toStrictEqual([]);
    expect(s.client.command).toHaveBeenCalledWith(
      "ses_new",
      "opsx-propose",
      "add dark mode",
      ws,
      {}
    );
  });

  it("starts on the chosen model with the attached files, in a checkout and in a new worktree", async () => {
    const s = await started();
    const model = { id: "gpt-5", providerID: "openai" };
    const attachments = [
      { name: "shot.png", url: "data:image/png;base64,aGk=" },
    ];
    await s.hub.chat.start(project.id, {
      target: { kind: "checkout", directory: ws },
      message: { text: "what's wrong here", attachments, model },
    });
    expect(s.client.createSession).toHaveBeenCalledWith(ws, {
      title: undefined,
      model,
    });
    expect(s.client.prompt).toHaveBeenCalledWith(
      "ses_new",
      "what's wrong here",
      undefined,
      ws,
      { files: [{ name: "shot.png", uri: attachments[0].url }] }
    );
    s.client.createSession.mockClear();
    s.client.prompt.mockClear();
    await s.hub.chat.start(project.id, {
      target: { kind: "worktree" },
      message: { text: "fix the layout", attachments, model },
    });
    await vi.waitFor(() => expect(s.client.prompt).toHaveBeenCalledOnce());
    expect(s.client.createSession.mock.calls[0][1]).toMatchObject({ model });
    expect(s.client.prompt.mock.calls[0][4]).toStrictEqual({
      files: [{ name: "shot.png", uri: attachments[0].url }],
    });
  });

  it("refuses a directory outside the project and the hub's commands, starting nothing", async () => {
    const s = await started();
    await expect(
      s.hub.chat.start(project.id, {
        target: { kind: "checkout", directory: "/etc" },
        message: { text: "hi" },
      })
    ).rejects.toThrow(InvalidRequestError);
    for (const target of [
      { kind: "worktree" as const },
      { kind: "checkout" as const, directory: ws },
    ]) {
      await expect(
        s.hub.chat.start(project.id, { target, message: { text: "/new hi" } })
      ).rejects.toThrow(InvalidRequestError);
    }
    expect(s.client.createSession).not.toHaveBeenCalled();
    expect(s.dbs.chats.listForProject(project.id)).toStrictEqual([]);
  });

  it("refuses a bad mention before creating a conversation", async () => {
    const s = await started();
    await expect(
      s.hub.chat.start(project.id, {
        target: { kind: "checkout", directory: ws },
        message: {
          text: "@../secret",
          mentions: [{ kind: "file", start: 0, end: 10, name: "../secret" }],
        },
      })
    ).rejects.toThrow(InvalidRequestError);
    expect(s.client.createSession).not.toHaveBeenCalled();
  });

  it("looks a chat up, archives it, and says where an adopted chat went", async () => {
    const s = await started();
    const { chat } = await s.hub.chat.start(project.id, {
      target: { kind: "checkout", directory: ws },
      message: { text: "hi" },
    });
    expect(s.hub.chat.lookup(project.id, chat)).toMatchObject({
      chat: { id: chat, sessionId: "ses_new" },
    });
    expect(() => s.hub.chat.lookup(project.id, "c_missing")).toThrow(
      NotFoundError
    );
    s.hub.chat.archive(project.id, chat);
    expect(s.store.snapshot().projects[0].chats).toStrictEqual([]);
    // The session keeps running.
    expect(s.client.deleteSession).not.toHaveBeenCalled();
  });

  it("records generated text's session as an internal chat, kept out of the snapshot", async () => {
    const s = await started();
    const { sessionId } = await s.hub.sessions.generateIn(
      project.id,
      ws,
      "summarise",
      { title: "Commit message" }
    );
    expect(s.dbs.chats.bySession(sessionId)?.origin).toBe("internal");
    s.store.setSessions(project.id, [
      {
        directory: ws,
        id: sessionId,
        projectId: project.id,
        status: "idle",
        title: "Commit message",
        updatedAt: 1,
      },
    ]);
    const snapshot = s.store.snapshot().projects[0];
    expect(snapshot.chats).toStrictEqual([]);
    expect(snapshot.sessions).toStrictEqual([]);
  });
});

describe("make task", () => {
  const ws = "/workspaces/demo";
  async function withChat() {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.client.commands.mockResolvedValue([{ name: "opsx-propose" }]);
    const { chat } = await s.hub.chat.start(project.id, {
      target: { kind: "worktree" },
      message: { text: "APP-42 add a dark mode toggle" },
    });
    await vi.waitFor(() => expect(s.dbs.chats.get(chat)?.step).toBe("session"));
    s.client.prompt.mockClear();
    s.client.command.mockClear();
    s.client.createSession.mockClear();
    return { ...s, chat };
  }

  it("adopts the chat as variant 1 with nothing sent to its session", async () => {
    const s = await withChat();
    const before = s.dbs.chats.get(s.chat);
    const { task } = await s.hub.chat.makeTask(project.id, s.chat, {
      brief: "Add a dark mode toggle",
      title: "Dark mode",
    });
    expect(s.tasks.get(task)).toMatchObject({
      fromChat: s.chat,
      kind: "task",
      prompt: "Add a dark mode toggle",
      title: "Dark mode",
      variants: [
        {
          branch: before?.branch,
          directory: before?.directory,
          n: 1,
          sessionId: before?.sessionId,
          step: "session",
        },
      ],
    });
    expect(s.client.prompt).not.toHaveBeenCalled();
    expect(s.client.command).not.toHaveBeenCalled();
    expect(s.client.createSession).not.toHaveBeenCalled();
    expect(s.hub.chat.lookup(project.id, s.chat)).toStrictEqual({
      adoptedBy: { n: 1, task },
    });
    await expect(
      s.hub.chat.makeTask(project.id, s.chat, { brief: "", title: "Again" })
    ).rejects.toThrow(/already belongs/u);
    expect(s.tasks.listForProject(project.id)).toHaveLength(1);
  });

  it("refuses a chat in the main checkout", async () => {
    const s = await withChat();
    const { chat } = await s.hub.chat.start(project.id, {
      target: { kind: "checkout", directory: ws },
      message: { text: "hi" },
    });
    await expect(
      s.hub.chat.makeTask(project.id, chat, { brief: "b", title: "t" })
    ).rejects.toThrow(/only a chat in a worktree/u);
  });

  it("runs opsx-propose with the brief in the adopted conversation for the spec option", async () => {
    const s = await withChat();
    const session = s.dbs.chats.get(s.chat)?.sessionId;
    const { task } = await s.hub.chat.makeTask(project.id, s.chat, {
      brief: "Add a dark mode toggle",
      spec: true,
      title: "Dark mode",
    });
    expect(s.client.command).toHaveBeenCalledWith(
      session,
      "opsx-propose",
      "Add a dark mode toggle",
      s.dbs.chats.get(s.chat)?.directory,
      {}
    );
    expect(s.tasks.get(task)).toMatchObject({
      spec: { first: true },
      variants: [{ n: 1, spec: { phase: "propose" } }],
    });
  });

  it("shows on variant 1 that opsx-propose could not run", async () => {
    const s = await withChat();
    s.client.command.mockRejectedValueOnce(new Error("opencode is busy"));
    const { task } = await s.hub.chat.makeTask(project.id, s.chat, {
      brief: "Add a dark mode toggle",
      spec: true,
      title: "Dark mode",
    });
    expect(s.tasks.get(task)?.variants[0]).toMatchObject({
      error:
        "could not run opsx-propose: opencode is busy; run it in the conversation",
      step: "session",
    });
    expect(s.tasks.get(task)?.state).toBe("running");
  });

  it("adds extra variants after variant 1, and keeps the task when one fails", async () => {
    const s = await withChat();
    s.worktrees.add.mockRejectedValueOnce(new Error("no space left"));
    const { task } = await s.hub.chat.makeTask(project.id, s.chat, {
      brief: "Add a dark mode toggle",
      title: "Dark mode",
      variants: [{ agent: "plan" }, {}],
    });
    await vi.waitFor(() =>
      expect(s.tasks.get(task)?.variants.map((v) => v.step)).toStrictEqual([
        "session",
        "failed",
        "session",
      ])
    );
    const variants = s.tasks.get(task)?.variants ?? [];
    expect(variants[1].error).toBe("no space left");
    expect(s.client.prompt).toHaveBeenCalledWith(
      expect.any(String),
      "Add a dark mode toggle",
      undefined,
      variants[2].directory,
      {},
      FIRST_TURN_TIMEOUT_MS
    );
  });

  it("suggests the ticket in the branch and messages, and drafts a brief from the chat's own session", async () => {
    const s = await withChat();
    s.client.userMessages.mockResolvedValueOnce([
      { id: "m2", text: "see also OPS-7", time: { created: 2 } },
      { id: "m1", text: "APP-42 add a dark mode toggle", time: { created: 1 } },
    ]);
    expect(await s.hub.chat.suggestions(project.id, s.chat)).toStrictEqual({
      pullRequests: [],
      tickets: ["APP-42", "OPS-7"],
    });
    s.client.generate.mockResolvedValueOnce("  ## Goal\nDark mode  ");
    expect(await s.hub.chat.brief(project.id, s.chat)).toStrictEqual({
      brief: "## Goal\nDark mode",
    });
    const session = s.dbs.chats.get(s.chat)?.sessionId;
    expect(s.client.generate.mock.calls.at(-1)?.[0]).toBe(session);
    expect(s.client.prompt).not.toHaveBeenCalled();
  });
});
