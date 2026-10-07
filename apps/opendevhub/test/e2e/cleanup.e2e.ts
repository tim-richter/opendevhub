import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Cleanup } from "../../src/server/cleanup";
import { Containers } from "../../src/server/containers";
import { EditorLauncher } from "../../src/server/editors";
import { EnvFiles } from "../../src/server/env-files";
import { spawnRunner } from "../../src/server/exec";
import { Gateway } from "../../src/server/gateway";
import { GitOps } from "../../src/server/git";
import { projectId } from "../../src/server/ids";
import { Images } from "../../src/server/images";
import { Network, parseRouteMode } from "../../src/server/network";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime } from "../../src/server/opencode/runtime";
import { Orchestrator } from "../../src/server/orchestrator";
import { PortForwarder } from "../../src/server/port-forwarder";
import { Publisher } from "../../src/server/publish";
import { RelayRuntime } from "../../src/server/relay/runtime";
import { StateStore } from "../../src/server/state";
import { Worktrees } from "../../src/server/worktrees";
import type { Project } from "../../src/shared/types";

const devcontainer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      build: { dockerfile: "Dockerfile" },
      onCreateCommand: "echo onCreate >> /tmp/lifecycle.log",
      updateContentCommand: "echo updateContent >> /tmp/lifecycle.log",
      postCreateCommand: "echo postCreate >> /tmp/lifecycle.log",
      postStartCommand: "echo postStart >> /tmp/lifecycle.log",
      forwardPorts: [3000],
      customizations: { opendevhub: { isolation: "isolated" } },
      ...extra,
    },
    null,
    2
  );

