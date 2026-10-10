import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Containers } from "../../src/server/environments/containers";
import { EditorLauncher } from "../../src/server/environments/editors";
import { GitOps } from "../../src/server/git/ops";
import { Publisher } from "../../src/server/git/publish";
import { Worktrees } from "../../src/server/git/worktrees";
import { createHub } from "../../src/server/hub";
import { Gateway } from "../../src/server/network/gateway";
import { PortForwarder } from "../../src/server/network/port-forwarder";
import { RelayRuntime } from "../../src/server/network/relay/runtime";
import { Network, parseRouteMode } from "../../src/server/network/routes";
import { spawnRunner } from "../../src/server/nodes/exec";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime } from "../../src/server/opencode/runtime";
import { projectId } from "../../src/server/projects/ids";
import { StateStore } from "../../src/server/projects/state";
import type { Project } from "../../src/shared/types";
import { memoryStores } from "../helpers/stores";

const PROMPT = "Reply with the word ok. Do not change any files.";

describe.skipIf(!process.env.OPENDEVHUB_E2E)(
  "e2e: tasks in a real container",
  () => {
    it("starts a task in a new worktree with a recorded session, then compares two variants and picks one", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-tasks-"));
      const repo = path.join(tmp, "tasks-demo");
      fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
      fs.copyFileSync(
        path.resolve("test/e2e/fixture/.devcontainer/devcontainer.json"),
        path.join(repo, ".devcontainer/devcontainer.json")
      );
      const hostGit = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
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
      const dbs = memoryStores();
      const store = new StateStore({
        tasks: dbs.tasks,
        checkouts: dbs.checkouts,
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
      const hub = createHub({
        store,
        projects: dbs.projects,
        tasks: dbs.tasks,
        checkouts: dbs.checkouts,
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
      hub.environments.onLog((_id, line) => console.log(`[e2e tasks] ${line}`));
      const sessionOf = (id: string | undefined) =>
        store.sessionsOf(project.id).find((s) => s.id === id);

      try {
        await hub.environments.rescan();
        await hub.environments.start(project.id);
        expect(store.runtime(project.id)).toMatchObject({
          containerState: "running",
          opencode: "healthy",
        });

        const info = await hub.sessions.models(project.id);
        expect(info.agents.map((a) => a.id)).toContain("build");
        expect(JSON.stringify(info)).not.toMatch(/apiKey/u);

        const one = await hub.tasks.createTask(project.id, {
          prompt: PROMPT,
          title: "e2e task",
          variants: [{}],
        });
        expect(one.variants).toHaveLength(1);
        const [v] = one.variants;
        expect(v.error).toBeUndefined();
        expect(v.branch).toBe("e2e-task");
        expect(v.sessionId).toMatch(/^ses/u);
        expect(hostGit("branch", "--list", "e2e-task")).toContain("e2e-task");
        expect(
          store
            .runtime(project.id)
            .worktrees?.find((w) => w.branch === "e2e-task")?.path
        ).toBe(v.directory);
        await vi.waitFor(
          () =>
            expect(sessionOf(v.sessionId)?.task).toEqual({
              discarded: false,
              id: one.task,
              kind: "task",
              n: 1,
            }),
          { timeout: 20_000, interval: 500 }
        );
        expect(dbs.tasks.get(one.task)).toMatchObject({
          state: "running",
          title: "e2e task",
          variants: [{ branch: "e2e-task", directory: v.directory, n: 1 }],
        });
        // The session itself carries no task metadata.
        const created = await hub.environments
          .opencodeClient(project.id)
          .session(v.sessionId!);
        expect(created.metadata?.opendevhub).toBeUndefined();

        const two = await hub.tasks.createTask(project.id, {
          prompt: PROMPT,
          title: "e2e compare",
          variants: [{}, {}],
        });
        expect(two.variants.map((x) => x.branch)).toEqual([
          "e2e-compare-1",
          "e2e-compare-2",
        ]);
        expect(two.variants.every((x) => x.sessionId && !x.error)).toBe(true);
        const [keep, drop] = two.variants;
        await vi.waitFor(
          () =>
            expect(
              sessionOf(keep.sessionId) && sessionOf(drop.sessionId)
            ).toBeTruthy(),
          { timeout: 20_000, interval: 500 }
        );

        const picked = await hub.tasks.pickVariant(
          project.id,
          two.task,
          keep.sessionId!,
          true
        );
        expect(picked.errors).toEqual([]);
        expect(picked.discarded).toEqual([drop.sessionId]);
        expect(picked.removed).toEqual([drop.directory]);
        expect(hostGit("branch", "--list", "e2e-compare-2").trim()).toBe("");
        expect(dbs.checkouts.branch(project.id, "e2e-compare-2")).toMatchObject(
          {
            createdBy: { by: "variant", n: 2, task: two.task },
            deletedAt: expect.any(Number),
          }
        );
        expect(
          dbs.checkouts
            .worktreeHistory(project.id)
            .filter((w) => w.path === drop.directory)
            .map((w) => w.removedAt !== undefined)
        ).toEqual([true]);
        await vi.waitFor(
          () => expect(sessionOf(drop.sessionId)).toBeUndefined(),
          { timeout: 20_000, interval: 500 }
        );
        expect(sessionOf(keep.sessionId)?.task).toMatchObject({
          id: two.task,
          n: 1,
        });
        expect(
          dbs.tasks.get(two.task)?.variants.map((x) => [x.picked, x.discarded])
        ).toEqual([
          [true, undefined],
          [undefined, true],
        ]);

        // A session made in opencode directly becomes a manual task on the next reconcile.
        const stray = await hub.environments
          .opencodeClient(project.id)
          .createSession(v.directory!, { title: "made in opencode" });
        hub.environments.reconcile(project.id);
        await vi.waitFor(
          () =>
            expect(dbs.tasks.bySession(stray.id)?.task).toMatchObject({
              kind: "manual",
            }),
          { timeout: 20_000, interval: 500 }
        );
      } finally {
        await hub.environments.stop(project.id).catch(() => undefined);
        await hub.environments.shutdown();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
);
