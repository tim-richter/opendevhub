import http from "node:http";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { Containers } from "../../src/server/containers";
import { EditorLauncher } from "../../src/server/editors";
import { spawnRunner } from "../../src/server/exec";
import { projectId } from "../../src/server/ids";
import { OpencodeClient, basicAuth } from "../../src/server/opencode/client";
import { OPENCODE_PORT, OpencodeRuntime } from "../../src/server/opencode/runtime";
import { Orchestrator } from "../../src/server/orchestrator";
import { PortForwarder } from "../../src/server/port-forwarder";
import { RelayRuntime } from "../../src/server/relay/runtime";
import { startServer } from "../../src/server/server";
import { StateStore } from "../../src/server/state";
import { Worktrees } from "../../src/server/worktrees";
import type { Project } from "../../src/shared/types";

const fixture = path.resolve("test/e2e/fixture");

function getViaHost(port: number, host: string, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: urlPath, headers: { host } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

describe.skipIf(!process.env.OPENDEVHUB_E2E)("e2e: real devcontainer + opencode v2", () => {
  it("starts, reports sessions, proxies and stops", async () => {
    const project: Project = {
      id: projectId(fixture),
      name: "fixture",
      path: fixture,
      devcontainerPath: path.join(fixture, ".devcontainer/devcontainer.json"),
    };
    const store = new StateStore({ port: 0, persisted: { projects: {} }, persist: () => {} });
    const containers = new Containers(spawnRunner);
    const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
    const runtime = new OpencodeRuntime({ containers, clientFor });
    const orch = new Orchestrator({ store, containers, runtime, forwarder: new PortForwarder(), relay: new RelayRuntime({ containers }), worktrees: new Worktrees({ containers, run: spawnRunner }), editors: new EditorLauncher([]), clientFor, roots: () => [], scan: async () => [project] });
    orch.onLog((_id, line) => console.log(`[e2e] ${line}`));

    await orch.rescan();
    await orch.start(project.id);
    const rt = store.runtime(project.id);
    expect(rt.error).toBeUndefined();
    expect(rt).toMatchObject({ containerState: "running", opencode: "healthy" });
    expect(rt.relay).toBe("active");
    // A server backgrounded from postStartCommand does not outlive the lifecycle command under the
    // devcontainer CLI, so start it the same way opendevhub starts opencode. It binds the container's
    // loopback only, so it is reachable from the host only through the relay.
    await containers.exec(project, [
      "sh",
      "-c",
      "nohup node -e \"require('http').createServer((q, r) => r.end('e2e-web-ok')).listen(8080, '127.0.0.1')\" < /dev/null > /tmp/odh-e2e-web.log 2>&1 &",
    ]);
    const web = rt.ports?.find((p) => p.status === "forwarded" && p.containerPort === 8080);
    expect(web).toMatchObject({ status: "forwarded", containerPort: 8080, label: "e2e web" });
    const webPort = web?.status === "forwarded" ? web.hostPort : 0;
    await vi.waitFor(
      async () => expect(await (await fetch(`http://127.0.0.1:${webPort}/`)).text()).toBe("e2e-web-ok"),
      { timeout: 15_000, interval: 500 },
    );

    const ep = runtime.endpoint(rt.containerIp!, rt.password!);
    const created = await fetch(`${ep.baseUrl}/api/session`, {
      method: "POST",
      headers: { authorization: basicAuth(ep.password), "content-type": "application/json" },
      body: JSON.stringify({ title: "e2e session", location: { directory: rt.workspaceFolder } }),
    });
    expect(created.ok).toBe(true);
    await vi.waitFor(
      () => expect(store.snapshot().projects[0].sessions.map((s) => s.title)).toContain("e2e session"),
      { timeout: 15_000 },
    );

    const server = await startServer({
      port: 0,
      app: new Hono(),
      resolveTarget: () => ({ host: rt.containerIp!, port: OPENCODE_PORT, password: rt.password! }),
    });
    const info = await getViaHost(server.port, `${project.id}.localhost:${server.port}`, "/api/info");
    expect(JSON.parse(info).version).toMatch(/^2\./);
    const html = await getViaHost(server.port, `${project.id}.localhost:${server.port}`, "/");
    expect(html).toContain("<html");
    await server.close();

    await orch.stop(project.id);
    expect(store.runtime(project.id).ports).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${webPort}/`)).rejects.toThrow();
    expect(store.runtime(project.id).containerState).toBe("stopped");
    await orch.shutdown();
  });
});
