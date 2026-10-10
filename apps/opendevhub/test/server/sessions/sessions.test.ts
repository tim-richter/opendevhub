import { describe, expect, it } from "vitest";

import {
  AlreadyAnsweredError,
  NotFoundError,
  UnavailableError,
} from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import { OpencodeHttpError } from "../../../src/server/opencode/client";
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

describe("manual tasks", () => {
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

  it("gives a session started in the main checkout a manual task, claiming the directory meanwhile", async () => {
    const s = await started();
    const claimed: boolean[] = [];
    s.client.createSession.mockImplementationOnce(async (directory) => {
      claimed.push(s.tasks.isClaimed(project.id, directory));
      return { id: "ses_m", location: { directory } };
    });
    const id = await s.hub.sessions.startSession(
      project.id,
      "/workspaces/demo",
      "Look around"
    );
    expect(id).toBe("ses_m");
    expect(claimed).toStrictEqual([true]);
    expect(s.tasks.isClaimed(project.id, "/workspaces/demo")).toBeFalsy();
    expect(onlyTask(s)).toMatchObject({
      createdAt: s.clock.now,
      kind: "manual",
      state: "running",
      title: "Look around",
      variants: [
        {
          directory: "/workspaces/demo",
          envId: project.id,
          n: 1,
          sessionId: "ses_m",
          step: "session",
        },
      ],
    });
    expect(onlyTask(s).variants[0].branch).toBeUndefined();
  });

  it("records the branch of a new worktree started with a session", async () => {
    const s = await started();
    const path = "/workspaces/demo.worktrees/feature-login";
    s.worktrees.list.mockResolvedValue([{ branch: "feature/login", path }]);
    await s.hub.checkouts.createWorktree(project.id, {
      branch: "feature/login",
      startSession: true,
    });
    expect(onlyTask(s)).toMatchObject({
      kind: "manual",
      title: "feature/login",
      variants: [{ branch: "feature/login", directory: path }],
    });
  });

  it("gives a new session made to generate text a manual task, but not a reused one", async () => {
    const s = await started();
    const { sessionId } = await s.hub.sessions.generateIn(
      project.id,
      "/workspaces/demo",
      "Write a commit message",
      { title: "Commit message" }
    );
    expect(onlyTask(s)).toMatchObject({
      kind: "manual",
      title: "Commit message",
      variants: [{ sessionId }],
    });
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

  it("leaves no task or claim behind when opencode refuses the session", async () => {
    const s = await started();
    s.client.createSession.mockRejectedValueOnce(new Error("down"));
    await expect(
      s.hub.sessions.startSession(project.id, "/workspaces/demo")
    ).rejects.toThrow("down");
    expect(s.tasks.listForProject(project.id)).toStrictEqual([]);
    expect(s.tasks.isClaimed(project.id, "/workspaces/demo")).toBeFalsy();
  });
});
