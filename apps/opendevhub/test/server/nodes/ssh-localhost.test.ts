/**
 * Runs against a real sshd on this machine. Opt in with ODH_TEST_SSH_LOCALHOST=1 after
 * `ssh -o BatchMode=yes localhost true` works (known host key, key in your agent).
 * Preflight may report missing tools; the test only needs the connection itself.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sshRoute } from "../../../src/server/network/routes";
import { NodeConnection } from "../../../src/server/nodes/connection";

const enabled = process.env.ODH_TEST_SSH_LOCALHOST === "1";

describe.skipIf(!enabled)("ssh localhost", () => {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-it-"));
  const conn = new NodeConnection({
    node: { id: "it", ssh: "localhost" },
    controlDir,
    onChange: () => {},
    preflight: async () => [],
  });

  afterAll(async () => {
    await conn.close();
    fs.rmSync(controlDir, { recursive: true, force: true });
  });

  it("connects, runs commands, moves files and dials", async () => {
    conn.start();
    await expect
      .poll(() => conn.view().state, { timeout: 20_000 })
      .toBe("online");

    const r = await conn.host.run("printf", ["%s|", "a b", "it's", "$HOME"]);
    expect(r.stdout).toBe("a b|it's|$HOME|");

    const file = path.join(controlDir, "nested", "f.txt");
    await conn.host.writeFile(file, "über\n");
    await expect(conn.host.readFile(file)).resolves.toBe("über\n");

    const server = net.createServer((s) =>
      s.on("data", (d) => s.write(`echo:${d.toString()}`))
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as net.AddressInfo;
    const route = await sshRoute(conn.host, "127.0.0.1");
    const stream = await route.dial!(port);
    stream.write("hi");
    const reply = await new Promise<string>((resolve) =>
      stream.once("data", (d: Buffer) => resolve(d.toString()))
    );
    expect(reply).toBe("echo:hi");
    stream.destroy();
    await route.close();
    await new Promise((resolve) => server.close(resolve));
  }, 30_000);
});
