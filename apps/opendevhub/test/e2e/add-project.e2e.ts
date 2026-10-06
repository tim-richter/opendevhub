import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Containers } from "../../src/server/containers";
import { Credentials } from "../../src/server/credentials";
import { Cleanup } from "../../src/server/cleanup";
import { createDashboardApp } from "../../src/server/dashboard-api";
import { scanRoots } from "../../src/server/discovery";
import { EditorLauncher } from "../../src/server/editors";
import { spawnRunner } from "../../src/server/exec";
import { Gateway } from "../../src/server/gateway";
import { GitOps } from "../../src/server/git";
import { Network, parseRouteMode } from "../../src/server/network";
import { Onboarding } from "../../src/server/onboarding";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime } from "../../src/server/opencode/runtime";
import { Orchestrator } from "../../src/server/orchestrator";
import { PortForwarder } from "../../src/server/port-forwarder";
import { Publisher } from "../../src/server/publish";
import { Push } from "../../src/server/push";
import { RelayRuntime } from "../../src/server/relay/runtime";
import { StateStore } from "../../src/server/state";
import { Worktrees } from "../../src/server/worktrees";

describe.skipIf(!process.env.OPENDEVHUB_E2E)("e2e: add a repo without a devcontainer", () => {
  it("lists it, writes the template, and the project starts with opencode v2", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-e2e-add-"));
    const repo = path.join(root, "hello");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    fs.writeFileSync(path.join(repo, "package.json"), "{}\n");

    const roots = () => [root];
    const store = new StateStore({ port: 0, persisted: { projects: {} }, persist: () => {} });
    const containers = new Containers(spawnRunner);
    const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
    const orch = new Orchestrator({
      store,
      containers,
      runtime: new OpencodeRuntime({ containers, clientFor }),
      forwarder: new PortForwarder(),
      relay: new RelayRuntime({ containers }),
      network: new Network({ mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE), gateway: new Gateway({ run: spawnRunner }) }),
      worktrees: new Worktrees({ containers, run: spawnRunner }),
      git: new GitOps({ containers }),
      publisher: new Publisher({ containers, run: spawnRunner, forges: { all: () => ({}), remember: () => {} } }),
      editors: new EditorLauncher([]),
      credentials: new Credentials({ run: spawnRunner, containers }),
      clientFor,
      roots,
      scan: (r) => scanRoots(r),
    });
    orch.onLog((_id, line) => console.log(`[e2e add] ${line}`));
    const app = createDashboardApp({
      store,
      orchestrator: orch,
      cleanup: new Cleanup({ store, containers, branches: orch }),
      onboarding: new Onboarding({ roots }),
      push: new Push({ file: path.join(root, "push.json") }),
    });

    let projectId = "";
    try {
      const list = await (await app.request("/api/onboarding/candidates")).json();
      expect(list.candidates).toEqual([{ path: repo, name: "hello", root, stack: "node" }]);

      const res = await app.request("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repo, stack: "node" }),
      });
      expect(res.status).toBe(200);
      const result = await res.json();
      expect(result.started).toBe(true);
      projectId = result.projectId;
      expect(fs.existsSync(path.join(repo, ".devcontainer", "devcontainer.json"))).toBe(true);

      await vi.waitFor(
        () => expect(store.runtime(projectId)).toMatchObject({ containerState: "running", opencode: "healthy" }),
        { timeout: 15 * 60_000, interval: 2000 },
      );
      expect(store.runtime(projectId).opencodeVersion).toMatch(/^2\./);
    } finally {
      if (projectId) {
        await orch.stop(projectId).catch(() => {});
        const id = execFileSync("docker", ["ps", "-aq", "--filter", `label=devcontainer.local_folder=${repo}`]).toString().trim();
        if (id) execFileSync("docker", ["rm", "-f", ...id.split("\n")]);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
