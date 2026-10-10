import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { Hono } from "hono";
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
import { AGENT_SSH_COMMAND } from "../../src/server/network/relay/agent";
import { RelayRuntime } from "../../src/server/network/relay/runtime";
import { Network, parseRouteMode } from "../../src/server/network/routes";
import { spawnRunner } from "../../src/server/nodes/exec";
import { startNotifier } from "../../src/server/notifications/notifier";
import { Push } from "../../src/server/notifications/push";
import type { PushSender } from "../../src/server/notifications/push";
import {
  OpencodeClient,
  basicAuth,
  isGone,
  isInvalidAnswer,
} from "../../src/server/opencode/client";
import { OpencodeRuntime } from "../../src/server/opencode/runtime";
import { projectId } from "../../src/server/projects/ids";
import { Onboarding } from "../../src/server/projects/onboarding";
import { StateStore } from "../../src/server/projects/state";
import { startServer } from "../../src/server/server";
import { UsageStore, trackUsage } from "../../src/server/sessions/usage";
import type { CheckRun, Project } from "../../src/shared/types";
import { memoryStores } from "../helpers/stores";

const fixture = path.resolve("test/e2e/fixture");

function getViaHost(
  port: number,
  host: string,
  urlPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: urlPath, headers: { host } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        }
      )
      .on("error", reject);
  });
}

