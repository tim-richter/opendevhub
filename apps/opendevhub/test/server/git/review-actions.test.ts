import { describe, expect, it } from "vitest";

import { CommandError } from "../../../src/server/environments/containers";
import { NotFoundError } from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import { OpencodeHttpError } from "../../../src/server/opencode/client";
import { project, running, feat, setup, form } from "../../helpers/hub";

describe("review", () => {
  const wt = "/workspaces/demo.worktrees/x";
  async function running() {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.store.updateRuntime(project.id, {
      worktrees: [{ path: wt, branch: "x" }],
    });
    return s;
  }

  it("describes publishing for the target, from the host path of a worktree", async () => {
    const { hub, publisher, store } = await running();
    store.updateRuntime(project.id, {
      worktrees: [{ path: wt, branch: "x", hostPath: "/src/demo.worktrees/x" }],
    });
    const info = await hub.reviews.publishInfo(project.id, wt, "origin");
    expect(publisher.info).toHaveBeenCalledWith(
      project,
      { container: wt, host: "/src/demo.worktrees/x" },
      "x",
      "origin"
    );
    expect(info.branch).toBe("x");
    await hub.reviews.publishInfo(project.id, "/workspaces/demo");
    expect(publisher.info).toHaveBeenLastCalledWith(
      project,
      { container: "/workspaces/demo", host: "/src/demo" },
      "main",
      undefined
    );
  });

  it("publishes the target's branch after validating the request", async () => {
    const { hub, publisher } = await running();
    const good = {
      remote: "origin",
      base: "main",
      strategy: "branch",
      title: " Add x ",
      description: "d",
    };
    const result = await hub.reviews.publish(project.id, wt, good);
    expect(publisher.publish.mock.calls[0][2]).toBe("x");
    expect(publisher.publish.mock.calls[0][3]).toEqual({
      remote: "origin",
      base: "main",
      strategy: "branch",
      title: "Add x",
      description: "d",
    });
    expect(result.openUrl).toContain("/compare/");
    expect(hub.environments.logLines(project.id).join("\n")).toMatch(
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
      await expect(hub.reviews.publish(project.id, wt, bad)).rejects.toThrow(
        InvalidRequestError
      );
    }
    await expect(
      hub.reviews.publish(project.id, wt, { ...good, base: "x" })
    ).rejects.toThrow(/not the base itself/u);
  });

  it("suggests a title and description from the latest session", async () => {
    const { hub, client, store } = await running();
    await expect(
      hub.reviews.publishSuggestion(project.id, wt)
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
      hub.reviews.publishSuggestion(project.id, wt)
    ).resolves.toStrictEqual({
      title: "Add login",
      description: "Adds the form.",
    });
  });

  it("compares a worktree with its recorded base on request", async () => {
    const { hub, client, git } = await running();
    git.isClean.mockImplementation(
      async (_p, dir) => dir === "/workspaces/demo"
    );
    client.vcsStatus.mockResolvedValueOnce([{ file: "a.ts" }]);
    const r = await hub.reviews.review(project.id, wt, { mode: "branch" });
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

  it("reads an image's old version at HEAD or the merge-base, and its new one from the working copy", async () => {
    const { hub, git } = await running();
    const max = { maxBytes: 10 * 1024 * 1024 };
    await expect(
      hub.reviews.reviewImage(project.id, wt, {
        file: "img/a.png",
        side: "new",
      })
    ).resolves.toStrictEqual({
      bytes: Buffer.from("img/a.png"),
      type: "image/png",
    });
    expect(git.fileBytes).toHaveBeenLastCalledWith(
      project,
      wt,
      "img/a.png",
      max
    );
    await hub.reviews.reviewImage(project.id, wt, {
      file: "a.png",
      side: "old",
    });
    expect(git.fileBytes).toHaveBeenLastCalledWith(project, wt, "a.png", {
      ...max,
      rev: "HEAD",
    });
    await hub.reviews.reviewImage(project.id, wt, {
      base: "develop",
      file: "a.jpg",
      mode: "branch",
      side: "old",
    });
    expect(git.mergeBase).toHaveBeenLastCalledWith(project, wt, "develop");
    expect(git.fileBytes).toHaveBeenLastCalledWith(project, wt, "a.jpg", {
      ...max,
      rev: "c0ffee",
    });
    git.mergeBase.mockResolvedValueOnce(undefined);
    await expect(
      hub.reviews.reviewImage(project.id, wt, {
        file: "a.png",
        mode: "branch",
        side: "old",
      })
    ).resolves.toBeUndefined();
  });

  it("refuses an image path outside the checkout or a file that isn't an image", async () => {
    const { hub } = await running();
    for (const file of ["../a.png", "/etc/a.png", "a.ts", "-a.png"]) {
      await expect(
        hub.reviews.reviewImage(project.id, wt, { file, side: "new" })
      ).rejects.toThrow(InvalidRequestError);
    }
    await expect(
      hub.reviews.reviewImage(project.id, "/etc", {
        file: "a.png",
        side: "new",
      })
    ).rejects.toThrow(InvalidRequestError);
  });

  it("shows uncommitted changes by default, still resolving the base", async () => {
    const { hub, client, git } = await running();
    git.recordedBase.mockResolvedValue(undefined);
    const r = await hub.reviews.review(project.id, "/workspaces/demo");
    expect(r.base).toStrictEqual({ name: "main", source: "default" });
    expect(r.mode).toBe("working");
    expect(client.vcsDiff).toHaveBeenCalledWith(
      "/workspaces/demo",
      "working",
      undefined
    );
    const w = await hub.reviews.review(project.id, wt);
    expect(w).toMatchObject({
      mode: "working",
      base: { name: "main", source: "default" },
      ahead: 2,
    });
    expect(client.vcsDiff).toHaveBeenLastCalledWith(wt, "working", undefined);
  });

  it("takes a base override, returns one file on request, and rejects option-like bases and unknown folders", async () => {
    const { hub, client } = await running();
    const r = await hub.reviews.review(project.id, wt, {
      base: "develop",
      mode: "branch",
      file: "b.ts",
    });
    expect(client.vcsDiff).toHaveBeenLastCalledWith(wt, "branch", "develop");
    expect(r.base).toEqual({ name: "develop", source: "request" });
    expect(r.files.map((f) => f.file)).toStrictEqual(["b.ts"]);
    await expect(
      hub.reviews.review(project.id, wt, { base: "--upload-pack=evil" })
    ).rejects.toThrow(InvalidRequestError);
    await expect(hub.reviews.review(project.id, "/etc")).rejects.toThrow(
      InvalidRequestError
    );
  });

  it("shows what a session's turn changed, the newest by default, and lists its prompts", async () => {
    const { hub, client, store } = await running();
    const fallback = await hub.reviews.review(project.id, wt, { mode: "turn" });
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
    const r = await hub.reviews.review(project.id, wt, { mode: "turn" });
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
    const older = await hub.reviews.review(project.id, wt, {
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
    const { hub, client, store } = await running();
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
      hub.reviews.review(project.id, wt, { mode: "turn", session: "ses_main" })
    ).rejects.toThrow(NotFoundError);
    await expect(
      hub.reviews.review(project.id, wt, { mode: "turn", from: "msg_1&to=x" })
    ).rejects.toThrow(InvalidRequestError);
    client.sessionDiff.mockRejectedValueOnce(
      new OpencodeHttpError(404, "/api/session/ses_wt/diff")
    );
    await expect(
      hub.reviews.review(project.id, wt, { mode: "turn", from: "msg_1" })
    ).rejects.toThrow(/unknown turn msg_1/u);
    client.userMessages.mockResolvedValueOnce([]);
    const empty = await hub.reviews.review(project.id, wt, { mode: "turn" });
    expect(empty.files).toStrictEqual([]);
    expect(empty.turn).toMatchObject({ latest: true, prompts: [] });
  });

  it("details a session: its turns, tokens, subagents and its model's context window", async () => {
    const { hub, client, store } = await running();
    await expect(
      hub.sessions.sessionDetail(project.id, "ses_x")
    ).rejects.toThrow(NotFoundError);
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
    const d = await hub.sessions.sessionDetail(project.id, "ses_1");
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
      turns: [{ id: "msg_1", prompt: "Fix it", reply: "Done.", completed: 4 }],
    });
    expect(d.session.title).toBe("Login");
  });

  it("prompts a session, queued while it runs, and starts a session with a first prompt", async () => {
    const { hub, client, store } = await running();
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
    await hub.sessions.promptSession(project.id, "ses_run", "fix it");
    await hub.sessions.promptSession(project.id, "ses_idle", "fix it");
    expect(client.prompt.mock.calls).toStrictEqual([
      ["ses_run", "fix it", "queue", wt],
      ["ses_idle", "fix it", undefined, wt],
    ]);
    await expect(
      hub.sessions.promptSession(project.id, "ses_nope", "x")
    ).rejects.toThrow(NotFoundError);
    await expect(
      hub.sessions.promptSession(project.id, "ses_idle", "  ")
    ).rejects.toThrow(InvalidRequestError);
    const sid = await hub.sessions.startSession(
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
    const { hub, client, store } = await running();
    await expect(hub.reviews.commitMessage(project.id, wt)).resolves.toBe("");
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
    await expect(hub.reviews.commitMessage(project.id, wt)).resolves.toBe(
      "feat: do things"
    );
    expect(client.generate.mock.calls[0][0]).toBe("ses_new");
    client.generate.mockRejectedValueOnce(new Error("no model"));
    await expect(hub.reviews.commitMessage(project.id, wt)).resolves.toBe("");
  });

  it("generates in a given idle session of the checkout, or in a new one", async () => {
    const { hub, client, store } = await running();
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
      hub.sessions.generateIn(project.id, wt, "findings?", options)
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      hub.sessions.generateIn(project.id, wt, "findings?", {
        ...options,
        sessionId: "ses_x",
      })
    ).rejects.toThrow(/ses_x/u);
    store.setSessions(project.id, [{ ...session, status: "idle" }]);
    await expect(
      hub.sessions.generateIn(project.id, wt, "findings?", options)
    ).resolves.toEqual({ sessionId: "ses_review", text: "feat: do things" });
    expect(client.generate).toHaveBeenLastCalledWith(
      "ses_review",
      "findings?",
      wt,
      5
    );

    await expect(
      hub.sessions.generateIn(project.id, wt, "review the diff", {
        title: "AI review",
      })
    ).resolves.toEqual({ sessionId: "ses_new", text: "feat: do things" });
    expect(client.createSession).toHaveBeenLastCalledWith(wt, {
      title: "AI review",
    });
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("commits, refusing an empty message or a clean checkout", async () => {
    const { hub, git } = await running();
    await expect(hub.reviews.commit(project.id, wt, "  ")).rejects.toThrow(
      InvalidRequestError
    );
    await expect(hub.reviews.commit(project.id, wt, "feat: x")).rejects.toThrow(
      /nothing to commit/u
    );
    git.isClean.mockResolvedValue(false);
    await hub.reviews.commit(project.id, wt, " feat: x ");
    expect(git.commit).toHaveBeenCalledWith(project, wt, "feat: x");
    expect(hub.environments.logLines(project.id).join("\n")).toMatch(
      /review: commit/u
    );
  });

  it("rebases an unpushed branch, merges a pushed one, and reports conflicts", async () => {
    const { hub, git } = await running();
    await expect(
      hub.reviews.updateFromBase(project.id, wt, "main")
    ).resolves.toStrictEqual({ strategy: "rebase" });
    git.isPushed.mockResolvedValue(true);
    git.update.mockResolvedValueOnce({
      strategy: "merge",
      conflicts: ["a.ts"],
    });
    await expect(
      hub.reviews.updateFromBase(project.id, wt, "main")
    ).resolves.toStrictEqual({ strategy: "merge", conflicts: ["a.ts"] });
    expect(hub.environments.logLines(project.id).join("\n")).toMatch(
      /conflicts in a\.ts; aborted/u
    );
    await expect(
      hub.reviews.updateFromBase(project.id, wt, "-x")
    ).rejects.toThrow(InvalidRequestError);
    git.isClean.mockResolvedValue(false);
    await expect(
      hub.reviews.updateFromBase(project.id, wt, "main")
    ).rejects.toThrow(/uncommitted/u);
  });

  it("merges a clean worktree into a clean main checkout that is on the base", async () => {
    const { hub, git } = await running();
    await expect(
      hub.reviews.mergeIntoBase(project.id, wt, "main", false)
    ).resolves.toStrictEqual({ branch: "x" });
    expect(git.mergeInto).toHaveBeenCalledWith(
      project,
      "/workspaces/demo",
      "x",
      false
    );
    await expect(
      hub.reviews.mergeIntoBase(project.id, "/workspaces/demo", "main", false)
    ).rejects.toThrow(/main checkout is the base/u);
    await expect(
      hub.reviews.mergeIntoBase(project.id, wt, "develop", false)
    ).rejects.toThrow(/is on main, not develop/u);
    git.isClean.mockImplementation(
      async (_p, dir) => dir !== "/workspaces/demo"
    );
    await expect(
      hub.reviews.mergeIntoBase(project.id, wt, "main", true)
    ).rejects.toThrow(/main checkout has uncommitted/u);
  });

  it("still refreshes the worktree list when deleting the branch fails", async () => {
    const { hub, git, worktrees, store } = await running();
    git.deleteBranch.mockRejectedValueOnce(
      new CommandError("git branch failed: not fully merged")
    );
    worktrees.list.mockResolvedValueOnce([]);
    await expect(
      hub.checkouts.removeWorktree(project.id, wt, false, true)
    ).rejects.toThrow(/not fully merged/u);
    expect(store.runtime(project.id).worktrees).toStrictEqual([]);
  });

  it("removes a worktree and deletes its branch when asked", async () => {
    const { hub, git } = await running();
    await hub.checkouts.removeWorktree(project.id, wt, false, true);
    expect(git.deleteBranch).toHaveBeenCalledWith(
      project,
      "/workspaces/demo",
      "x"
    );
  });
});
