import { spawnSync } from "node:child_process";
import net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RELAY_SCRIPT } from "../../src/server/relay/script";
import { freePort, startRelay } from "../helpers/relay";

type Relay = Awaited<ReturnType<typeof startRelay>>;
let relay: Relay;
const servers: net.Server[] = [];

beforeEach(async () => {
  relay = await startRelay("secret");
});
afterEach(async () => {
  await relay.stop();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r)))
  );
});

async function echoOn(host: string): Promise<number> {
  const port = await freePort(host);
  const s = net.createServer((c) => c.on("data", (d) => c.write(`echo:${d}`)));
  servers.push(s);
  await new Promise<void>((r) => s.listen(port, host, r));
  return port;
}

/** Sends `header` (+ optional payload), collects everything the relay sends until it closes or `until` matches. */
function talk(header: string, payload = "", until?: RegExp): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(relay.port, "127.0.0.1", () =>
      socket.write(header + payload)
    );
    let got = "";
    socket.on("data", (d) => {
      got += d.toString();
      if (until?.test(got)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("close", () => resolve(got));
    socket.on("error", () => resolve(got));
  });
}

describe(RELAY_SCRIPT, () => {
  it("is CommonJS, single-quote free and carries the kill marker", () => {
    expect(RELAY_SCRIPT.startsWith("/*odh-relay*/")).toBeTruthy();
    expect(RELAY_SCRIPT).not.toContain("'");
    expect(RELAY_SCRIPT).toContain('require("node:net")');
  });

  it("answers ping with PONG and the protocol version", async () => {
    await expect(talk("secret ping\n")).resolves.toBe("PONG 2\n");
  });

  it("pipes to a 127.0.0.1 target, forwarding bytes sent together with the header", async () => {
    const port = await echoOn("127.0.0.1");
    await expect(talk(`secret ${port}\n`, "hi", /echo:hi/u)).resolves.toBe(
      "OK\necho:hi"
    );
  });

  it("falls back to ::1 when nothing listens on 127.0.0.1", async () => {
    const port = await echoOn("::1");
    await expect(talk(`secret ${port}\n`, "v6", /echo:v6/u)).resolves.toBe(
      "OK\necho:v6"
    );
  });

  it("reports ECONNREFUSED when nothing listens", async () => {
    const port = await freePort();
    await expect(talk(`secret ${port}\n`)).resolves.toBe("ERR ECONNREFUSED\n");
  });

  it.each([
    ["wrong token", "nope 80\n"],
    ["malformed header", "secret\n"],
    ["bad port", "secret 70000\n"],
    ["non-numeric port", "secret abc\n"],
    ["oversized header", "x".repeat(300)],
  ])("closes silently on %s", async (_name, header) => {
    await expect(talk(header)).resolves.toBe("");
  });

  it("closes silently after 5 s without a complete header", async () => {
    const started = Date.now();
    await expect(talk("secret 80")).resolves.toBe("");
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  }, 10_000);

  it("rejects the gateway form `<token> <ip> <port>` unless started in remote mode", async () => {
    const port = await echoOn("127.0.0.1");
    await expect(talk(`secret 127.0.0.1 ${port}\n`, "hi")).resolves.toBe("");
  });

  describe("in remote (gateway) mode", () => {
    let gateway: Relay;
    beforeEach(async () => {
      gateway = await startRelay("secret", { ODH_RELAY_REMOTE: "1" });
    });
    afterEach(() => gateway.stop());

    function talkGateway(
      header: string,
      payload = "",
      until?: RegExp
    ): Promise<string> {
      return new Promise((resolve) => {
        const socket = net.connect(gateway.port, "127.0.0.1", () =>
          socket.write(header + payload)
        );
        let got = "";
        socket.on("data", (d) => {
          got += d.toString();
          if (until?.test(got)) {
            socket.destroy();
            resolve(got);
          }
        });
        socket.on("close", () => resolve(got));
        socket.on("error", () => resolve(got));
      });
    }

    it("pipes to the named IP", async () => {
      const port = await echoOn("127.0.0.1");
      await expect(
        talkGateway(`secret 127.0.0.1 ${port}\n`, "hi", /echo:hi/u)
      ).resolves.toBe("OK\necho:hi");
    });

    it("still answers ping and the loopback form", async () => {
      const port = await echoOn("127.0.0.1");
      await expect(talkGateway("secret ping\n")).resolves.toBe("PONG 2\n");
      await expect(
        talkGateway(`secret ${port}\n`, "lo", /echo:lo/u)
      ).resolves.toBe("OK\necho:lo");
    });

    it("reports ECONNREFUSED for the named IP", async () => {
      const port = await freePort();
      await expect(talkGateway(`secret 127.0.0.1 ${port}\n`)).resolves.toBe(
        "ERR ECONNREFUSED\n"
      );
    });

    it.each([
      ["host names", "secret localhost 80\n"],
      ["wrong token", "nope 127.0.0.1 80\n"],
      ["bad port", "secret 127.0.0.1 0\n"],
      ["extra fields", "secret 127.0.0.1 80 x\n"],
    ])("closes silently on %s", async (_name, header) => {
      await expect(talkGateway(header)).resolves.toBe("");
    });
  });

  it("exits with an error when the token is missing", () => {
    const r = spawnSync(process.execPath, ["-e", RELAY_SCRIPT], {
      env: { ...process.env, ODH_RELAY_TOKEN: "", ODH_RELAY_PORT: "0" },
      encoding: "utf-8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ODH_RELAY_TOKEN");
  });
});
