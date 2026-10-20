import { describe, expect, it, vi } from "vitest";

import { RESTART_ERROR } from "../../../src/server/db/tasks";
import type { ConfigRead } from "../../../src/server/environments/containers";
import type { StateStore } from "../../../src/server/projects/state";
import { project, setup } from "../../helpers/hub";

const plain: ConfigRead = {
  configuration: { image: "node:22" },
  merged: { image: "node:22" },
  workspaceFolder: "/workspaces/fix",
};
const mounted: ConfigRead = {
  configuration: {
    image: "node:22",
    mounts: ["source=/,target=/host,type=bind"],
  },
  merged: { image: "node:22", mounts: ["source=/,target=/host,type=bind"] },
  workspaceFolder: "/workspaces/fix",
};

/** A started project whose worktrees at a path ending `-2` (or every one, with `all`) need approval. */
const started = async (all = false) => {
  const s = setup();
  await s.hub.environments.rescan();
  await s.hub.environments.start(project.id);
  let n = 0;
  s.client.createSession.mockImplementation(async (directory: string) => ({
    id: `ses_${++n}`,
    location: { directory },
  }));
  s.worktrees.add.mockImplementation(async (_p, a) => ({
    branch: a.branch,
    hostPath: `${a.root.host}/${a.branch}`,
    path: `${a.root.container}/${a.branch}`,
  }));
  s.containers.readConfig.mockImplementation(async (folder: string) =>
    folder !== project.path && (all || folder.endsWith("-2")) ? mounted : plain
  );
  return s;
};

const startingOf = (s: { store: StateStore }, task: string) =>
  s.store.snapshot().projects[0].tasks.find((t) => t.id === task);

describe("variants waiting for approval", () => {
  it("waits at `approval` and goes on once the user approves", async () => {
    const s = await started(true);
    const { task } = await s.hub.tasks.startTask(project.id, {
      environment: "isolated",
      prompt: "Fix",
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].step).toBe("approval")
    );
    expect(s.images.ensureBase).not.toHaveBeenCalled();
    const [pending] = s.approvals.pending(project.id);
    expect(pending.sources[0]).toMatchObject({ kind: "worktree" });

    s.approvals.approve(project.id, pending.fingerprint);
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].sessionId).toBe("ses_1")
    );
    expect(s.images.ensureBase).toHaveBeenCalledOnce();
    expect(s.client.createSession).toHaveBeenCalledOnce();
  });

  it("fails with the not-approved error when the user keeps it stopped", async () => {
    const s = await started(true);
    const { task } = await s.hub.tasks.startTask(project.id, {
      environment: "isolated",
      prompt: "Fix",
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].step).toBe("approval")
    );
    s.approvals.refuse(
      project.id,
      s.approvals.pending(project.id)[0].fingerprint
    );
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0]).toMatchObject({
        error: expect.stringContaining("its container config was not approved"),
        step: "failed",
      })
    );
    expect(s.images.ensureBase).not.toHaveBeenCalled();
  });

  it("stops waiting when a pick discards it, without building anything", async () => {
    const s = await started();
    const { task } = await s.hub.tasks.startTask(project.id, {
      environment: "isolated",
      prompt: "Fix",
      variants: [{}, {}],
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[1].step).toBe("approval")
    );
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].sessionId).toBe("ses_1")
    );
    await s.hub.tasks.pickVariant(project.id, task, "ses_1", false);
    await vi.waitFor(() =>
      expect(s.tasks.get(task)?.variants[1]).toMatchObject({
        discarded: true,
        step: "failed",
      })
    );
    // Only the picked variant's image was built.
    expect(s.images.ensureBase).toHaveBeenCalledOnce();
    expect(s.approvals.pending(project.id)).toStrictEqual([]);
  });

  it("is failed by a restart, like any other setup step", async () => {
    const s = await started(true);
    const { task } = await s.hub.tasks.startTask(project.id, {
      environment: "isolated",
      prompt: "Fix",
    });
    await vi.waitFor(() =>
      expect(startingOf(s, task)?.variants[0].step).toBe("approval")
    );
    s.tasks.failInterrupted();
    expect(s.tasks.get(task)?.variants[0]).toMatchObject({
      error: RESTART_ERROR,
      step: "failed",
    });
  });
});