describe.skipIf(!process.env.OPENDEVHUB_E2E)(
  "e2e: real devcontainer + opencode v2",
  () => {
    it("starts, reports sessions, proxies and stops", async () => {
      // A throwaway ssh-agent with one key stands in for the developer's.
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-e2e-agent-"));
      const agentSock = path.join(agentDir, "agent.sock");
      const sshAgent = spawn("ssh-agent", ["-D", "-a", agentSock], {
        stdio: "ignore",
      });
      await vi.waitFor(() => expect(fs.existsSync(agentSock)).toBe(true));
      const keyFile = path.join(agentDir, "key");
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        keyFile,
      ]);
      execFileSync("ssh-add", [keyFile], {
        env: { ...process.env, SSH_AUTH_SOCK: agentSock },
        stdio: "ignore",
      });
      const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyFile}.pub`])
        .toString()
        .split(" ")[1];
      const previousSock = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = agentSock;
      const project: Project = {
        id: projectId(fixture),
        name: "fixture",
        path: fixture,
        devcontainerPath: path.join(fixture, ".devcontainer/devcontainer.json"),
      };
      const dbs = memoryStores();
      const store = new StateStore({
        tasks: dbs.tasks,
        port: 0,
        persisted: { projects: {} },
        persist: () => {},
      });
      const containers = new Containers(spawnRunner);
      const clientFor = (ep: { baseUrl: string; password: string }) =>
        new OpencodeClient(ep);
      const runtime = new OpencodeRuntime({ containers, clientFor });
      // OPENDEVHUB_ROUTE=gateway runs the same test through the gateway container (the macOS path).
      const network = new Network({
        mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE),
        gateway: new Gateway({ run: spawnRunner }),
      });
      const usage = UsageStore.open(":memory:")!;
      const usageTracker = trackUsage(usage, store);
      const hub = createHub({
        store,
        projects: dbs.projects,
        tasks: dbs.tasks,
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
        credentials: new Credentials({ run: spawnRunner, containers }),
        recordUsage: usageTracker.record,
        clientFor,
        roots: () => [],
        scan: async () => [project],
      });
      hub.environments.onLog((_id, line) => console.log(`[e2e] ${line}`));

      await hub.environments.rescan();
      await hub.environments.start(project.id);
      const rt = store.runtime(project.id);
      expect(rt.error).toBeUndefined();
      expect(rt).toMatchObject({
        containerState: "running",
        opencode: "healthy",
      });
      expect(rt.relay).toBe("active");
      // Git and ssh: the forwarded agent, git's ssh command, opencode's environment and the identity.
      await vi.waitFor(
        () => expect(store.runtime(project.id).sshAgent).toBe("forwarded"),
        { timeout: 15_000 }
      );
      const listed = await containers.exec(project, [
        "sh",
        "-c",
        "SSH_AUTH_SOCK=/tmp/opendevhub-ssh-agent.sock ssh-add -l",
      ]);
      expect(listed.stdout).toContain(fingerprint);
      const sshCommand = await containers.exec(project, [
        "git",
        "config",
        "--global",
        "--get",
        "core.sshCommand",
      ]);
      expect(sshCommand.stdout.trim()).toBe(AGENT_SSH_COMMAND);
      const opencodeEnv = await containers.exec(project, [
        "sh",
        "-c",
        "tr '\\0' '\\n' < /proc/$(pgrep -f 'opencode [s]erve' | head -n 1)/environ",
      ]);
      expect(opencodeEnv.stdout).toContain(
        "SSH_AUTH_SOCK=/tmp/opendevhub-ssh-agent.sock"
      );
      const hostEmail = spawnSync(
        "git",
        ["-C", fixture, "config", "user.email"],
        { encoding: "utf-8" }
      ).stdout.trim();
      if (hostEmail) {
        const email = await containers.exec(project, [
          "git",
          "config",
          "--global",
          "--get",
          "user.email",
        ]);
        expect(email.stdout.trim()).toBe(hostEmail);
        const commit = await containers.exec(project, [
          "sh",
          "-c",
          'cd "$(mktemp -d)" && git init -q && git commit -q --allow-empty -m e2e',
        ]);
        expect(commit.exitCode).toBe(0);
      } else {
        console.log(
          "[e2e] no git identity on this machine; skipping the commit check"
        );
      }
      // A server backgrounded from postStartCommand does not outlive the lifecycle command under the
      // devcontainer CLI, so start it the same way opendevhub starts opencode. It binds the container's
      // loopback only, so it is reachable from the host only through the relay.
      await containers.exec(project, [
        "sh",
        "-c",
        "nohup node -e \"require('http').createServer((q, r) => r.end('e2e-web-ok')).listen(8080, '127.0.0.1')\" < /dev/null > /tmp/odh-e2e-web.log 2>&1 &",
      ]);
      const web = rt.ports?.find(
        (p) => p.status === "forwarded" && p.containerPort === 8080
      );
      expect(web).toMatchObject({
        status: "forwarded",
        containerPort: 8080,
        label: "e2e web",
      });
      const webPort = web?.status === "forwarded" ? web.hostPort : 0;
      await vi.waitFor(
        async () =>
          expect(
            await (await fetch(`http://127.0.0.1:${webPort}/`)).text()
          ).toBe("e2e-web-ok"),
        { timeout: 15_000, interval: 500 }
      );

      const address = hub.environments.opencodeAddress(project.id)!;
      const ep = runtime.endpoint(address, rt.password!);
      const created = await fetch(`${ep.baseUrl}/api/session`, {
        method: "POST",
        headers: {
          authorization: basicAuth(ep.password),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "e2e session",
          location: { directory: rt.workspaceFolder },
        }),
      });
      expect(created.ok).toBe(true);
      await vi.waitFor(
        () =>
          expect(
            store.snapshot().projects[0].sessions.map((s) => s.title)
          ).toContain("e2e session"),
        { timeout: 15_000 }
      );
      // Real opencode v2 sessions carry the cost and tokens fields the ledger reads (zero before any prompt).
      const e2eSession = store
        .snapshot()
        .projects[0].sessions.find((s) => s.title === "e2e session")!;
      expect(typeof (e2eSession.cost ?? 0)).toBe("number");
      expect(store.snapshot().usage).toMatchObject({
        today: { cost: expect.any(Number), tokens: expect.any(Number) },
      });

      // Respond inline: create real pending items through opencode's own endpoints, answer them through opendevhub.
      const sid = store
        .snapshot()
        .projects[0].sessions.find((s) => s.title === "e2e session")!.id;
      const opencode = (method: string, route: string, body?: unknown) =>
        fetch(`${ep.baseUrl}/api/session/${sid}${route}`, {
          method,
          headers: {
            authorization: basicAuth(ep.password),
            "content-type": "application/json",
            "x-opencode-directory": rt.workspaceFolder!,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const pendingOf = () =>
        store.snapshot().projects[0].sessions.find((s) => s.id === sid)
          ?.pending;

      // Push notifications: the notifier sends each new permission once, through a fake push service.
      const pushed: { payload: string }[] = [];
      const sender: PushSender = async (_sub, payload) => {
        pushed.push({ payload });
        return { statusCode: 201 };
      };
      const push = new Push({
        file: path.join(agentDir, "push.json"),
        send: sender,
      });
      push.subscribe({
        endpoint: "https://push.example.com/e2e",
        keys: { p256dh: "k", auth: "a" },
      });
      const stopNotifier = startNotifier(store, push);
      const checks = new Checks({
        target: (id, dir) => hub.checkouts.checkTarget(id, dir),
        project: (id) => store.project(id),
        containers,
        run: spawnRunner,
        git: new GitOps({ containers }),
        settings: new FileProjectSettings(agentDir),
        log: (id, line) => hub.environments.note(id, line),
      });
      const dashboard = createDashboardApp({
        store,
        hub,
        cleanup: new Cleanup({
          store,
          containers,
          branches: hub.cleanupTargets,
          log: (id, line) => hub.environments.note(id, line),
        }),
        checks,
        onboarding: new Onboarding({ roots: () => [] }),
        push,
      });

      // opencode's default rules allow most actions outright; make this session ask.
      expect(
        (
          await opencode("PATCH", "", {
            permissions: [{ action: "*", resource: "*", effect: "ask" }],
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await opencode("POST", "/permission", {
            action: "bash",
            resources: ["echo e2e"],
          })
        ).ok
      ).toBe(true);
      await vi.waitFor(() => expect(pendingOf()?.permissions).toHaveLength(1), {
        timeout: 15_000,
      });
      const rid = pendingOf()!.permissions[0].id;
      await vi.waitFor(() => expect(pushed).toHaveLength(1));
      expect(JSON.parse(pushed[0].payload)).toMatchObject({
        tag: `perm:${rid}`,
        sessionId: sid,
        permission: { requestId: rid },
      });
      // Allow once from the notification: the service worker posts to the reply route.
      const allowed = await dashboard.request(
        `/api/projects/${project.id}/permissions/${rid}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "once" }),
        }
      );
      expect(allowed.status).toBe(200);
      await vi.waitFor(
        () => expect(pendingOf()?.permissions ?? []).toHaveLength(0),
        { timeout: 15_000 }
      );
      expect(pushed).toHaveLength(1);
      stopNotifier();
      // Answering again straight at opencode is how "answered in another client" looks.
      const direct = new OpencodeClient(ep);
      const again = await direct
        .replyPermission(sid, rid, { decision: "once" })
        .catch((error: unknown) => error);
      console.log("[e2e] second permission reply:", again);
      expect(isGone(again)).toBe(true);

      const fields = [
        {
          key: "color",
          type: "string",
          options: [
            { value: "red", label: "Red" },
            { value: "blue", label: "Blue" },
          ],
          required: true,
        },
      ];
      expect(
        (await opencode("POST", "/form", { title: "e2e question", fields })).ok
      ).toBe(true);
      await vi.waitFor(() => expect(pendingOf()?.forms).toHaveLength(1), {
        timeout: 15_000,
      });
      const fid = pendingOf()!.forms[0].id;
      const invalid = await direct
        .replyForm(sid, fid, {})
        .catch((error: unknown) => error);
      console.log("[e2e] invalid form answer:", invalid);
      expect(isInvalidAnswer(invalid)).toBe(true);
      await hub.sessions.replyForm(project.id, fid, { color: "red" });
      await vi.waitFor(() => expect(pendingOf()?.forms ?? []).toHaveLength(0), {
        timeout: 15_000,
      });
      const settled = await direct
        .replyForm(sid, fid, { color: "blue" })
        .catch((error: unknown) => error);
      console.log("[e2e] settled form reply:", settled);
      expect(isGone(settled)).toBe(true);

      expect(
        (await opencode("POST", "/form", { title: "e2e dismissed", fields })).ok
      ).toBe(true);
      await vi.waitFor(() => expect(pendingOf()?.forms).toHaveLength(1), {
        timeout: 15_000,
      });
      await hub.sessions.cancelForm(project.id, pendingOf()!.forms[0].id);
      await vi.waitFor(() => expect(pendingOf()).toBeUndefined(), {
        timeout: 15_000,
      });

      // Checks: one in the container, one on this machine, saved as the project's own list.
      const api = (route: string, body?: unknown) =>
        dashboard.request(`/api/projects/${project.id}/${route}`, {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        });
      const saved = await api("checks/settings", {
        checks: [
          {
            name: "inside",
            command:
              'test -f .devcontainer/devcontainer.json && echo "in-$OPENDEVHUB_CHECK"',
          },
          { name: "outside", command: "pwd", where: "host" },
          { name: "slow", command: "sleep 60", timeout: 10 },
        ],
      });
      expect(saved.status).toBe(200);
      const dir = encodeURIComponent(rt.workspaceFolder!);
      expect(
        (await api("checks/run", { directory: rt.workspaceFolder })).status
      ).toBe(200);
      const run = await vi.waitFor(
        async () => {
          const { run } = (await (
            await api(`checks/run?directory=${dir}`)
          ).json()) as { run: CheckRun };
          if (!run.finishedAt) {
            throw new Error("checks still running");
          }
          return run;
        },
        { timeout: 60_000, interval: 500 }
      );
      expect(run.results.map((r) => [r.name, r.status])).toEqual([
        ["inside", "passed"],
        ["outside", "passed"],
        ["slow", "failed"],
      ]);
      expect(run.results[0].output).toEqual(["in-inside"]);
      expect(run.results[1].output).toEqual([fixture]);
      expect(run.results[2]).toMatchObject({ timedOut: true });
      // `timeout` ended the whole command in the container, not only the client.
      expect(
        (
          await containers.exec(project, [
            "sh",
            "-c",
            "pgrep -f '[s]leep 60' || true",
          ])
        ).stdout.trim()
      ).toBe("");

      const server = await startServer({
        port: 0,
        app: new Hono(),
        resolveTarget: () => ({ ...address, password: rt.password! }),
      });
      const info = await getViaHost(
        server.port,
        `${project.id}.localhost:${server.port}`,
        "/api/info"
      );
      expect(JSON.parse(info).version).toMatch(/^2\./u);
      const html = await getViaHost(
        server.port,
        `${project.id}.localhost:${server.port}`,
        "/"
      );
      expect(html).toContain("<html");
      await server.close();

      await hub.environments.stop(project.id);
      expect(store.runtime(project.id).ports).toBeUndefined();
      await expect(fetch(`http://127.0.0.1:${webPort}/`)).rejects.toThrow();
      expect(store.runtime(project.id).containerState).toBe("stopped");
      await hub.environments.shutdown();
      usageTracker.stop();
      usage.close();
      sshAgent.kill();
      if (previousSock === undefined) {
        delete process.env.SSH_AUTH_SOCK;
      } else {
        process.env.SSH_AUTH_SOCK = previousSock;
      }
      fs.rmSync(agentDir, { recursive: true, force: true });
    });
  }
);
