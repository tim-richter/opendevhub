import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentStatus, AgentTunnel, hostAgentProblem } from "../../src/server/relay/agent";
import { startRelay } from "../helpers/relay";

let dir: string;
let containerSock: string;
let hostSock: string;
let relay: Awaited<ReturnType<typeof startRelay>>;
let hostAgent: net.Server;
const tunnels: AgentTunnel[] = [];
const sockets: net.Socket[] = [];

/** Stands in for ssh-agent on this machine: answers every request with `agent:<request>`. */
function startHostAgent(): Promise<net.Server> {
  const s = net.createServer((c) => c.on("data", (d) => c.write(`agent:${d}`)));
  return new Promise((r) => s.listen(hostSock, () => r(s)));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-tunnel-"));
  containerSock = path.join(dir, "container.sock");
  hostSock = path.join(dir, "host.sock");
  relay = await startRelay("secret", { ODH_AGENT_SOCK: containerSock });
  hostAgent = await startHostAgent();
});
afterEach(async () => {
  for (const t of tunnels.splice(0)) t.stop();
  for (const s of sockets.splice(0)) s.destroy();
  await relay.stop();
  await new Promise((r) => hostAgent.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function tunnel(port = relay.port, hostSocket: () => string | undefined = () => hostSock) {
  const statuses: AgentStatus[] = [];
  const logs: string[] = [];
  const onRelayLost = vi.fn();
  const t = new AgentTunnel(
    { host: "127.0.0.1", port, token: "secret" },
    { onLog: (l) => logs.push(l), onStatus: (s) => statuses.push(s), onRelayLost, hostSocket, retryMinMs: 50, retryMaxMs: 200 },
  );
  tunnels.push(t);
  return { t, statuses, logs, onRelayLost, last: () => statuses.at(-1) };
}

/** Asks the forwarded agent in the "container" and resolves with the answer. */
function ask(request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(containerSock, () => s.write(request));
    sockets.push(s);
    s.on("data", (d) => resolve(d.toString()));
    s.on("error", reject);
    s.on("close", () => resolve(""));
  });
}

describe("hostAgentProblem", () => {
  it("explains a missing or wrong SSH_AUTH_SOCK", () => {
    expect(hostAgentProblem(undefined)).toBe("SSH_AUTH_SOCK is not set on this machine");
    expect(hostAgentProblem(path.join(dir, "nope"))).toMatch(/does not exist/);
    fs.writeFileSync(path.join(dir, "file"), "");
    expect(hostAgentProblem(path.join(dir, "file"))).toMatch(/is not a socket/);
    expect(hostAgentProblem(hostSock)).toBeUndefined();
  });
});

describe("AgentTunnel", () => {
  it("forwards a container client to the host agent", async () => {
    const { t, last, logs } = tunnel();
    t.start();
    await vi.waitFor(() => expect(last()).toEqual({ state: "forwarded" }));
    expect(logs).toContain("ssh-agent: forwarded");
    expect(await ask("list")).toBe("agent:list");
  });

  it("serves concurrent clients separately", async () => {
    const { t, last } = tunnel();
    t.start();
    await vi.waitFor(() => expect(last()?.state).toBe("forwarded"));
    expect(await Promise.all([ask("one"), ask("two"), ask("three")])).toEqual(["agent:one", "agent:two", "agent:three"]);
  });

  it("does not connect without SSH_AUTH_SOCK", async () => {
    const { t, last, logs } = tunnel(relay.port, () => undefined);
    t.start();
    expect(last()).toEqual({ state: "unavailable", reason: "SSH_AUTH_SOCK is not set on this machine" });
    expect(logs).toContain("ssh-agent: unavailable (SSH_AUTH_SOCK is not set on this machine)");
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(containerSock)).toBe(false);
  });

  it("leaves the client to time out and logs once when the host agent is gone", async () => {
    const { t, last, logs } = tunnel();
    t.start();
    await vi.waitFor(() => expect(last()?.state).toBe("forwarded"));
    await new Promise((r) => hostAgent.close(r));
    fs.rmSync(hostSock, { force: true });
    expect(await ask("list")).toBe("");
    expect(await ask("again")).toBe("");
    expect(logs.filter((l) => l.includes("can't reach the agent on this machine"))).toHaveLength(1);
    hostAgent = await startHostAgent();
  }, 15_000);

  it("reconnects after the relay restarts and reports the gap", async () => {
    const { t, last, onRelayLost } = tunnel();
    t.start();
    await vi.waitFor(() => expect(last()?.state).toBe("forwarded"));
    const port = relay.port;
    await relay.stop();
    await vi.waitFor(() => expect(last()?.state).toBe("unavailable"));
    await vi.waitFor(() => expect(onRelayLost).toHaveBeenCalled());
    relay = await startRelay("secret", { ODH_AGENT_SOCK: containerSock, ODH_RELAY_PORT: String(port) });
    await vi.waitFor(() => expect(last()?.state).toBe("forwarded"), { timeout: 3000 });
    expect(await ask("back")).toBe("agent:back");
  });

  it("stop closes the control connection, so the relay removes the socket", async () => {
    const { t, last, statuses } = tunnel();
    t.start();
    await vi.waitFor(() => expect(last()?.state).toBe("forwarded"));
    const count = statuses.length;
    t.stop();
    await vi.waitFor(() => expect(fs.existsSync(containerSock)).toBe(false), { timeout: 4000 });
    expect(statuses).toHaveLength(count);
  });
});
