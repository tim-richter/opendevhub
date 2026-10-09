import { describe, expect, it, vi } from "vitest";

import {
  BusyError,
  NotFoundError,
  UnavailableError,
} from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import type { Worktree } from "../../../src/shared/types";
import { project, running, setup } from "../../helpers/hub";

describe("worktrees", () => {
  const wtPath = "/workspaces/demo.worktrees/feature-x";
  const known: Worktree = {
    path: wtPath,
    hostPath: "/src/demo.worktrees/feature-x",
    branch: "feature/x",
  };

  it("mounts a host folder next to the project, created before up", async () => {
    const { store, containers, mkdir, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(mkdir).toHaveBeenCalledWith("/src/demo.worktrees");
    expect(containers.up.mock.calls[0][1].mounts).toStrictEqual([
      "type=bind,source=/src/demo.worktrees,target=/workspaces/demo.worktrees",
      `type=volume,source=opendevhub-opencode-${project.id},target=/opendevhub/opencode`,
    ]);
    expect(store.runtime(project.id)).toMatchObject({
      containerName: "demo_c1",
      remoteUser: "node",
      worktreeRoot: {
        host: "/src/demo.worktrees",
        container: "/workspaces/demo.worktrees",
        mounted: true,
      },
    });
  });

  it("uses the configured workspace folder for the mount target", async () => {
    const { containers, hub } = setup();
    containers.workspaceFolder.mockResolvedValueOnce("/code/demo");
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(containers.up.mock.calls[0][1].mounts?.[0]).toMatch(
      /target=\/code\/demo\.worktrees$/u
    );
  });

  it("still starts when the folder can't be created, and flags a container without the mount", async () => {
    const { store, containers, mkdir, hub } = setup();
    mkdir.mockRejectedValueOnce(new Error("EACCES"));
    containers.inspect.mockResolvedValue({ ...running, binds: {} });
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    expect(containers.up.mock.calls[0][1].mounts).toStrictEqual([
      `type=volume,source=opendevhub-opencode-${project.id},target=/opendevhub/opencode`,
    ]);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      worktreeRoot: { mounted: false },
    });
    expect(hub.environments.logLines(project.id).join("\n")).toMatch(
      /EACCES[\s\S]*rebuild it to enable worktrees/u
    );
    await expect(
      hub.checkouts.createWorktree(project.id, { branch: "x" })
    ).rejects.toBeInstanceOf(UnavailableError);
  });

  it("lists worktrees on start and on adopt", async () => {
    const { store, worktrees, containers, hub } = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
    });
    worktrees.list.mockResolvedValue([known]);
    containers.listManaged.mockResolvedValue([running]);
    await hub.environments.rescan();
    await hub.environments.adopt();
    expect(worktrees.list.mock.calls[0][2]).toMatchObject({ mounted: true });
    expect(store.runtime(project.id).worktrees).toStrictEqual([known]);
  });

  it("creates a worktree, refreshes the list and starts a session in it", async () => {
    const { store, worktrees, client, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    worktrees.list.mockResolvedValue([known]);
    const res = await hub.checkouts.createWorktree(project.id, {
      branch: " feature/x ",
      base: " ",
      startSession: true,
    });
    expect(worktrees.add.mock.calls[0][1]).toMatchObject({
      branch: "feature/x",
      base: undefined,
      origin: undefined,
      workspaceFolder: "/workspaces/demo",
    });
    expect(client.createSession).toHaveBeenCalledWith(res.worktree.path, {
      title: "feature/x",
    });
    expect(res.sessionId).toBe("ses_new");
    expect(store.runtime(project.id).worktrees).toStrictEqual([known]);
  });

  it("remembers the pull request a worktree checks out", async () => {
    const { worktrees, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    const url = "https://forge.example/o/r/pulls/5";
    await hub.checkouts.createWorktree(project.id, {
      branch: "review/pr-5",
      pull: { commitId: "a".repeat(40), number: 5, url },
    });
    expect(worktrees.add.mock.calls[0][1]).toMatchObject({
      base: "a".repeat(40),
      origin: url,
    });
  });

  it("validates input and needs a running container", async () => {
    const { hub } = setup();
    await hub.environments.rescan();
    expect(() =>
      hub.checkouts.createWorktree(project.id, { branch: "a b" })
    ).toThrow(InvalidRequestError);
    expect(() =>
      hub.checkouts.createWorktree(project.id, { branch: "ok" })
    ).toThrow(UnavailableError);
    expect(() =>
      hub.checkouts.createWorktree("nope", { branch: "ok" })
    ).toThrow(NotFoundError);
  });

  it("runs one git operation at a time per project", async () => {
    const { worktrees, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    let release!: () => void;
    worktrees.add.mockImplementationOnce(
      (_p, a) =>
        new Promise(
          (r) =>
            (release = () => r({ path: `${a.root.container}/x`, branch: "x" }))
        )
    );
    const first = hub.checkouts.createWorktree(project.id, { branch: "x" });
    expect(() =>
      hub.checkouts.createWorktree(project.id, { branch: "y" })
    ).toThrow(BusyError);
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await first;
  });

  it("only removes, opens and starts sessions in the workspace or known worktrees", async () => {
    const { store, worktrees, editors, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    store.updateRuntime(project.id, { worktrees: [known] });
    await expect(
      hub.checkouts.removeWorktree(project.id, "/etc", true)
    ).rejects.toThrow(InvalidRequestError);
    await expect(hub.sessions.startSession(project.id, "/tmp")).rejects.toThrow(
      InvalidRequestError
    );
    expect(() =>
      hub.checkouts.openInEditor(project.id, "zed", "/home")
    ).toThrow(InvalidRequestError);

    await hub.checkouts.openInEditor(project.id, "zed", wtPath);
    expect(editors.open).toHaveBeenLastCalledWith("zed", {
      containerPath: wtPath,
      hostPath: "/src/demo.worktrees/feature-x",
      containerName: "demo_c1",
    });
    await hub.checkouts.openInEditor(project.id, "zed", "/workspaces/demo");
    expect(editors.open.mock.calls.at(-1)?.[1].hostPath).toBe("/src/demo");

    worktrees.list.mockResolvedValue([]);
    await hub.checkouts.removeWorktree(project.id, wtPath, false);
    expect(worktrees.remove).toHaveBeenCalledWith(
      project,
      "/workspaces/demo",
      wtPath,
      false
    );
    expect(store.runtime(project.id).worktrees).toStrictEqual([]);
  });

  it("opens host editors on a stopped project, without a container to attach to", async () => {
    const { store, editors, hub } = setup();
    await hub.environments.rescan();
    store.updateRuntime(project.id, {
      containerName: "demo_c1",
      worktrees: [known],
    });
    await hub.checkouts.openInEditor(project.id, "zed", wtPath);
    expect(editors.open.mock.calls[0][1]).toStrictEqual({
      containerPath: wtPath,
      hostPath: known.hostPath,
      containerName: undefined,
    });
  });

  it("watches worktree directories and refreshes when a session shows up in an unknown one", async () => {
    const { store, worktrees, monitors, hub } = setup();
    await hub.environments.rescan();
    await hub.environments.start(project.id);
    store.updateRuntime(project.id, { worktrees: [known] });
    expect(monitors[0].opts.extraDirectories?.()).toStrictEqual([wtPath]);
    const calls = worktrees.list.mock.calls.length;
    const session = (directory: string) => ({
      id: directory,
      projectId: project.id,
      title: "t",
      directory,
      updatedAt: 1,
      status: "idle" as const,
    });
    monitors[0].opts.onSessions([session("/workspaces/demo"), session(wtPath)]);
    expect(worktrees.list).toHaveBeenCalledTimes(calls);
    monitors[0].opts.onSessions([
      session("/home/node/.local/share/opencode/worktree/p/y"),
    ]);
    await vi.waitFor(() =>
      expect(worktrees.list).toHaveBeenCalledTimes(calls + 1)
    );
    monitors[0].opts.onSessions([
      session("/home/node/.local/share/opencode/worktree/p/y"),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    expect(worktrees.list).toHaveBeenCalledTimes(calls + 1);
  });
});