describe.skipIf(!process.env.OPENDEVHUB_E2E)("e2e: cleanup", () => {
  it("removes a merged branch with its worktree and container, keeps unmerged work, drops a superseded image", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cleanup-"));
    const repo = path.join(tmp, "cleanup-demo");
    fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".devcontainer/Dockerfile"),
      "FROM mcr.microsoft.com/devcontainers/javascript-node:22\nRUN npm i -g @opencode/cli@2\n"
    );
    fs.writeFileSync(
      path.join(repo, ".devcontainer/devcontainer.json"),
      devcontainer()
    );
    const hostGit = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
    hostGit("init", "-q", "-b", "main");
    hostGit("config", "user.name", "e2e");
    hostGit("config", "user.email", "e2e@example.com");
    hostGit("add", "-A");
    hostGit("commit", "-q", "-m", "init");

    const project: Project = {
      id: projectId(repo),
      name: "cleanup-demo",
      path: repo,
      devcontainerPath: path.join(repo, ".devcontainer/devcontainer.json"),
    };
    const store = new StateStore({
      port: 0,
      persisted: { projects: {} },
      persist: () => {},
    });
    const containers = new Containers(spawnRunner);
    const git = new GitOps({ containers });
    const envFiles = new EnvFiles(path.join(tmp, "envs"));
    const clientFor = (ep: { baseUrl: string; password: string }) =>
      new OpencodeClient(ep);
    const runtime = new OpencodeRuntime({ containers, clientFor });
    const orch = new Orchestrator({
      store,
      containers,
      runtime,
      forwarder: new PortForwarder(),
      relay: new RelayRuntime({ containers }),
      network: new Network({
        mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE),
        gateway: new Gateway({ run: spawnRunner }),
      }),
      worktrees: new Worktrees({ containers, run: spawnRunner }),
      git,
      images: new Images({
        run: spawnRunner,
        containers,
        objects: (p, wt, paths) => git.headObjects(p, wt.path, paths),
      }),
      envFiles,
      publisher: new Publisher({
        containers,
        run: spawnRunner,
        forges: { all: () => ({}), remember: () => {} },
      }),
      editors: new EditorLauncher([]),
      clientFor,
      roots: () => [],
      scan: async () => [project],
    });
    orch.onLog((_id, line) => console.log(`[e2e cleanup] ${line}`));
    // The superseded image below is brand new, so look at it from an hour ahead.
    const cleanup = new Cleanup({
      store,
      containers,
      branches: orch,
      now: () => Date.now() + 60 * 60_000,
    });
    const oldBase = `opendevhub/${project.id}:000000000000-base`;
    try {
      await orch.rescan();
      await orch.start(project.id);
      const ws = store.runtime(project.id).workspaceFolder!;
      const inContainer = (...args: string[]) =>
        containers.exec(project, ["git", "-C", ws, ...args]);

      // merged: a worktree with its own container, its commit merged into main
      const { worktree: done } = await orch.createWorktree(project.id, {
        branch: "done",
      });
      await containers.exec(project, [
        "sh",
        "-c",
        `cd ${done.path} && echo x > done.txt && git add . && git commit -qm done`,
      ]);
      await inContainer("merge", "--ff-only", "done");
      const { envId } = await orch.createEnv(project.id, done.path);
      await vi.waitFor(
        () => expect(store.runtime(envId).opencode).toBe("healthy"),
        { timeout: 10 * 60_000, interval: 1000 }
      );
      const envContainer = store.runtime(envId).containerId!;

      // unmerged: a worktree with a commit main doesn't have
      const { worktree: wip } = await orch.createWorktree(project.id, {
        branch: "wip",
      });
      await containers.exec(project, [
        "sh",
        "-c",
        `cd ${wip.path} && echo y > wip.txt && git add . && git commit -qm wip`,
      ]);

      // superseded: an old base image of this project
      execFileSync("docker", ["build", "-q", "-t", oldBase, "-"], {
        input: `FROM scratch\nLABEL opendevhub.base-project=${project.id}\n`,
      });

      const plan = await cleanup.scan();
      const ids = plan.items.map((i) => i.id);
      expect(ids).toContain(`branch:${project.id}:done`);
      expect(ids).not.toContain(`branch:${project.id}:wip`);
      expect(ids).toContain(`image:${oldBase}`);
      expect(
        plan.items.find((i) => i.id === `branch:${project.id}:done`)
      ).toMatchObject({ checked: true, worktree: done.path, env: envId });

      const result = await cleanup.apply(
        plan.items.filter(
          (i) =>
            i.id === `branch:${project.id}:done` || i.id === `image:${oldBase}`
        )
      );
      expect(result.results.map((r) => r.outcome)).toEqual([
        "removed",
        "removed",
      ]);
      expect(store.environment(envId)).toBeUndefined();
      expect(await containers.inspect(envContainer)).toBeUndefined();
      expect(fs.existsSync(done.hostPath!)).toBe(false);
      expect(
        (
          await inContainer(
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/done"
          )
        ).exitCode
      ).not.toBe(0);
      expect(
        (await inContainer("show-ref", "--verify", "--quiet", "refs/heads/wip"))
          .exitCode
      ).toBe(0);
      expect(await containers.imageExists(oldBase)).toBe(false);

      // A session in a worktree that's since been removed is offered checked, and goes on apply.
      const client = () =>
        clientFor(
          runtime.endpoint(
            orch.opencodeAddress(project.id)!,
            store.runtime(project.id).password!
          )
        );
      const orphaned = await orch.startSession(
        project.id,
        wip.path,
        "wip notes"
      );
      await orch.removeWorktree(project.id, wip.path, true);
      const sessionPlan = await cleanup.scan();
      expect(
        sessionPlan.items.find(
          (i) => i.id === `session:${project.id}:${orphaned}`
        )
      ).toMatchObject({ checked: true, why: "worktree-gone" });
      const sessionResult = await cleanup.apply(
        sessionPlan.items.filter(
          (i) => i.id === `session:${project.id}:${orphaned}`
        )
      );
      expect(sessionResult.results).toEqual([
        { id: `session:${project.id}:${orphaned}`, outcome: "removed" },
      ]);
      expect((await client().sessions()).map((s) => s.id)).not.toContain(
        orphaned
      );

      // The per-row button: removes a session the dashboard lists.
      const listed = await orch.startSession(project.id, ws, "scratch");
      await vi.waitFor(
        () =>
          expect(store.sessionsOf(project.id).map((s) => s.id)).toContain(
            listed
          ),
        { timeout: 30_000, interval: 500 }
      );
      await orch.removeSession(project.id, listed);
      expect((await client().sessions()).map((s) => s.id)).not.toContain(
        listed
      );
    } finally {
      for (const e of store.environments(project.id)) {
        await orch.removeEnv(project.id, e.id).catch(() => undefined);
      }
      await orch.stop(project.id).catch(() => undefined);
      await orch.shutdown();
      const images = execFileSync(
        "docker",
        ["images", "-q", `opendevhub/${project.id}`],
        { encoding: "utf-8" }
      )
        .split(/\s+/u)
        .filter(Boolean);
      if (images.length > 0) {
        execFileSync("docker", ["image", "rm", "-f", ...images]);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
