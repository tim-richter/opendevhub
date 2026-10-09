import { describe, expect, it, vi } from "vitest";

import { BusyError } from "../../../src/server/errors";
import { rawSession } from "../../helpers/fake-opencode";
import { project, running, feat, setup, withEnv } from "../../helpers/hub";

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
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.worktrees.list.mockResolvedValue([featWt]);
    s.git.branchRefs.mockResolvedValue([
      { name: "main", gone: false },
      { name: "feat", gone: false },
    ]);
    s.git.recordedBase.mockResolvedValue(undefined);
    return s;
  }

  it("scans branches in the container and refreshes the worktree list", async () => {
    const { hub, git, store } = await running();
    const r = await hub.cleanupTargets.cleanupScan(project.id);
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
    const { hub, worktrees, git } = await running();
    await expect(
      hub.cleanupTargets.cleanupBranch(project.id, item)
    ).resolves.toStrictEqual({
      outcome: "removed",
    });
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
    expect(hub.environments.logLines(project.id)).toContain(
      "cleanup: deleted branch feat (merged into main) and its worktree"
    );
  });

  it("deletes an upstream-gone branch with -D", async () => {
    const { hub, git } = await running();
    git.isAncestor.mockResolvedValue(false);
    git.branchRefs.mockResolvedValue([
      { name: "feat", upstream: "refs/remotes/origin/feat", gone: true },
    ]);
    const gone = {
      ...item,
      why: "upstream-gone" as const,
      reason: "its upstream is gone; it may not be merged",
    };
    await expect(
      hub.cleanupTargets.cleanupBranch(project.id, gone)
    ).resolves.toStrictEqual({
      outcome: "removed",
    });
    expect(git.deleteBranch).toHaveBeenCalledWith(
      project,
      "/workspaces/demo",
      "feat",
      true
    );
  });

  it("forces the worktree removal only for an item scanned as dirty", async () => {
    const { hub, worktrees, git } = await running();
    git.isClean.mockResolvedValue(false);
    await hub.cleanupTargets.cleanupBranch(project.id, {
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
    const { hub, worktrees, git } = await running();
    git.isAncestor.mockResolvedValue(false);
    await expect(
      hub.cleanupTargets.cleanupBranch(project.id, item)
    ).resolves.toStrictEqual({
      outcome: "skipped",
      message: "changed since scan",
    });
    expect(worktrees.remove).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it("removes the worktree's own container first", async () => {
    const { hub, store, containers } = await running();
    store.putEnvironment({
      id: "env-feat",
      projectId: project.id,
      worktree: featWt,
    });
    store.updateRuntime("env-feat", { containerId: "c9" });
    await hub.cleanupTargets.cleanupBranch(project.id, {
      ...item,
      env: "env-feat",
    });
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
    const { hub, client, envId } = await withEnv();
    client.sessions
      .mockResolvedValueOnce([
        discarded("ses_d"),
        rawSession("ses_gone", {
          location: { directory: "/workspaces/demo.worktrees/old" },
          time: { created: 1, updated: Date.now() },
        }),
      ])
      .mockResolvedValueOnce([discarded("ses_t", featWt.path)]);
    const r = await hub.cleanupTargets.cleanupSessionScan(project.id);
    expect(r.items.map((i) => [i.id, i.why, i.envId])).toStrictEqual([
      ["session:demo-abc123:ses_d", "discarded", undefined],
      ["session:demo-abc123:ses_gone", "worktree-gone", undefined],
      ["session:demo-abc123:ses_t", "discarded", envId],
    ]);
  });

  it("leaves out busy sessions, and skips the worktree rule when the worktree list can't be read", async () => {
    const { hub, client, store, worktrees } = await running();
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
    expect(
      (await hub.cleanupTargets.cleanupSessionScan(project.id)).items
    ).toStrictEqual([]);
  });

  it("deletes a session that still qualifies, logs it, and skips one that changed", async () => {
    const { hub, client } = await running();
    client.sessions.mockResolvedValue([discarded("ses_d")]);
    const [found] = (await hub.cleanupTargets.cleanupSessionScan(project.id))
      .items;
    await expect(
      hub.cleanupTargets.cleanupSession(project.id, found)
    ).resolves.toStrictEqual({
      outcome: "removed",
    });
    expect(client.deleteSession).toHaveBeenCalledWith(
      "ses_d",
      "/workspaces/demo"
    );
    expect(hub.environments.logLines(project.id)).toContain(
      "cleanup: removed session Session ses_d (discarded task variant)"
    );
    client.sessions.mockResolvedValue([]);
    await expect(
      hub.cleanupTargets.cleanupSession(project.id, found)
    ).resolves.toStrictEqual({
      outcome: "skipped",
      message: "changed since scan",
    });
    expect(client.deleteSession).toHaveBeenCalledOnce();
  });

  it("refuses a session item naming another project's environment", async () => {
    const { hub, client, store } = await running();
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
      hub.cleanupTargets.cleanupSession(project.id, forged)
    ).resolves.toStrictEqual({
      outcome: "skipped",
      message: "changed since scan",
    });
    expect(client.deleteSession).not.toHaveBeenCalled();
  });

  it("refuses while another git action runs", async () => {
    const { hub, git } = await running();
    let release!: () => void;
    git.fetchPrune.mockImplementation(
      () => new Promise<void>((r) => (release = r))
    );
    const first = hub.cleanupTargets.cleanupScan(project.id);
    expect(() => hub.cleanupTargets.cleanupBranch(project.id, item)).toThrow(
      BusyError
    );
    await vi.waitFor(() => expect(git.fetchPrune).toHaveBeenCalled());
    release();
    await first;
  });
});
