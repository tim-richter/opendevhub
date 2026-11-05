import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "../../../src/server/errors";
import {
  feat,
  featEnv,
  project,
  remoteEnv,
  remoteFix,
  setup,
  withEnv,
  withRemote,
  withWorktree,
} from "../../helpers/hub";
import { worktreeRow } from "../../helpers/stores";

describe("cli targets", () => {
  it("maps a folder of the project to the main environment's matching container folder", async () => {
    const s = await withWorktree();
    await expect(
      s.hub.environments.cliTarget("/src/demo/packages/ui")
    ).resolves.toMatchObject({
      envId: project.id,
      exec: {
        containerId: "c1",
        directory: "/workspaces/demo/packages/ui",
        root: "/workspaces/demo",
      },
      main: true,
      projectId: project.id,
      state: "running",
    });
    await expect(
      s.hub.environments.cliTarget("/src/demo")
    ).resolves.toMatchObject({ exec: { directory: "/workspaces/demo" } });
  });

  it("maps a worktree without its own container into the main container", async () => {
    const s = await withWorktree();
    await expect(
      s.hub.environments.cliTarget(`${feat.hostPath}/src`)
    ).resolves.toMatchObject({
      envId: project.id,
      exec: {
        containerId: "c1",
        directory: `${feat.path}/src`,
        root: feat.path,
      },
    });
  });

  it("maps a task's worktree to the task's own environment", async () => {
    const s = await withEnv();
    await expect(
      s.hub.environments.cliTarget(`${feat.hostPath}/src`)
    ).resolves.toMatchObject({
      branch: "feat",
      envId: featEnv,
      exec: { containerId: "c2", directory: `${feat.path}/src` },
      main: false,
    });
  });

  it("refuses folders outside every project", async () => {
    const s = await withWorktree();
    await expect(s.hub.environments.cliTarget("/elsewhere")).rejects.toThrow(
      /add the project in the dashboard/u
    );
    await expect(
      s.hub.environments.cliTarget("/src/demo-other")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("leaves out how to get in while the environment is stopped", async () => {
    const s = setup();
    await s.hub.environments.rescan();
    const target = await s.hub.environments.cliTarget("/src/demo");
    expect(target).toMatchObject({ envId: project.id, state: "stopped" });
    expect(target.exec).toBeUndefined();
  });

  it("selects an environment by id or branch, at its checkout's root", async () => {
    const s = await withEnv();
    await expect(
      s.hub.environments.cliTarget("/src/demo/packages", "feat")
    ).resolves.toMatchObject({
      envId: featEnv,
      exec: { directory: feat.path, root: feat.path },
    });
    await expect(
      s.hub.environments.cliTarget("/src/demo", featEnv)
    ).resolves.toMatchObject({ envId: featEnv });
    await expect(
      s.hub.environments.cliTarget(feat.hostPath, project.id)
    ).resolves.toMatchObject({
      envId: project.id,
      exec: { directory: "/workspaces/demo" },
    });
  });

  it("lists the candidates when a name matches none or several", async () => {
    const s = await withEnv();
    await expect(
      s.hub.environments.cliTarget("/src/demo", "nope")
    ).rejects.toThrow(new RegExp(`feat\\t${featEnv}`, "u"));
    const twin = {
      ...feat,
      path: "/workspaces/demo.worktrees/feat-2",
      hostPath: "/src/demo.worktrees/feat-2",
    };
    s.store.putEnvironment({
      id: "twin",
      projectId: project.id,
      worktree: twin,
      worktreeId: worktreeRow(s.dbs, project.id, twin),
    });
    const ambiguous = s.hub.environments.cliTarget("/src/demo", "feat");
    await expect(ambiguous).rejects.toBeInstanceOf(ConflictError);
    await expect(ambiguous).rejects.toThrow(/twin/u);
  });

  it("selects a remote environment only by name", async () => {
    const s = await withRemote();
    await expect(
      s.hub.environments.cliTarget(remoteFix.hostPath)
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.hub.environments.cliTarget("/src/demo", "fix")
    ).resolves.toMatchObject({
      envId: remoteEnv,
      node: "box",
      state: "stopped",
    });
  });

  it("lists a project's environments, main first", async () => {
    const s = await withRemote();
    await expect(s.hub.environments.cliEnvs("/src/demo/sub")).resolves.toEqual({
      envs: [
        expect.objectContaining({
          envId: project.id,
          main: true,
          state: "running",
        }),
        expect.objectContaining({
          branch: "fix",
          envId: remoteEnv,
          node: "box",
          state: "stopped",
        }),
      ],
      projectId: project.id,
      projectName: project.name,
    });
  });

  it("names the main environment by the branch its folder has out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-"));
    try {
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(
        path.join(dir, ".git", "HEAD"),
        "ref: refs/heads/trunk\n"
      );
      const s = setup();
      s.store.setProjects([{ ...project, path: dir }]);
      await expect(
        s.hub.environments.cliTarget(dir, "trunk")
      ).resolves.toMatchObject({
        branch: "trunk",
        envId: project.id,
        main: true,
      });
      fs.writeFileSync(path.join(dir, ".git", "HEAD"), "0123abcd\n");
      await expect(s.hub.environments.cliEnvs(dir)).resolves.toMatchObject({
        envs: [expect.not.objectContaining({ branch: expect.anything() })],
      });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});
