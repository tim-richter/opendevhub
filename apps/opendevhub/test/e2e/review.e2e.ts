import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Containers } from "../../src/server/containers";
import { EditorLauncher } from "../../src/server/editors";
import { spawnRunner } from "../../src/server/exec";
import { Gateway } from "../../src/server/gateway";
import { GitOps } from "../../src/server/git";
import { projectId } from "../../src/server/ids";
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

describe.skipIf(!process.env.OPENDEVHUB_E2E)(
  "e2e: review and local git in a real container",
  () => {
    it("diffs a worktree, commits, updates from base, merges, and aborts a conflicting update", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-review-"));
      const repo = path.join(tmp, "review-demo");
      fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
      fs.copyFileSync(
        path.resolve("test/e2e/fixture/.devcontainer/devcontainer.json"),
        path.join(repo, ".devcontainer/devcontainer.json")
      );
      const hostGit = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
      hostGit("init", "-q", "-b", "main");
      // Repo-local identity: seen by git in the container too, without relying on a global config there.
      hostGit("config", "user.name", "e2e");
      hostGit("config", "user.email", "e2e@example.com");
      fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
      hostGit("add", "-A");
      hostGit("commit", "-q", "-m", "init");

      const project: Project = {
        id: projectId(repo),
        name: "review-demo",
        path: repo,
        devcontainerPath: path.join(repo, ".devcontainer/devcontainer.json"),
      };
      const store = new StateStore({
        port: 0,
        persisted: { projects: {} },
        persist: () => {},
      });
      const containers = new Containers(spawnRunner);
      const clientFor = (ep: { baseUrl: string; password: string }) =>
        new OpencodeClient(ep);
      const runtime = new OpencodeRuntime({ containers, clientFor });
      const network = new Network({
        mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE),
        gateway: new Gateway({ run: spawnRunner }),
      });
      const orch = new Orchestrator({
        store,
        containers,
        runtime,
        forwarder: new PortForwarder(),
        relay: new RelayRuntime({ containers }),
        network,
        worktrees: new Worktrees({ containers, run: spawnRunner }),
        git: new GitOps({ containers }),
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
      orch.onLog((_id, line) => console.log(`[e2e review] ${line}`));

      try {
        await orch.rescan();
        await orch.start(project.id);
        expect(store.runtime(project.id)).toMatchObject({
          containerState: "running",
          opencode: "healthy",
        });

        const { worktree } = await orch.createWorktree(project.id, {
          branch: "feature/x",
        });
        expect(worktree.hostPath).toBeDefined();
        fs.writeFileSync(path.join(worktree.hostPath!, "b.txt"), "new file\n");

        let r = await orch.review(project.id, worktree.path, {
          mode: "branch",
        });
        expect(r).toMatchObject({
          branch: "feature/x",
          base: { name: "main", source: "config" },
          mode: "branch",
          dirty: true,
          ahead: 0,
          behind: 0,
        });
        expect(r.files.map((f) => f.file)).toContain("b.txt");

        await orch.commit(project.id, worktree.path, "feat: add b");
        r = await orch.review(project.id, worktree.path);
        expect(r).toMatchObject({ dirty: false, ahead: 1, behind: 0 });

        fs.writeFileSync(path.join(repo, "c.txt"), "on main\n");
        hostGit("add", "-A");
        hostGit("commit", "-q", "-m", "main: add c");
        expect((await orch.review(project.id, worktree.path)).behind).toBe(1);
        expect(
          await orch.updateFromBase(project.id, worktree.path, "main")
        ).toEqual({ strategy: "rebase" });
        expect(await orch.review(project.id, worktree.path)).toMatchObject({
          ahead: 1,
          behind: 0,
        });

        expect(
          await orch.mergeIntoBase(project.id, worktree.path, "main", false)
        ).toEqual({ branch: "feature/x" });
        expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true);
        expect(hostGit("log", "-1", "--format=%s").trim()).toMatch(
          /^Merge branch 'feature\/x'/u
        );
        await orch.removeWorktree(project.id, worktree.path, false, true);
        expect(hostGit("branch", "--list", "feature/x").trim()).toBe("");

        const { worktree: y } = await orch.createWorktree(project.id, {
          branch: "feature/y",
        });
        fs.writeFileSync(
          path.join(y.hostPath!, "a.txt"),
          "one\nTWO from y\nthree\n"
        );
        await orch.commit(project.id, y.path, "feat: change two");
        fs.writeFileSync(
          path.join(repo, "a.txt"),
          "one\nTWO from main\nthree\n"
        );
        hostGit("commit", "-q", "-am", "main: change two");
        expect(await orch.updateFromBase(project.id, y.path, "main")).toEqual({
          strategy: "rebase",
          conflicts: ["a.txt"],
        });
        expect(await orch.review(project.id, y.path)).toMatchObject({
          ahead: 1,
          behind: 1,
          dirty: false,
        });
      } finally {
        await orch.stop(project.id).catch(() => undefined);
        await orch.shutdown();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
);
