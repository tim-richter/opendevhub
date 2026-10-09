import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FileProjectSettings } from "../../src/server/config";
import { createDashboardApp } from "../../src/server/dashboard-api";
import { Checks } from "../../src/server/environments/checks";
import { Containers } from "../../src/server/environments/containers";
import { Credentials } from "../../src/server/environments/credentials";
import { EditorLauncher } from "../../src/server/environments/editors";
import { Cleanup } from "../../src/server/git/cleanup";
import { GitOps } from "../../src/server/git/ops";
import { Publisher } from "../../src/server/git/publish";
import { Worktrees } from "../../src/server/git/worktrees";
import { createHub } from "../../src/server/hub";
import { Gateway } from "../../src/server/network/gateway";
import { PortForwarder } from "../../src/server/network/port-forwarder";
import { RelayRuntime } from "../../src/server/network/relay/runtime";
import { Network, parseRouteMode } from "../../src/server/network/routes";
import { spawnRunner } from "../../src/server/nodes/exec";
import { Push } from "../../src/server/notifications/push";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime } from "../../src/server/opencode/runtime";
import { scanRoots } from "../../src/server/projects/discovery";
import { Onboarding } from "../../src/server/projects/onboarding";
import { StateStore } from "../../src/server/projects/state";

describe.skipIf(!process.env.OPENDEVHUB_E2E)(
  "e2e: add a repo without a devcontainer",
  () => {
    it("lists it, writes the template, and the project starts with opencode v2", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-e2e-add-"));
      const repo = path.join(root, "hello");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      fs.writeFileSync(path.join(repo, "package.json"), "{}\n");

      const roots = () => [root];
      const store = new StateStore({
        port: 0,
        persisted: { projects: {} },
        persist: () => {},
      });
      const containers = new Containers(spawnRunner);
      const clientFor = (ep: { baseUrl: string; password: string }) =>
        new OpencodeClient(ep);
      const hub = createHub({
        store,
        containers,
        runtime: new OpencodeRuntime({ containers, clientFor }),
        forwarder: new PortForwarder(),
        relay: new RelayRuntime({ containers }),
        network: new Network({
          mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE),
          gateway: new Gateway({ run: spawnRunner }),
        }),
        worktrees: new Worktrees({ containers, run: spawnRunner }),
        git: new GitOps({ containers }),
        publisher: new Publisher({
          containers,
          run: spawnRunner,
          forges: { all: () => ({}), remember: () => {} },
        }),
        editors: new EditorLauncher([]),
        credentials: new Credentials({ run: spawnRunner, containers }),
        clientFor,
        roots,
        scan: (r) => scanRoots(r),
      });
      hub.environments.onLog((_id, line) => console.log(`[e2e add] ${line}`));
      const app = createDashboardApp({
        store,
        hub,
        cleanup: new Cleanup({
          store,
          containers,
          branches: hub.cleanupTargets,
          log: (id, line) => hub.environments.note(id, line),
        }),
        checks: new Checks({
          target: (id, dir) => hub.checkouts.checkTarget(id, dir),
          project: (id) => store.project(id),
          containers,
          run: spawnRunner,
          git: new GitOps({ containers }),
          settings: new FileProjectSettings(root),
          log: (id, line) => hub.environments.note(id, line),
        }),
        onboarding: new Onboarding({ roots }),
        push: new Push({ file: path.join(root, "push.json") }),
      });

      let projectId = "";
      try {
        const list = await (
          await app.request("/api/onboarding/candidates")
        ).json();
        expect(list.candidates).toEqual([
          { path: repo, name: "hello", root, stack: "node" },
        ]);

        const res = await app.request("/api/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: repo, stack: "node" }),
        });
        expect(res.status).toBe(200);
        const result = await res.json();
        expect(result.started).toBe(true);
        projectId = result.projectId;
        expect(
          fs.existsSync(path.join(repo, ".devcontainer", "devcontainer.json"))
        ).toBe(true);

        await vi.waitFor(
          () =>
            expect(store.runtime(projectId)).toMatchObject({
              containerState: "running",
              opencode: "healthy",
            }),
          { timeout: 15 * 60_000, interval: 2000 }
        );
        expect(store.runtime(projectId).opencodeVersion).toMatch(/^2\./u);
      } finally {
        if (projectId) {
          await hub.environments.stop(projectId).catch(() => undefined);
          const id = execFileSync("docker", [
            "ps",
            "-aq",
            "--filter",
            `label=devcontainer.local_folder=${repo}`,
          ])
            .toString()
            .trim();
          if (id) {
            execFileSync("docker", ["rm", "-f", ...id.split("\n")]);
          }
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
);
