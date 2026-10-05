import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

const PROMPT = "Reply with the word ok. Do not change any files.";

describe.skipIf(!process.env.OPENDEVHUB_E2E)("e2e: tasks in a real container", () => {
  it("starts a task in a new worktree with a tagged session, then compares two variants and picks one", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-tasks-"));
    const repo = path.join(tmp, "tasks-demo");
    fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
    fs.copyFileSync(path.resolve("test/e2e/fixture/.devcontainer/devcontainer.json"), path.join(repo, ".devcontainer/devcontainer.json"));
    const hostGit = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    hostGit("init", "-q", "-b", "main");
    hostGit("config", "user.name", "e2e");
    hostGit("config", "user.email", "e2e@example.com");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    hostGit("add", "-A");
    hostGit("commit", "-q", "-m", "init");

    const project: Project = {
      id: projectId(repo),
      name: "tasks-demo",
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
    orch.onLog((_id, line) => console.log(`[e2e tasks] ${line}`));
    const sessionOf = (id: string | undefined) => store.sessionsOf(project.id).find((s) => s.id === id);

    try {
      await orch.rescan();
      await orch.start(project.id);
      expect(store.runtime(project.id)).toMatchObject({ containerState: "running", opencode: "healthy" });

      const info = await orch.models(project.id);
      expect(info.agents.map((a) => a.id)).toContain("build");
      expect(JSON.stringify(info)).not.toMatch(/apiKey/);

      const one = await orch.createTask(project.id, { prompt: PROMPT, title: "e2e task", variants: [{}] });
      expect(one.variants).toHaveLength(1);
      const [v] = one.variants;
      expect(v.error).toBeUndefined();
      expect(v.branch).toBe("e2e-task");
      expect(v.sessionId).toMatch(/^ses/);
      expect(hostGit("branch", "--list", "e2e-task")).toContain("e2e-task");
      expect(store.runtime(project.id).worktrees?.find((w) => w.branch === "e2e-task")?.path).toBe(v.directory);
      await vi.waitFor(
        () => expect(sessionOf(v.sessionId)?.task).toEqual({ task: one.task, variant: 1, of: 1, title: "e2e task", branch: "e2e-task" }),
        { timeout: 20_000, interval: 500 },
      );

      const two = await orch.createTask(project.id, { prompt: PROMPT, title: "e2e compare", variants: [{}, {}] });
      expect(two.variants.map((x) => x.branch)).toEqual(["e2e-compare-1", "e2e-compare-2"]);
      expect(two.variants.every((x) => x.sessionId && !x.error)).toBe(true);
      const [keep, drop] = two.variants;
      await vi.waitFor(() => expect(sessionOf(keep.sessionId) && sessionOf(drop.sessionId)).toBeTruthy(), { timeout: 20_000, interval: 500 });

      const picked = await orch.pickVariant(project.id, two.task, keep.sessionId!, true);
      expect(picked.errors).toEqual([]);
      expect(picked.discarded).toEqual([drop.sessionId]);
      expect(picked.removed).toEqual([drop.directory]);
      expect(hostGit("branch", "--list", "e2e-compare-2").trim()).toBe("");
      await vi.waitFor(() => expect(sessionOf(drop.sessionId)).toBeUndefined(), { timeout: 20_000, interval: 500 });
      expect(sessionOf(keep.sessionId)?.task).toMatchObject({ task: two.task, variant: 1, of: 2 });
    } finally {
      await orch.stop(project.id).catch(() => {});
      await orch.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
