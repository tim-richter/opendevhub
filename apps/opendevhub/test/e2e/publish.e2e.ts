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

describe.skipIf(!process.env.OPENDEVHUB_E2E)("e2e: publish to a bare repo", () => {
  it("pushes the main checkout's feature branch from the host and records it", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-publish-"));
    const repo = path.join(tmp, "publish-demo");
    const bare = path.join(tmp, "origin.git");
    fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
    fs.copyFileSync(path.resolve("test/e2e/fixture/.devcontainer/devcontainer.json"), path.join(repo, ".devcontainer/devcontainer.json"));
    const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "e2e");
    git(repo, "config", "user.email", "e2e@example.com");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", "feature/pub");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: b");

    const project: Project = {
      id: projectId(repo),
      name: "publish-demo",
      path: repo,
      devcontainerPath: path.join(repo, ".devcontainer/devcontainer.json"),
    };
    const store = new StateStore({ port: 0, persisted: { projects: {} }, persist: () => {} });
    const containers = new Containers(spawnRunner);
    const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
    const runtime = new OpencodeRuntime({ containers, clientFor });
    const network = new Network({ mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE), gateway: new Gateway({ run: spawnRunner }) });
    const orch = new Orchestrator({
      store,
      containers,
      runtime,
      forwarder: new PortForwarder(),
      relay: new RelayRuntime({ containers }),
      network,
      worktrees: new Worktrees({ containers, run: spawnRunner }),
      git: new GitOps({ containers }),
      publisher: new Publisher({ containers, run: spawnRunner, forges: { all: () => ({}), remember: () => {} } }),
      editors: new EditorLauncher([]),
      clientFor,
      roots: () => [],
      scan: async () => [project],
    });
    orch.onLog((_id, line) => console.log(`[e2e publish] ${line}`));

    try {
      await orch.rescan();
      await orch.start(project.id);
      const ws = store.runtime(project.id).workspaceFolder!;
      const info = await orch.publishInfo(project.id, ws);
      expect(info).toMatchObject({ branch: "feature/pub", remotes: ["origin"], remote: "origin", forge: { kind: "unknown" }, strategy: "branch", pushFrom: "host" });
      const result = await orch.publish(project.id, ws, { remote: "origin", base: "main", strategy: "branch", title: "Add b", description: "" });
      expect(result).toMatchObject({ strategy: "branch", pushedFrom: "host" });
      expect(git(bare, "rev-parse", "refs/heads/feature/pub").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
      expect(git(repo, "config", "branch.feature/pub.opendevhubPublished").trim()).toBe("origin");
      expect((await orch.review(project.id, ws)).pushed).toBe(true);
    } finally {
      await orch.stop(project.id).catch(() => {});
      await orch.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
