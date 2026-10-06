import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidNodeError, loadConfig, saveConfig, type NodeConfig } from "../../src/server/config";
import { localHost } from "../../src/server/host";
import { type NodeConnectionPort, Nodes } from "../../src/server/nodes";
import { NotFoundError } from "../../src/server/orchestrator";
import type { NodeView } from "../../src/shared/types";
import { fakeRunner } from "../helpers/fake-runner";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeConnection(node: NodeConfig, online: boolean) {
  const host = { ...localHost(fakeRunner(() => ({ stdout: "4\nMemTotal: 1024 kB\nMemAvailable: 512 kB\n1\n0\n" })).run), id: node.id };
  return {
    host,
    online,
    view: (): NodeView => ({ id: node.id, label: node.label ?? node.ssh, ssh: node.ssh, state: online ? "online" : "unreachable" }),
    start: vi.fn(),
    close: vi.fn(async () => {}),
  } satisfies NodeConnectionPort;
}

function setup(nodes: NodeConfig[] = [], online = true) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-reg-"));
  dirs.push(configDir);
  saveConfig(configDir, { roots: ["/src"], port: 7777, ...(nodes.length ? { nodes } : {}) });
  const store = { setNodes: vi.fn() };
  const connections = new Map<string, ReturnType<typeof fakeConnection>>();
  const stats = vi.fn(async () => ({ cpus: 4, memTotal: 1024, memAvailable: 512, containers: 1 }));
  const registry = new Nodes({
    configDir,
    controlDir: path.join(configDir, "ssh"),
    store,
    local: localHost(fakeRunner().run),
    connect: (node) => {
      const c = fakeConnection(node, online);
      connections.set(node.id, c);
      return c;
    },
    stats,
    statsIntervalMs: 10,
  });
  return { registry, store, connections, stats, configDir };
}

