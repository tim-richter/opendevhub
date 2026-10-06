import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_NODE, localHost } from "../../src/server/host";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function echoServer(): Promise<number> {
  const server = net.createServer((s) => s.on("data", (d) => s.write(`echo:${d.toString()}`)));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

describe("localHost", () => {
  it("is the local node", () => {
    expect(localHost().id).toBe(LOCAL_NODE);
    expect(LOCAL_NODE).toBe("local");
  });

  it("writes files, creating parent folders, and reads them back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-host-"));
    try {
      const host = localHost();
      const file = path.join(dir, "a", "b", "c.json");
      await host.writeFile(file, "{}\n");
      expect(await host.readFile(file)).toBe("{}\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dials TCP ports", async () => {
    const port = await echoServer();
    const stream = await localHost().dial("127.0.0.1", port);
    const reply = new Promise<string>((resolve) => stream.once("data", (d: Buffer) => resolve(d.toString())));
    stream.write("hi");
    expect(await reply).toBe("echo:hi");
    stream.destroy();
  });

  it("rejects a dial to a closed port", async () => {
    const port = await echoServer();
    await new Promise((r) => servers.pop()!.close(r));
    await expect(localHost().dial("127.0.0.1", port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
