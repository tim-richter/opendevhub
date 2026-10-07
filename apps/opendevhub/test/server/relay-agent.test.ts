import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startRelay } from "../helpers/relay";

type Relay = Awaited<ReturnType<typeof startRelay>>;
let relay: Relay;
let dir: string;
let sock: string;
const sockets: net.Socket[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-agent-"));
  sock = path.join(dir, "agent.sock");
  relay = await startRelay("secret", { ODH_AGENT_SOCK: sock });
});
afterEach(async () => {
  for (const s of sockets.splice(0)) {
    s.destroy();
  }
  await relay.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A connection to the relay that sends `header` and collects complete lines. */
function connect(header: string, port = relay.port) {
  const socket = net.connect(port, "127.0.0.1", () => socket.write(header));
  sockets.push(socket);
  const lines: string[] = [];
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  socket.on("error", () => {});
  const closed = new Promise<void>((r) => socket.on("close", () => r()));
  const line = (i: number) =>
    vi.waitFor(() => {
      if (lines.length <= i) {
        throw new Error(`waiting for line ${i}`);
      }
      return lines[i];
    });
  return { socket, lines, closed, line };
}

/** A client of the agent socket, as ssh in the container would be. */
function agentClient() {
  const socket = net.connect(sock);
  sockets.push(socket);
  let got = "";
  socket.on("data", (d) => (got += d.toString()));
  socket.on("error", () => {});
  const closed = new Promise<void>((r) => socket.on("close", () => r()));
  return { socket, closed, received: () => got };
}

describe("relay agent verbs", () => {
  it("agent-listen answers OK and creates the socket with mode 0600", async () => {
    const control = connect("secret agent-listen\n");
    await expect(control.line(0)).resolves.toBe("OK");
    const stat = fs.statSync(sock);
    expect(stat.isSocket()).toBeTruthy();
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("announces a client and pipes it to the connection that accepts it", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const client = agentClient();
    client.socket.write("request\n");
    const conn = await control.line(1);
    expect(conn).toMatch(/^CONN \d+$/u);
    const accept = connect(`secret agent-accept ${conn.split(" ")[1]}\n`);
    await expect(accept.line(0)).resolves.toBe("OK");
    await expect(accept.line(1)).resolves.toBe("request");
    accept.socket.write("answer\n");
    await vi.waitFor(() => expect(client.received()).toBe("answer\n"));
  });

  it("gives concurrent clients their own ids and pipes", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const a = agentClient();
    const b = agentClient();
    const ids = [
      (await control.line(1)).split(" ")[1],
      (await control.line(2)).split(" ")[1],
    ];
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      const accept = connect(`secret agent-accept ${id}\n`);
      await accept.line(0);
      accept.socket.write(`for-${id}\n`);
    }
    await vi.waitFor(() =>
      expect([a.received(), b.received()].sort()).toStrictEqual(
        ids.map((id) => `for-${id}\n`).sort()
      )
    );
  });

  it("answers ERR ENOENT for an unknown id", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const accept = connect("secret agent-accept 999\n");
    await expect(accept.line(0)).resolves.toBe("ERR ENOENT");
    await accept.closed;
  });

  it("closes a client nobody accepts after 5 s", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const client = agentClient();
    await control.line(1);
    const start = Date.now();
    await client.closed;
    expect(Date.now() - start).toBeGreaterThanOrEqual(4500);
  }, 10_000);

  it("a second control connection replaces the first and is told about pending clients", async () => {
    const first = connect("secret agent-listen\n");
    await first.line(0);
    agentClient();
    await first.line(1);
    const second = connect("secret agent-listen\n");
    await expect(second.line(0)).resolves.toBe("OK");
    await first.closed;
    await expect(second.line(1)).resolves.toMatch(/^CONN \d+$/u);
    expect(fs.existsSync(sock)).toBeTruthy();
  });

  it("removes the socket and drops pending clients 2 s after the control connection goes", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const client = agentClient();
    await control.line(1);
    control.socket.destroy();
    await vi.waitFor(() => expect(fs.existsSync(sock)).toBeFalsy(), {
      timeout: 4000,
    });
    await client.closed;
  });

  it("keeps the socket when a new control connection arrives within 2 s", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    control.socket.destroy();
    await control.closed;
    const again = connect("secret agent-listen\n");
    await expect(again.line(0)).resolves.toBe("OK");
    await new Promise((r) => setTimeout(r, 2500));
    expect(fs.existsSync(sock)).toBeTruthy();
  });

  it("closes silently on a wrong token", async () => {
    const control = connect("nope agent-listen\n");
    await control.closed;
    expect(control.lines).toStrictEqual([]);
    expect(fs.existsSync(sock)).toBeFalsy();
  });

  it("is refused by the gateway relay", async () => {
    const gateway = await startRelay("secret", {
      ODH_AGENT_SOCK: sock,
      ODH_RELAY_REMOTE: "1",
    });
    try {
      const control = connect("secret agent-listen\n", gateway.port);
      await control.closed;
      expect(control.lines).toStrictEqual([]);
      expect(fs.existsSync(sock)).toBeFalsy();
    } finally {
      await gateway.stop();
    }
  });
});
