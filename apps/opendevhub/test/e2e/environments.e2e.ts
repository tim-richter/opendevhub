import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Containers, envLabels } from "../../src/server/containers";
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

const PROMPT = "Reply with the word ok. Do not change any files.";
const LIFECYCLE = ["onCreate", "updateContent", "postCreate", "postStart"];

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
    2,
  );

describe.skipIf(!process.env.OPENDEVHUB_E2E)("e2e: per-task environments", () => {
  it("runs isolated tasks side by side, each in its own container with its own ports", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-envs-"));
    const repo = path.join(tmp, "envs-demo");
    fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".devcontainer/Dockerfile"),
      "FROM mcr.microsoft.com/devcontainers/javascript-node:22\nRUN npm i -g @opencode/cli@2\n",
    );
    fs.writeFileSync(path.join(repo, ".devcontainer/devcontainer.json"), devcontainer());
    const hostGit = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    hostGit("init", "-q", "-b", "main");
    hostGit("config", "user.name", "e2e");
    hostGit("config", "user.email", "e2e@example.com");
    hostGit("add", "-A");
    hostGit("commit", "-q", "-m", "init");

    const project: Project = { id: projectId(repo), name: "envs-demo", path: repo, devcontainerPath: path.join(repo, ".devcontainer/devcontainer.json") };
    const store = new StateStore({ port: 0, persisted: { projects: {} }, persist: () => {} });
    const containers = new Containers(spawnRunner);
    const git = new GitOps({ containers });
    const envFiles = new EnvFiles(path.join(tmp, "envs"));
    const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
    const runtime = new OpencodeRuntime({ containers, clientFor });
    const orch = new Orchestrator({
      store,
      containers,
      runtime,
      forwarder: new PortForwarder(),
      relay: new RelayRuntime({ containers }),
      network: new Network({ mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE), gateway: new Gateway({ run: spawnRunner }) }),
      worktrees: new Worktrees({ containers, run: spawnRunner }),
      git,
      images: new Images({ run: spawnRunner, containers, git }),
      envFiles,
      publisher: new Publisher({ containers, run: spawnRunner, forges: { all: () => ({}), remember: () => {} } }),
      editors: new EditorLauncher([]),
      clientFor,
      roots: () => [],
      scan: async () => [project],
    });
    orch.onLog((_id, line) => console.log(`[e2e envs] ${line}`));
    const targetOf = (envId: string) => {
      const rec = store.environment(envId)!;
      return { id: envId, path: rec.worktree.hostPath, idLabels: envLabels(envId, project.id), overrideConfig: envFiles.path(envId) };
    };
    const lifecycle = async (envId: string) =>
      (await containers.exec(targetOf(envId), ["cat", "/tmp/lifecycle.log"])).stdout.split("\n").filter(Boolean);

    try {
      await orch.rescan();
      await orch.start(project.id);
      expect(store.runtime(project.id)).toMatchObject({ containerState: "running", opencode: "healthy" });
      expect(store.snapshot().projects[0].isolation).toEqual({ default: "isolated" });
      const mainContainer = store.runtime(project.id).containerId;
      const mainLog = (await containers.exec(project, ["cat", "/tmp/lifecycle.log"])).stdout;

      const two = await orch.createTask(project.id, { prompt: PROMPT, title: "e2e iso", variants: [{}, {}] });
      expect(two.variants.map((v) => v.error)).toEqual([undefined, undefined]);
      const envIds = two.variants.map((v) => v.envId!);
      expect(new Set(envIds).size).toBe(2);
      for (const id of envIds) {
        expect(store.runtime(id)).toMatchObject({ containerState: "running", opencode: "healthy" });
        // image mode: every lifecycle command, once, in the task's own container
        expect(await lifecycle(id)).toEqual(LIFECYCLE);
      }
      expect(new Set(envIds.map((id) => store.environment(id)!.image!.ref)).size).toBe(1);
      await vi.waitFor(
        () => expect(envIds.every((id) => store.sessionsOf(project.id).some((s) => s.envId === id))).toBe(true),
        { timeout: 30_000, interval: 500 },
      );

      // Both serve their own port 3000, on different host ports.
      const hostPorts: number[] = [];
      for (const id of envIds) {
        await containers.exec(targetOf(id), [
          "sh",
          "-c",
          `nohup node -e "require('http').createServer((q, r) => r.end('${id}')).listen(3000, '127.0.0.1')" < /dev/null > /tmp/web.log 2>&1 &`,
        ]);
        const fwd = store.runtime(id).ports?.find((p) => p.status === "forwarded" && p.containerPort === 3000);
        expect(fwd?.status).toBe("forwarded");
        hostPorts.push(fwd?.status === "forwarded" ? fwd.hostPort : 0);
      }
      expect(hostPorts[0]).not.toBe(hostPorts[1]);
      for (const [i, id] of envIds.entries()) {
        await vi.waitFor(async () => expect(await (await fetch(`http://127.0.0.1:${hostPorts[i]}/`)).text()).toBe(id), {
          timeout: 15_000,
          interval: 500,
        });
      }

      // A branch that changes .devcontainer gets its own image.
      const { worktree } = await orch.createWorktree(project.id, { branch: "devc" });
      fs.writeFileSync(path.join(worktree.hostPath!, ".devcontainer/devcontainer.json"), devcontainer({ containerEnv: { E2E: "1" } }));
      await containers.exec(project, ["git", "-C", worktree.path, "commit", "-qam", "change the devcontainer"]);
      const { envId: devc } = await orch.createEnv(project.id, worktree.path);
      await vi.waitFor(() => expect(store.runtime(devc).opencode).toBe("healthy"), { timeout: 10 * 60_000, interval: 1000 });
      expect(store.environment(devc)!.image!.ref).not.toBe(store.environment(envIds[0])!.image!.ref);

      // A warm environment (image already built) starts in under 10 s.
      const { worktree: warm } = await orch.createWorktree(project.id, { branch: "warm" });
      const t0 = Date.now();
      const { envId: warmId } = await orch.createEnv(project.id, warm.path);
      await vi.waitFor(() => expect(store.runtime(warmId).opencode).toBe("healthy"), { timeout: 60_000, interval: 200 });
      expect(Date.now() - t0).toBeLessThan(10_000);

      // Picking one variant removes the other's container with its worktree.
      const [keep, drop] = two.variants;
      const dropContainer = store.runtime(drop.envId!).containerId!;
      const picked = await orch.pickVariant(project.id, two.task, keep.sessionId!, true);
      expect(picked.errors).toEqual([]);
      expect(picked.removed).toEqual([drop.directory]);
      expect(store.environment(drop.envId!)).toBeUndefined();
      expect(await containers.inspect(dropContainer)).toBeUndefined();

      // The main environment was never touched.
      expect(store.runtime(project.id).containerId).toBe(mainContainer);
      expect((await containers.exec(project, ["cat", "/tmp/lifecycle.log"])).stdout).toBe(mainLog);
    } finally {
      for (const e of store.environments(project.id)) await orch.removeEnv(project.id, e.id).catch(() => {});
      await orch.stop(project.id).catch(() => {});
      await orch.shutdown();
      const images = execFileSync("docker", ["images", "-q", `opendevhub/${project.id}`], { encoding: "utf8" }).split(/\s+/).filter(Boolean);
      if (images.length > 0) execFileSync("docker", ["image", "rm", "-f", ...images]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
