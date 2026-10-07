import { describe, expect, it, vi } from "vitest";

import { Containers } from "../../src/server/containers";
import { localHost } from "../../src/server/host";
import { NodeKits, buildNodeKit } from "../../src/server/node-kits";
import type { NodeConnectionPort } from "../../src/server/nodes";
import type { OpencodeClient } from "../../src/server/opencode/client";
import type { NodeKit } from "../../src/server/orchestrator";
import { fakeRunner } from "../helpers/fake-runner";

function conn(online: boolean): NodeConnectionPort {
  return {
    host: { ...localHost(fakeRunner().run), id: "box", home: "/home/tim" },
    online,
    target: { dest: "tim@box", control: "/ctl/box.sock" },
    view: () => ({
      id: "box",
      label: "box",
      state: online ? "online" : "unreachable",
    }),
    start: () => {},
    close: async () => {},
  };
}

describe(NodeKits, () => {
  it("hands out a kit only while the node is online, built once per connection", () => {
    let current: NodeConnectionPort | undefined = conn(true);
    const build = vi.fn((_c: NodeConnectionPort) => ({}) as NodeKit);
    const kits = new NodeKits({
      nodes: { connection: (id) => (id === "box" ? current : undefined) },
      build,
    });
    expect(kits.known("box")).toBeTruthy();
    expect(kits.known("nope")).toBeFalsy();
    const first = kits.kit("box");
    expect(first).toBeDefined();
    expect(kits.kit("box")).toBe(first);
    expect(build).toHaveBeenCalledOnce();
    current = conn(false);
    expect(kits.kit("box")).toBeUndefined();
    current = conn(true);
    expect(kits.kit("box")).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
    current = undefined;
    expect(kits.kit("box")).toBeUndefined();
  });
});

describe(buildNodeKit, () => {
  it("builds every tool on the node's host, with files under its home", async () => {
    const kit = buildNodeKit(conn(true), {
      clientFor: () => ({}) as OpencodeClient,
      local: fakeRunner().run,
    });
    expect(kit.containers).toBeInstanceOf(Containers);
    expect(kit.envFiles.path("demo-fix-1a2b")).toBe(
      "/home/tim/.opendevhub/envs/demo-fix-1a2b/devcontainer.json"
    );
    expect(
      kit.repo.layout(
        { id: "demo", name: "demo", path: "/src/demo", devcontainerPath: "" },
        "/workspaces/demo"
      ).repo
    ).toBe("/home/tim/.opendevhub/repos/demo/demo");
    const route = await kit.network.route(
      { id: "c", ip: "172.18.0.4" },
      () => {}
    );
    expect(route.kind).toBe("ssh");
    await route.close();
  });

  it("needs the connection's ssh target", () => {
    const { target: _t, ...without } = conn(true);
    expect(() =>
      buildNodeKit(without, {
        clientFor: () => ({}) as OpencodeClient,
        local: fakeRunner().run,
      })
    ).toThrow(/no ssh target/u);
  });
});