describe("Nodes", () => {
  it("refuses to remove a node that still runs environments", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-reg-"));
    dirs.push(configDir);
    saveConfig(configDir, { roots: [], port: 7777, nodes: [{ id: "box", ssh: "tim@box" }] });
    const registry = new Nodes({
      configDir,
      controlDir: path.join(configDir, "ssh"),
      store: { setNodes: vi.fn() },
      local: localHost(fakeRunner().run),
      connect: (node) => fakeConnection(node, true),
      stats: async () => undefined,
      statsIntervalMs: 1000,
      environmentsOn: (id) => (id === "box" ? 2 : 0),
    });
    registry.start();
    await expect(registry.remove("box")).rejects.toThrow("node box still runs 2 task environments; remove them first");
    await expect(registry.remove("box")).rejects.toBeInstanceOf(InvalidNodeError);
    expect(loadConfig(configDir).nodes).toEqual([{ id: "box", ssh: "tim@box" }]);
    await registry.close();
  });

  it("reports nodes coming online and going offline, once per change", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-reg-"));
    dirs.push(configDir);
    saveConfig(configDir, { roots: [], port: 7777, nodes: [{ id: "box", ssh: "tim@box" }] });
    const conn = fakeConnection({ id: "box", ssh: "tim@box" }, false);
    let notify = () => {};
    const onOnline = vi.fn();
    const onOffline = vi.fn();
    const registry = new Nodes({
      configDir,
      controlDir: path.join(configDir, "ssh"),
      store: { setNodes: vi.fn() },
      local: localHost(fakeRunner().run),
      connect: (_n, onChange) => {
        notify = onChange;
        return conn;
      },
      stats: async () => undefined,
      statsIntervalMs: 1000,
      onOnline,
      onOffline,
    });
    registry.start();
    expect(registry.connection("box")).toBe(conn);
    expect(onOnline).not.toHaveBeenCalled();
    conn.online = true;
    notify();
    notify();
    expect(onOnline).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenCalledWith("box");
    conn.online = false;
    notify();
    expect(onOffline).toHaveBeenCalledWith("box");
    conn.online = true;
    notify();
    await registry.remove("box");
    expect(onOffline).toHaveBeenCalledTimes(2);
    expect(registry.connection("box")).toBeUndefined();
    await registry.close();
  });

  it("opens configured nodes on start and lists local first", async () => {
    const { registry, store, connections } = setup([{ id: "box", ssh: "tim@box" }]);
    registry.start();
    expect(connections.get("box")?.start).toHaveBeenCalled();
    expect(registry.list().map((n) => n.id)).toEqual(["local", "box"]);
    expect(registry.list()[0]).toMatchObject({ label: "This machine", state: "online" });
    expect(store.setNodes).toHaveBeenCalled();
    await registry.close();
  });

  it("samples stats for local and online nodes", async () => {
    const { registry, store } = setup([{ id: "box", ssh: "tim@box" }]);
    registry.start();
    await vi.waitFor(() => expect(registry.list().every((n) => n.stats?.cpus === 4)).toBe(true));
    expect(store.setNodes.mock.calls.at(-1)?.[0]).toEqual(registry.list());
    await registry.close();
  });

  it("does not sample nodes that are offline", async () => {
    const { registry, stats } = setup([{ id: "box", ssh: "tim@box" }], false);
    registry.start();
    await vi.waitFor(() => expect(stats).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(registry.list().find((n) => n.id === "box")?.stats).toBeUndefined();
    await registry.close();
  });

  it("adds a node: saves it, connects, and answers its view", async () => {
    const { registry, configDir, connections } = setup();
    const view = await registry.add({ ssh: "tim@box", label: "Box" });
    expect(view).toMatchObject({ id: "box", label: "Box", ssh: "tim@box" });
    expect(loadConfig(configDir).nodes).toEqual([{ id: "box", ssh: "tim@box", label: "Box" }]);
    expect(connections.get("box")?.start).toHaveBeenCalled();
    await registry.close();
  });

  it("rejects bad input without saving", async () => {
    const { registry, configDir } = setup();
    await expect(registry.add({ ssh: "-oProxyCommand=x" })).rejects.toBeInstanceOf(InvalidNodeError);
    await expect(registry.add({})).rejects.toBeInstanceOf(InvalidNodeError);
    expect(loadConfig(configDir).nodes).toBeUndefined();
  });

  it("removes a node: closes it and drops it from config", async () => {
    const { registry, configDir, connections } = setup([{ id: "box", ssh: "tim@box" }]);
    registry.start();
    await registry.remove("box");
    expect(connections.get("box")?.close).toHaveBeenCalled();
    expect(loadConfig(configDir).nodes).toBeUndefined();
    expect(registry.list().map((n) => n.id)).toEqual(["local"]);
    await expect(registry.remove("box")).rejects.toBeInstanceOf(NotFoundError);
    await expect(registry.remove("local")).rejects.toBeInstanceOf(NotFoundError);
    await registry.close();
  });

  it("hands out hosts only for local and online nodes", async () => {
    const online = setup([{ id: "box", ssh: "tim@box" }], true);
    online.registry.start();
    expect(online.registry.host("local")?.id).toBe("local");
    expect(online.registry.host("box")?.id).toBe("box");
    expect(online.registry.host("nope")).toBeUndefined();
    await online.registry.close();

    const offline = setup([{ id: "box", ssh: "tim@box" }], false);
    offline.registry.start();
    expect(offline.registry.host("box")).toBeUndefined();
    await offline.registry.close();
  });

  it("closes every connection and stops sampling", async () => {
    const { registry, connections, stats } = setup([{ id: "a", ssh: "a" }, { id: "b", ssh: "b" }]);
    registry.start();
    await registry.close();
    for (const c of connections.values()) expect(c.close).toHaveBeenCalled();
    const calls = stats.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(stats.mock.calls.length).toBe(calls);
  });
});
