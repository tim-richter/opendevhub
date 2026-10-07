# Git Identity and ssh-agent Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every container opendevhub runs (main and task environments) gets the host's git identity, `known_hosts` entries for the project's ssh remotes, and the host's ssh-agent forwarded through the relay, so `git commit`, `git fetch` and `git push` work inside containers.

**Architecture:** The in-container relay gains two header verbs. `agent-listen` opens a control connection and makes the relay serve a unix socket at `/tmp/opendevhub-ssh-agent.sock`. `agent-accept <id>` pipes one container client to opendevhub, which connects it to the host's `$SSH_AUTH_SOCK`. A host-side `AgentTunnel` per environment keeps the control connection open. A `Credentials` service sets the git identity, `known_hosts` and `core.sshCommand` in the container. The orchestrator runs both after the relay step and before opencode starts, and launches opencode with `SSH_AUTH_SOCK`.

**Tech Stack:** TypeScript (Node ≥ 20, ESM), `node:net` unix sockets, vitest, React and Tailwind/shadcn for the badge.

**Spec:** `docs/superpowers/specs/2026-10-05-git-ssh-credentials-design.md`

## Global Constraints

- Socket in the container: `/tmp/opendevhub-ssh-agent.sock`, mode `0600`.
- git's ssh command opendevhub sets: `ssh -o IdentityAgent=/tmp/opendevhub-ssh-agent.sock`, only when `core.sshCommand` is unset, and removed only when it still has exactly this value.
- `sshAgent` setting: boolean, default `true`. `config.json` `projects[path].sshAgent` takes precedence over `customizations.opendevhub.sshAgent`. Non-booleans are ignored.
- Identity is never overwritten: a key is only set when `git config --global --get <key>` is empty in the container.
- known_hosts: only lines the host already has (`ssh-keygen -F`). No `accept-new`, no built-in keys.
- Values (name, email, known_hosts lines) reach the container through `--remote-env`, never interpolated into shell scripts.
- Relay script constraints still hold: CommonJS; only `node:net`, `node:crypto` and `node:fs`; **no single quotes**. It lives in a TS template literal, so `\n` inside JS strings is written `\\n` in the TS source.
- Unaccepted agent clients are closed after 5 s. The listener and socket are removed 2 s after the control connection drops, if no new one arrives.
- The gateway relay (`ODH_RELAY_REMOTE=1`) rejects both agent verbs.
- None of this may fail bring-up. Every step logs one line to the environment's log.

## Review Focus

- A container that already has `user.name` but no `user.email` should get only the email; the name stays. (Task 4: real-shell identity script test.)
- A name with a quote or non-ASCII characters (`Tim O'Brien`, `Zoë`) should be stored verbatim. (Task 4: real-shell identity script test.)
- Two ssh clients in the container at once (git fetching while the agent runs `ssh-add -l`) should each get their own answer. (Task 2: concurrent clients; Task 3: concurrent round trips.)
- A relay that restarts while the tunnel is up (relay recovery, container restart) should get the socket back without user action. (Task 3: reconnect test.)
- An `ssh://git@host:2222/...` remote should be looked up as `[host]:2222` in known_hosts, and a project with its own `core.sshCommand` should keep it, including after forwarding is turned off. (Task 4: `sshHosts` and sshCommand script tests.)

---

### Task 1: The `sshAgent` setting and runtime fields

**Files:**

- Modify: `src/server/env-config.ts:15-38` (`EnvSettings`, `resolveEnvSettings`)
- Modify: `src/shared/types.ts:48-66` (`ProjectRuntime`)
- Test: `test/server/env-config.test.ts:25-37`

**Interfaces:**

- Produces: `EnvSettings.sshAgent: boolean`; `type SshAgentState = "forwarded" | "off" | "unavailable"` exported from `src/shared/types.ts`; `ProjectRuntime.sshAgent?: SshAgentState` and `ProjectRuntime.sshAgentReason?: string`. These are not persisted, because `DURABLE_KEYS` in `state.ts` stays unchanged, and they are public (`PublicRuntime` only omits password and relayToken).

- [ ] **Step 1: Write the failing tests**

Replace the `resolveEnvSettings` describe block in `test/server/env-config.test.ts` with:

```ts
describe("resolveEnvSettings", () => {
  it("defaults to shared with no key files and the ssh-agent forwarded", () => {
    expect(resolveEnvSettings(undefined, undefined)).toEqual({
      isolation: "shared",
      keyFiles: [],
      sshAgent: true,
    });
  });
  it("reads the devcontainer customization, and the config.json override wins", () => {
    expect(
      resolveEnvSettings(
        { isolation: "isolated", keyFiles: ["package-lock.json"] },
        undefined
      )
    ).toEqual({
      isolation: "isolated",
      keyFiles: ["package-lock.json"],
      sshAgent: true,
    });
    expect(
      resolveEnvSettings({ isolation: "isolated" }, { isolation: "shared" })
        .isolation
    ).toBe("shared");
    expect(
      resolveEnvSettings({ keyFiles: ["a"] }, { keyFiles: ["b"] }).keyFiles
    ).toEqual(["b"]);
  });
  it("turns the ssh-agent off from either place, config.json first", () => {
    expect(resolveEnvSettings({ sshAgent: false }, undefined).sshAgent).toBe(
      false
    );
    expect(resolveEnvSettings(undefined, { sshAgent: false }).sshAgent).toBe(
      false
    );
    expect(
      resolveEnvSettings({ sshAgent: false }, { sshAgent: true }).sshAgent
    ).toBe(true);
    expect(
      resolveEnvSettings({ sshAgent: true }, { sshAgent: false }).sshAgent
    ).toBe(false);
  });
  it("ignores invalid values and unsafe key files", () => {
    expect(
      resolveEnvSettings(
        {
          isolation: "yes",
          keyFiles: ["ok.lock", "/etc/passwd", "../x", "-x", 3, "a b"],
          sshAgent: "no",
        },
        null
      )
    ).toEqual({
      isolation: "shared",
      keyFiles: ["ok.lock"],
      sshAgent: true,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/env-config.test.ts` Expected: FAIL. The `toEqual` checks miss `sshAgent`, and `sshAgent` is `undefined`.

- [ ] **Step 3: Implement**

In `src/server/env-config.ts`, extend the interface and the resolver:

```ts
export interface EnvSettings {
  isolation: Isolation;
  /** Files whose change invalidates the image, relative to the repository root. */
  keyFiles: string[];
  /** Forward the host's ssh-agent into the project's containers. */
  sshAgent: boolean;
}
```

```ts
export function resolveEnvSettings(
  custom: unknown,
  override: unknown
): EnvSettings {
  const c = record(custom);
  const o = record(override);
  const isolation =
    [o.isolation, c.isolation].find(
      (v): v is Isolation => v === "shared" || v === "isolated"
    ) ?? "shared";
  const files = Array.isArray(o.keyFiles)
    ? o.keyFiles
    : Array.isArray(c.keyFiles)
      ? c.keyFiles
      : [];
  const sshAgent =
    [o.sshAgent, c.sshAgent].find(
      (v): v is boolean => typeof v === "boolean"
    ) ?? true;
  return {
    isolation,
    keyFiles: files.filter(
      (f): f is string =>
        typeof f === "string" &&
        KEY_FILE.test(f) &&
        !f.split("/").includes("..")
    ),
    sshAgent,
  };
}
```

Update the doc comment on `Config.projects` in `src/server/config.ts` to read `{ isolation, keyFiles, sshAgent }`.

In `src/shared/types.ts`, add above `ProjectRuntime`:

```ts
/** Whether the host's ssh-agent reaches a container: forwarded, turned off for the project, or not working (see the reason). */
export type SshAgentState = "forwarded" | "off" | "unavailable";
```

and add to `ProjectRuntime` after `relay?`:

```ts
  sshAgent?: SshAgentState;
  sshAgentReason?: string;
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run test/server/env-config.test.ts && npm run typecheck` Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/env-config.ts src/server/config.ts src/shared/types.ts test/server/env-config.test.ts
git commit -m "feat: sshAgent setting and the ssh-agent state on runtimes"
```

---

### Task 2: Relay script agent verbs

**Files:**

- Modify: `src/server/relay/script.ts` (whole script)
- Modify: `src/server/relay/client.ts` (`pingRelay`)
- Modify: `test/server/relay-script.test.ts` (ping expectations)
- Create: `test/server/relay-agent.test.ts`

**Interfaces:**

- Produces: relay protocol verbs `<token> agent-listen` → `OK\n`, then `CONN <id>\n` lines; `<token> agent-accept <id>` → `OK\n` + pipe, or `ERR ENOENT\n`. The socket path comes from `ODH_AGENT_SOCK` (default `/tmp/opendevhub-ssh-agent.sock`). `ping` now answers `PONG 2\n`, and `pingRelay` only accepts `PONG 2`, so a relay from an older opendevhub (still answering `PONG`) counts as not running. `RelayRuntime` then kills it and launches the new script; the existing `start()` logic already does this when ping fails.

- [ ] **Step 1: Write the failing tests**

Create `test/server/relay-agent.test.ts`:

```ts
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
  for (const s of sockets.splice(0)) s.destroy();
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
      if (lines.length <= i) throw new Error(`waiting for line ${i}`);
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
    expect(await control.line(0)).toBe("OK");
    const stat = fs.statSync(sock);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("announces a client and pipes it to the connection that accepts it", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const client = agentClient();
    client.socket.write("request\n");
    const conn = await control.line(1);
    expect(conn).toMatch(/^CONN \d+$/);
    const accept = connect(`secret agent-accept ${conn.split(" ")[1]}\n`);
    expect(await accept.line(0)).toBe("OK");
    expect(await accept.line(1)).toBe("request");
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
      expect([a.received(), b.received()].sort()).toEqual(
        ids.map((id) => `for-${id}\n`).sort()
      )
    );
  });

  it("answers ERR ENOENT for an unknown id", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const accept = connect("secret agent-accept 999\n");
    expect(await accept.line(0)).toBe("ERR ENOENT");
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
    expect(await second.line(0)).toBe("OK");
    await first.closed;
    expect(await second.line(1)).toMatch(/^CONN \d+$/);
    expect(fs.existsSync(sock)).toBe(true);
  });

  it("removes the socket and drops pending clients 2 s after the control connection goes", async () => {
    const control = connect("secret agent-listen\n");
    await control.line(0);
    const client = agentClient();
    await control.line(1);
    control.socket.destroy();
    await vi.waitFor(() => expect(fs.existsSync(sock)).toBe(false), {
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
    expect(await again.line(0)).toBe("OK");
    await new Promise((r) => setTimeout(r, 2500));
    expect(fs.existsSync(sock)).toBe(true);
  });

  it("closes silently on a wrong token", async () => {
    const control = connect("nope agent-listen\n");
    await control.closed;
    expect(control.lines).toEqual([]);
    expect(fs.existsSync(sock)).toBe(false);
  });

  it("is refused by the gateway relay", async () => {
    const gateway = await startRelay("secret", {
      ODH_AGENT_SOCK: sock,
      ODH_RELAY_REMOTE: "1",
    });
    try {
      const control = connect("secret agent-listen\n", gateway.port);
      await control.closed;
      expect(control.lines).toEqual([]);
      expect(fs.existsSync(sock)).toBe(false);
    } finally {
      await gateway.stop();
    }
  });
});
```

In `test/server/relay-script.test.ts`, change both ping expectations (`"answers ping with PONG"` and the gateway one near line 121) from `"PONG\n"` to `"PONG 2\n"`, and rename the first test to `"answers ping with PONG and the protocol version"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/relay-agent.test.ts test/server/relay-script.test.ts` Expected: FAIL. The agent verbs close the connection silently, and ping returns `PONG`.

- [ ] **Step 3: Implement the script**

Replace `src/server/relay/script.ts` with the following. Lines marked new are the agent parts; the TCP relay is unchanged except for the header parsing order and `PONG 2`.

```ts
/**
 * Runs inside the container (Bun via `BUN_BE_BUN=1 <opencode> -e`, or Node) and relays TCP from
 * 0.0.0.0:$ODH_RELAY_PORT to the container's loopback. Protocol: see the container relay spec §3.
 * With ODH_RELAY_REMOTE=1 it is the gateway (see gateway.ts) and also accepts `<token> <ip> <port>`,
 * connecting to that IP instead of loopback.
 * `agent-listen` / `agent-accept <id>` forward the host's ssh-agent: the relay serves a unix socket at
 * $ODH_AGENT_SOCK and hands each client to opendevhub (see the git and ssh credentials spec §1).
 * Constraints: CommonJS, node:net/node:crypto/node:fs only, no single quotes (it is shell-quoted as one arg).
 */
export const RELAY_SCRIPT = `/*odh-relay*/
"use strict";
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const token = process.env.ODH_RELAY_TOKEN || "";
const port = Number(process.env.ODH_RELAY_PORT || "4097");
const remote = process.env.ODH_RELAY_REMOTE === "1";
const agentPath = process.env.ODH_AGENT_SOCK || "/tmp/opendevhub-ssh-agent.sock";
if (!token) {
  console.error("odh-relay: ODH_RELAY_TOKEN is not set");
  process.exit(2);
}
const expected = Buffer.from(token);
function tokenOk(candidate) {
  const b = Buffer.from(candidate);
  return b.length === expected.length && crypto.timingSafeEqual(b, expected);
}
function connectTo(hosts, target, done) {
  const codes = [];
  const attempt = (i) => {
    if (i >= hosts.length) {
      return done(codes.includes("ECONNREFUSED") ? "ECONNREFUSED" : codes[codes.length - 1] || "EUNKNOWN");
    }
    const s = net.connect({ host: hosts[i], port: target, allowHalfOpen: true });
    const onError = (err) => {
      codes.push(err.code || "EUNKNOWN");
      s.destroy();
      attempt(i + 1);
    };
    s.once("error", onError);
    s.once("connect", () => {
      s.off("error", onError);
      done(null, s);
    });
  };
  attempt(0);
}
const agent = { server: null, control: null, closeTimer: null, nextId: 1, pending: new Map() };
function announce(id) {
  if (agent.control) agent.control.write("CONN " + id + "\\n");
}
function closeAgent() {
  if (agent.server) {
    agent.server.close();
    agent.server = null;
    try { fs.unlinkSync(agentPath); } catch (e) {}
  }
  for (const p of agent.pending.values()) {
    clearTimeout(p.timer);
    p.client.destroy();
  }
  agent.pending.clear();
}
function onAgentClient(c) {
  if (!agent.control) return c.destroy();
  const id = agent.nextId++;
  c.pause();
  c.on("error", () => c.destroy());
  const timer = setTimeout(() => {
    agent.pending.delete(id);
    c.destroy();
  }, 5000);
  agent.pending.set(id, { client: c, timer });
  c.once("close", () => {
    const p = agent.pending.get(id);
    if (p && p.client === c) {
      clearTimeout(timer);
      agent.pending.delete(id);
    }
  });
  announce(id);
}
function listenAgent(conn) {
  if (agent.closeTimer) {
    clearTimeout(agent.closeTimer);
    agent.closeTimer = null;
  }
  const previous = agent.control;
  agent.control = conn;
  if (previous) previous.destroy();
  conn.on("error", () => conn.destroy());
  conn.on("data", () => {});
  conn.on("close", () => {
    if (agent.control !== conn) return;
    agent.control = null;
    agent.closeTimer = setTimeout(() => {
      agent.closeTimer = null;
      if (!agent.control) closeAgent();
    }, 2000);
  });
  conn.resume();
  const ready = () => {
    conn.write("OK\\n");
    for (const id of agent.pending.keys()) announce(id);
  };
  if (agent.server) return ready();
  try { fs.unlinkSync(agentPath); } catch (e) {}
  const server = net.createServer({ allowHalfOpen: true }, onAgentClient);
  agent.server = server;
  const umask = process.umask(0o177);
  server.on("error", (err) => {
    process.umask(umask);
    console.error("odh-relay: agent socket: " + err.message);
    if (agent.server === server) agent.server = null;
    conn.end("ERR " + (err.code || "EUNKNOWN") + "\\n");
  });
  server.listen(agentPath, () => {
    process.umask(umask);
    try { fs.chmodSync(agentPath, 0o600); } catch (e) {}
    if (agent.control === conn) ready();
  });
}
function acceptAgent(conn, idArg, rest) {
  const id = /^[0-9]+$/.test(idArg) ? Number(idArg) : -1;
  const p = agent.pending.get(id);
  if (!p) return conn.end("ERR ENOENT\\n");
  clearTimeout(p.timer);
  agent.pending.delete(id);
  const c = p.client;
  const close = () => {
    c.destroy();
    conn.destroy();
  };
  c.on("close", close);
  conn.on("close", close);
  conn.on("error", close);
  conn.write("OK\\n");
  if (rest.length) c.write(rest);
  c.pipe(conn);
  conn.pipe(c);
  c.resume();
  conn.resume();
}
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => client.destroy(), 5000);
  client.on("error", () => client.destroy());
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(10);
    if (nl === -1 || nl > 256) {
      if (nl > 256 || buf.length > 256) {
        clearTimeout(timer);
        client.destroy();
      }
      return;
    }
    clearTimeout(timer);
    client.off("data", onData);
    client.pause();
    const parts = buf.subarray(0, nl).toString("utf8").trim().split(" ");
    const rest = buf.subarray(nl + 1);
    if (parts.length < 2 || !tokenOk(parts[0])) return client.destroy();
    if (parts[1] === "agent-listen" || parts[1] === "agent-accept") {
      if (remote) return client.destroy();
      if (parts[1] === "agent-listen" && parts.length === 2) return listenAgent(client);
      if (parts[1] === "agent-accept" && parts.length === 3) return acceptAgent(client, parts[2], rest);
      return client.destroy();
    }
    if (parts.length > (remote ? 3 : 2)) return client.destroy();
    if (parts.length === 2 && parts[1] === "ping") return client.end("PONG 2\\n");
    const hosts = parts.length === 3 ? [parts[1]] : ["127.0.0.1", "::1"];
    if (parts.length === 3 && !net.isIP(parts[1])) return client.destroy();
    const portArg = parts[parts.length - 1];
    if (!/^[0-9]+$/.test(portArg)) return client.destroy();
    const target = Number(portArg);
    if (target < 1 || target > 65535) return client.destroy();
    connectTo(hosts, target, (code, upstream) => {
      if (code) return client.end("ERR " + code + "\\n");
      if (client.destroyed) return upstream.destroy();
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("error", close);
      upstream.on("close", close);
      client.on("close", close);
      client.write("OK\\n");
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  };
  client.on("data", onData);
});
server.on("error", (err) => {
  console.error("odh-relay: " + err.message);
  process.exit(1);
});
server.listen(port, "0.0.0.0", () => console.log("odh-relay listening on " + port));
`;
```

Before replacing, compare against the current file and keep any TCP-relay line this listing differs on, except the three intended changes: the `fs` require and agent functions, the header parse order, and `PONG 2`.

In `src/server/relay/client.ts`, `pingRelay`:

```ts
/** The relay's answer to ping; older relays answer a bare PONG and are replaced (they have no agent verbs). */
const PONG = "PONG 2";

export async function pingRelay(
  target: RelayTarget,
  timeoutMs = 1000
): Promise<boolean> {
  try {
    const { socket, reply } = await handshake(
      target,
      `${target.token} ping\n`,
      timeoutMs
    );
    socket.destroy();
    return reply === PONG;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the relay tests**

Run: `npx vitest run test/server/relay-agent.test.ts test/server/relay-script.test.ts test/server/relay-client.test.ts test/server/relay-runtime.test.ts test/server/gateway.test.ts` Expected: PASS. The first `RELAY_SCRIPT` test also checks that the script is still single-quote free.

- [ ] **Step 5: Commit**

```bash
git add src/server/relay/script.ts src/server/relay/client.ts test/server/relay-agent.test.ts test/server/relay-script.test.ts
git commit -m "feat: relay serves a forwarded ssh-agent socket (agent-listen, agent-accept)"
```

---

### Task 3: Host-side `AgentTunnel`

**Files:**

- Modify: `src/server/relay/client.ts` (add `openAgentControl`, `acceptAgentConnection`)
- Create: `src/server/relay/agent.ts`
- Create: `test/server/agent-tunnel.test.ts`

**Interfaces:**

- Consumes: relay verbs from Task 2; `RelayTarget { host: string; port: number; token: string }` from `client.ts`; `SshAgentState` from Task 1.
- Produces:
  - `openAgentControl(target: RelayTarget, timeoutMs?: number): Promise<{ socket: net.Socket; rest: Buffer }>`
  - `acceptAgentConnection(target: RelayTarget, id: number, timeoutMs?: number): Promise<net.Socket>`
  - `AGENT_SOCKET = "/tmp/opendevhub-ssh-agent.sock"`
  - `AGENT_SSH_COMMAND = "ssh -o IdentityAgent=/tmp/opendevhub-ssh-agent.sock"`
  - `interface AgentStatus { state: "forwarded" | "unavailable"; reason?: string }`
  - `interface AgentTunnelOptions { onLog(line: string): void; onStatus(status: AgentStatus): void; onRelayLost?(): void; hostSocket?(): string | undefined; retryMinMs?: number; retryMaxMs?: number; now?(): number }`
  - `class AgentTunnel { constructor(target: RelayTarget, opts: AgentTunnelOptions); start(): void; stop(): void }`
  - `hostAgentProblem(path: string | undefined): string | undefined`

- [ ] **Step 1: Write the failing tests**

Create `test/server/agent-tunnel.test.ts`:

```ts
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentStatus,
  AgentTunnel,
  hostAgentProblem,
} from "../../src/server/relay/agent";
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

function tunnel(
  port = relay.port,
  hostSocket: () => string | undefined = () => hostSock
) {
  const statuses: AgentStatus[] = [];
  const logs: string[] = [];
  const onRelayLost = vi.fn();
  const t = new AgentTunnel(
    { host: "127.0.0.1", port, token: "secret" },
    {
      onLog: (l) => logs.push(l),
      onStatus: (s) => statuses.push(s),
      onRelayLost,
      hostSocket,
      retryMinMs: 50,
      retryMaxMs: 200,
    }
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
    expect(hostAgentProblem(undefined)).toBe(
      "SSH_AUTH_SOCK is not set on this machine"
    );
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
    expect(await Promise.all([ask("one"), ask("two"), ask("three")])).toEqual([
      "agent:one",
      "agent:two",
      "agent:three",
    ]);
  });

  it("does not connect without SSH_AUTH_SOCK", async () => {
    const { t, last, logs } = tunnel(relay.port, () => undefined);
    t.start();
    expect(last()).toEqual({
      state: "unavailable",
      reason: "SSH_AUTH_SOCK is not set on this machine",
    });
    expect(logs).toContain(
      "ssh-agent: unavailable (SSH_AUTH_SOCK is not set on this machine)"
    );
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
    expect(
      logs.filter((l) => l.includes("can't reach the agent on this machine"))
    ).toHaveLength(1);
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
    relay = await startRelay("secret", {
      ODH_AGENT_SOCK: containerSock,
      ODH_RELAY_PORT: String(port),
    });
    await vi.waitFor(() => expect(last()?.state).toBe("forwarded"), {
      timeout: 3000,
    });
    expect(await ask("back")).toBe("agent:back");
  });

  it("stop closes the control connection, so the relay removes the socket", async () => {
    const { t, last, statuses } = tunnel();
    t.start();
    await vi.waitFor(() => expect(last()?.state).toBe("forwarded"));
    const count = statuses.length;
    t.stop();
    await vi.waitFor(() => expect(fs.existsSync(containerSock)).toBe(false), {
      timeout: 4000,
    });
    expect(statuses).toHaveLength(count);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/agent-tunnel.test.ts` Expected: FAIL, because `../../src/server/relay/agent` does not exist.

- [ ] **Step 3: Add the client handshakes**

Append to `src/server/relay/client.ts`:

```ts
/** Opens the relay's agent control connection; resolves after OK with the socket paused and any bytes that came along. */
export async function openAgentControl(
  target: RelayTarget,
  timeoutMs = 5000
): Promise<{ socket: net.Socket; rest: Buffer }> {
  const { socket, reply, rest } = await handshake(
    target,
    `${target.token} agent-listen\n`,
    timeoutMs
  );
  if (reply === "OK") return { socket, rest };
  socket.destroy();
  throw new RelayError(reply.startsWith("ERR ") ? reply.slice(4) : "EPROTO");
}

/** Takes the container client the relay announced as `CONN <id>`; the socket is returned paused, ready to pipe. */
export async function acceptAgentConnection(
  target: RelayTarget,
  id: number,
  timeoutMs = 5000
): Promise<net.Socket> {
  const { socket, reply, rest } = await handshake(
    target,
    `${target.token} agent-accept ${id}\n`,
    timeoutMs
  );
  if (reply !== "OK") {
    socket.destroy();
    throw new RelayError(reply.startsWith("ERR ") ? reply.slice(4) : "EPROTO");
  }
  if (rest.length) socket.unshift(rest);
  return socket;
}
```

- [ ] **Step 4: Implement `AgentTunnel`**

Create `src/server/relay/agent.ts`:

```ts
import fs from "node:fs";
import net from "node:net";

import type { SshAgentState } from "../../shared/types";
import {
  type RelayTarget,
  acceptAgentConnection,
  openAgentControl,
} from "./client";

/** Where the relay serves the forwarded agent inside the container. */
export const AGENT_SOCKET = "/tmp/opendevhub-ssh-agent.sock";
/** git's ssh command in containers with forwarding on; opendevhub only removes the setting when it still has this value. */
export const AGENT_SSH_COMMAND = `ssh -o IdentityAgent=${AGENT_SOCKET}`;

export interface AgentStatus {
  state: Exclude<SshAgentState, "off">;
  reason?: string;
}

export interface AgentTunnelOptions {
  onLog: (line: string) => void;
  onStatus: (status: AgentStatus) => void;
  /** The control connection couldn't be opened: the relay may be gone. */
  onRelayLost?: () => void;
  /** The host agent's socket, read on every use; defaults to SSH_AUTH_SOCK. */
  hostSocket?: () => string | undefined;
  retryMinMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

const WARN_INTERVAL_MS = 60_000;

/** Why the host's agent can't be forwarded; undefined when SSH_AUTH_SOCK is a socket. */
export function hostAgentProblem(
  socketPath: string | undefined
): string | undefined {
  if (!socketPath) return "SSH_AUTH_SOCK is not set on this machine";
  try {
    return fs.statSync(socketPath).isSocket()
      ? undefined
      : `SSH_AUTH_SOCK (${socketPath}) is not a socket`;
  } catch {
    return `SSH_AUTH_SOCK (${socketPath}) does not exist`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function connectUnix(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once("error", reject);
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
  });
}

/**
 * Keeps one environment's agent control connection open and pipes each container client the relay
 * announces to the host's ssh-agent. Reconnects with backoff until stopped.
 */
export class AgentTunnel {
  private stopped = false;
  private control?: net.Socket;
  private timer?: NodeJS.Timeout;
  private delay: number;
  private readonly pipes = new Set<net.Socket>();
  private lastWarn = -Infinity;
  private status?: string;

  constructor(
    private readonly target: RelayTarget,
    private readonly opts: AgentTunnelOptions
  ) {
    this.delay = opts.retryMinMs ?? 1000;
  }

  start(): void {
    const problem = hostAgentProblem(this.hostSocket());
    if (problem) {
      this.setStatus({ state: "unavailable", reason: problem });
      return;
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.control?.destroy();
    this.control = undefined;
    for (const s of this.pipes) s.destroy();
    this.pipes.clear();
  }

  private hostSocket(): string | undefined {
    return (
      (this.opts.hostSocket ?? (() => process.env.SSH_AUTH_SOCK))() || undefined
    );
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private setStatus(status: AgentStatus): void {
    if (this.stopped) return;
    const key = `${status.state}:${status.reason ?? ""}`;
    if (key === this.status) return;
    this.status = key;
    this.opts.onStatus(status);
    this.opts.onLog(
      status.state === "forwarded"
        ? "ssh-agent: forwarded"
        : `ssh-agent: unavailable (${status.reason})`
    );
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let socket: net.Socket;
    let rest: Buffer;
    try {
      ({ socket, rest } = await openAgentControl(this.target));
    } catch (err) {
      this.setStatus({
        state: "unavailable",
        reason: `relay: ${message(err)}`,
      });
      this.opts.onRelayLost?.();
      this.retry();
      return;
    }
    if (this.stopped) {
      socket.destroy();
      return;
    }
    this.control = socket;
    this.delay = this.opts.retryMinMs ?? 1000;
    this.setStatus({ state: "forwarded" });
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const m = /^CONN (\d+)$/.exec(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
        if (m) void this.accept(Number(m[1]));
      }
      if (buf.length > 256) socket.destroy();
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.control === socket) this.control = undefined;
      if (this.stopped) return;
      this.setStatus({
        state: "unavailable",
        reason: "lost the relay connection; reconnecting",
      });
      this.retry();
    });
    if (rest.length) onData(rest);
    socket.resume();
  }

  private retry(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.opts.retryMaxMs ?? 30_000);
  }

  /** Pipes the announced client to the host agent; when the agent can't be reached the relay's 5 s timeout closes the client. */
  private async accept(id: number): Promise<void> {
    let local: net.Socket;
    try {
      const socketPath = this.hostSocket();
      if (!socketPath) throw new Error("SSH_AUTH_SOCK is not set");
      local = await connectUnix(socketPath);
    } catch (err) {
      this.warn(
        `ssh-agent: can't reach the agent on this machine (${message(err)})`
      );
      return;
    }
    let remote: net.Socket;
    try {
      remote = await acceptAgentConnection(this.target, id);
    } catch {
      local.destroy();
      return;
    }
    if (this.stopped) {
      local.destroy();
      remote.destroy();
      return;
    }
    this.pipes.add(local);
    this.pipes.add(remote);
    const close = () => {
      local.destroy();
      remote.destroy();
      this.pipes.delete(local);
      this.pipes.delete(remote);
    };
    for (const s of [local, remote]) {
      s.on("error", close);
      s.on("close", close);
    }
    local.pipe(remote);
    remote.pipe(local);
    remote.resume();
  }

  private warn(line: string): void {
    const now = this.now();
    if (now - this.lastWarn < WARN_INTERVAL_MS) return;
    this.lastWarn = now;
    this.opts.onLog(line);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/server/agent-tunnel.test.ts test/server/relay-client.test.ts` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/relay/agent.ts src/server/relay/client.ts test/server/agent-tunnel.test.ts
git commit -m "feat: AgentTunnel pipes container ssh-agent clients to the host agent through the relay"
```

---

### Task 4: `Credentials`: identity, known_hosts and `core.sshCommand`

**Files:**

- Create: `src/server/credentials.ts`
- Modify: `src/server/git.ts:10-11` (`IDENTITY_HINT` wording)
- Create: `test/server/credentials.test.ts`

**Interfaces:**

- Consumes: `AGENT_SSH_COMMAND` from `src/server/relay/agent.ts` (Task 3); `Containers.exec(target, command, { env, timeoutMs })` (passes each env entry as `--remote-env K=V`); `Runner` from `exec.ts`.
- Produces:
  - `sshHosts(remotes: string): string[]`
  - `IDENTITY_SCRIPT`, `KNOWN_HOSTS_SCRIPT`, `SSH_COMMAND_ON`, `SSH_COMMAND_OFF` (exported for tests)
  - `interface GitIdentity { name?: string; email?: string }`
  - `class Credentials { constructor(deps: { run: Runner; containers: Pick<Containers, "exec">; knownHostsFile?: string }); prepare(target: ExecTarget, projectPath: string, opts: { sshAgent: boolean; onLine: (line: string) => void }): Promise<void>; hostIdentity(projectPath: string): Promise<GitIdentity>; hostKnownHosts(host: string): Promise<string[]> }`. `prepare` never throws.

- [ ] **Step 1: Write the failing tests**

Create `test/server/credentials.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Containers } from "../../src/server/containers";
import {
  Credentials,
  IDENTITY_SCRIPT,
  KNOWN_HOSTS_SCRIPT,
  SSH_COMMAND_OFF,
  SSH_COMMAND_ON,
  sshHosts,
} from "../../src/server/credentials";
import { AGENT_SSH_COMMAND } from "../../src/server/relay/agent";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer.json",
};

describe("sshHosts", () => {
  it("names ssh remotes as known_hosts does and skips the rest", () => {
    const remotes = [
      "origin\tgit@github.com:a/b.git (fetch)",
      "origin\tgit@github.com:a/b.git (push)",
      "fork\tssh://git@git.example.com:2222/a/b.git (fetch)",
      "std\tssh://git@codeberg.org:22/a/b.git (fetch)",
      "plus\tgit+ssh://gitlab.com/a/b (fetch)",
      "web\thttps://github.com/a/b.git (fetch)",
      "local\t/srv/repos/b.git (fetch)",
      "rel\t../b (fetch)",
      "alias\twork:team/app.git (fetch)",
    ].join("\n");
    expect(sshHosts(remotes)).toEqual([
      "github.com",
      "[git.example.com]:2222",
      "codeberg.org",
      "gitlab.com",
      "work",
    ]);
  });
});

/** Runs a container script with real sh and git against a throwaway HOME. */
function sh(script: string, home: string, env: Record<string, string>) {
  return spawnSync("sh", ["-c", script], {
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    },
    encoding: "utf8",
  });
}
const git = (home: string, ...args: string[]) =>
  spawnSync("git", args, {
    env: { HOME: home, PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  }).stdout.trim();
const hasSshKeygen =
  spawnSync("sh", ["-c", "command -v ssh-keygen"]).status === 0;

describe("container scripts (real sh and git)", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "odh-home-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("sets the identity verbatim when the container has none", () => {
    const r = sh(IDENTITY_SCRIPT, home, {
      ODH_GIT_NAME: "Tim O'Brien Zoë",
      ODH_GIT_EMAIL: "t@example.com",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("set");
    expect(git(home, "config", "--global", "user.name")).toBe(
      "Tim O'Brien Zoë"
    );
    expect(git(home, "config", "--global", "user.email")).toBe("t@example.com");
  });

  it("only fills in what is missing", () => {
    git(home, "config", "--global", "user.name", "Container Name");
    sh(IDENTITY_SCRIPT, home, {
      ODH_GIT_NAME: "Host Name",
      ODH_GIT_EMAIL: "h@example.com",
    });
    expect(git(home, "config", "--global", "user.name")).toBe("Container Name");
    expect(git(home, "config", "--global", "user.email")).toBe("h@example.com");
  });

  it("reports nothing to do when both are set", () => {
    git(home, "config", "--global", "user.name", "A");
    git(home, "config", "--global", "user.email", "a@example.com");
    expect(
      sh(IDENTITY_SCRIPT, home, {
        ODH_GIT_NAME: "B",
        ODH_GIT_EMAIL: "b@example.com",
      }).stdout
    ).not.toContain("set");
  });

  it("sets core.sshCommand only when unset, and removes only its own", () => {
    const env = { ODH_SSH_COMMAND: AGENT_SSH_COMMAND };
    sh(SSH_COMMAND_ON, home, env);
    expect(git(home, "config", "--global", "core.sshCommand")).toBe(
      AGENT_SSH_COMMAND
    );
    sh(SSH_COMMAND_OFF, home, env);
    expect(git(home, "config", "--global", "core.sshCommand")).toBe("");

    git(home, "config", "--global", "core.sshCommand", "ssh -i ~/.ssh/deploy");
    expect(sh(SSH_COMMAND_ON, home, env).stdout).toContain("kept");
    expect(sh(SSH_COMMAND_OFF, home, env).status).toBe(0);
    expect(git(home, "config", "--global", "core.sshCommand")).toBe(
      "ssh -i ~/.ssh/deploy"
    );
  });

  it.skipIf(!hasSshKeygen)(
    "adds known_hosts lines once, creating ~/.ssh with mode 700",
    () => {
      spawnSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        path.join(home, "hostkey"),
      ]);
      const key = fs
        .readFileSync(path.join(home, "hostkey.pub"), "utf8")
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" ");
      const line = `example.org ${key}`;
      const env = { ODH_HOST: "example.org", ODH_LINES: line };
      expect(sh(KNOWN_HOSTS_SCRIPT, home, env).stdout).toContain("added");
      expect(fs.statSync(path.join(home, ".ssh")).mode & 0o777).toBe(0o700);
      expect(sh(KNOWN_HOSTS_SCRIPT, home, env).stdout).not.toContain("added");
      expect(fs.readFileSync(path.join(home, ".ssh/known_hosts"), "utf8")).toBe(
        `${line}\n`
      );
    }
  );
});

describe("Credentials.prepare", () => {
  const remotes =
    "origin\tgit@github.com:a/b.git (fetch)\nfork\tssh://git@git.example.com:2222/a/b.git (fetch)\n";

  function setup(
    host: {
      name?: string;
      email?: string;
      known?: Record<string, string>;
    } = {},
    container: (c: Call) => { exitCode?: number; stdout?: string } = () => ({})
  ) {
    const { run, calls } = fakeRunner((c) => {
      if (c.cmd === "git" && c.args.includes("user.name"))
        return host.name ? { stdout: `${host.name}\n` } : { exitCode: 1 };
      if (c.cmd === "git" && c.args.includes("user.email"))
        return host.email ? { stdout: `${host.email}\n` } : { exitCode: 1 };
      if (c.cmd === "git" && c.args.includes("remote"))
        return { stdout: remotes };
      if (c.cmd === "ssh-keygen") {
        const line = host.known?.[c.args[1]];
        return line
          ? { stdout: `# Host ${c.args[1]} found: line 3\n${line}\n` }
          : { exitCode: 1 };
      }
      if (c.cmd === "devcontainer") return container(c);
      return {};
    });
    const lines: string[] = [];
    const credentials = new Credentials({
      run,
      containers: new Containers(run),
      knownHostsFile: "/home/me/.ssh/known_hosts",
    });
    const prepare = (sshAgent = true) =>
      credentials.prepare(project, project.path, {
        sshAgent,
        onLine: (l) => lines.push(l),
      });
    const execs = () => calls.filter((c) => c.cmd === "devcontainer");
    const envOf = (c: Call) =>
      c.args.filter((_, i) => c.args[i - 1] === "--remote-env");
    return { prepare, calls, lines, execs, envOf };
  }

  it("reads the identity in the project folder and passes it through the environment", async () => {
    const s = setup({ name: "Tim Richter", email: "tim@example.com" }, (c) =>
      c.args.at(-1) === IDENTITY_SCRIPT ? { stdout: "set\n" } : {}
    );
    await s.prepare();
    expect(s.calls.find((c) => c.args.includes("user.name"))?.args).toEqual([
      "-C",
      "/src/demo",
      "config",
      "--get",
      "user.name",
    ]);
    const identity = s.execs().find((c) => c.args.at(-1) === IDENTITY_SCRIPT)!;
    expect(s.envOf(identity)).toEqual([
      "ODH_GIT_NAME=Tim Richter",
      "ODH_GIT_EMAIL=tim@example.com",
    ]);
    expect(identity.args.at(-1)).not.toContain("Tim");
    expect(s.lines).toContain(
      "git: identity set (Tim Richter <tim@example.com>)"
    );
  });

  it("says so when this machine has no identity, and touches nothing", async () => {
    const s = setup();
    await s.prepare();
    expect(s.lines).toContain(
      "git: no user.name/user.email on this machine; commits in the container will fail"
    );
    expect(s.execs().some((c) => c.args.at(-1) === IDENTITY_SCRIPT)).toBe(
      false
    );
  });

  it("reports a container without git", async () => {
    const s = setup({ name: "T", email: "t@e" }, (c) =>
      c.args.at(-1) === IDENTITY_SCRIPT ? { stdout: "no-git\n" } : {}
    );
    await s.prepare();
    expect(s.lines).toContain("git: not found in the container");
  });

  it("copies known_hosts lines for ssh remotes the host knows, looking up ports as [host]:port", async () => {
    const s = setup(
      {
        known: {
          "github.com": "github.com ssh-ed25519 AAAA1",
          "[git.example.com]:2222": "[git.example.com]:2222 ssh-ed25519 AAAA2",
        },
      },
      (c) => (c.args.at(-1) === KNOWN_HOSTS_SCRIPT ? { stdout: "added\n" } : {})
    );
    await s.prepare();
    expect(
      s.calls.filter((c) => c.cmd === "ssh-keygen").map((c) => c.args)
    ).toEqual([
      ["-F", "github.com", "-f", "/home/me/.ssh/known_hosts"],
      ["-F", "[git.example.com]:2222", "-f", "/home/me/.ssh/known_hosts"],
    ]);
    const known = s
      .execs()
      .filter((c) => c.args.at(-1) === KNOWN_HOSTS_SCRIPT)
      .map(s.envOf);
    expect(known).toEqual([
      ["ODH_HOST=github.com", "ODH_LINES=github.com ssh-ed25519 AAAA1"],
      [
        "ODH_HOST=[git.example.com]:2222",
        "ODH_LINES=[git.example.com]:2222 ssh-ed25519 AAAA2",
      ],
    ]);
    expect(s.lines).toContain(
      "ssh: added known_hosts for github.com, [git.example.com]:2222"
    );
  });

  it("hints at verifying a host this machine doesn't know", async () => {
    const s = setup({
      known: { "github.com": "github.com ssh-ed25519 AAAA1" },
    });
    await s.prepare();
    expect(s.lines).toContain(
      'ssh: git.example.com (port 2222) is not in known_hosts on this machine; run "ssh -p 2222 git.example.com" once to verify it'
    );
  });

  it("sets or removes git's ssh command with the agent setting", async () => {
    const on = setup();
    await on.prepare(true);
    expect(
      on.execs().find((c) => c.args.at(-1) === SSH_COMMAND_ON)
    ).toBeDefined();
    expect(
      on.envOf(on.execs().find((c) => c.args.at(-1) === SSH_COMMAND_ON)!)
    ).toEqual([`ODH_SSH_COMMAND=${AGENT_SSH_COMMAND}`]);
    const off = setup();
    await off.prepare(false);
    expect(
      off.execs().find((c) => c.args.at(-1) === SSH_COMMAND_OFF)
    ).toBeDefined();
    expect(off.execs().some((c) => c.args.at(-1) === SSH_COMMAND_ON)).toBe(
      false
    );
  });

  it("logs a project's own core.sshCommand", async () => {
    const s = setup({}, (c) =>
      c.args.at(-1) === SSH_COMMAND_ON ? { stdout: "kept\n" } : {}
    );
    await s.prepare();
    expect(s.lines).toContain(
      "git: the container sets its own core.sshCommand; leaving it as is"
    );
  });

  it("never throws: a failing step is logged and the next one still runs", async () => {
    const s = setup({ name: "T", email: "t@e" }, (c) =>
      c.args.at(-1) === IDENTITY_SCRIPT ? { exitCode: 1, stdout: "boom" } : {}
    );
    await expect(s.prepare()).resolves.toBeUndefined();
    expect(
      s.lines.some((l) =>
        l.startsWith("credentials: could not set the git identity")
      )
    ).toBe(true);
    expect(s.execs().some((c) => c.args.at(-1) === SSH_COMMAND_ON)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/credentials.test.ts` Expected: FAIL, because `../../src/server/credentials` does not exist.

- [ ] **Step 3: Implement**

Create `src/server/credentials.ts`:

```ts
import os from "node:os";
import path from "node:path";

import { type Containers, type ExecTarget, tailLines } from "./containers";
import type { Runner } from "./exec";
import { AGENT_SSH_COMMAND } from "./relay/agent";

const HOST_TIMEOUT_MS = 10_000;
const CONTAINER_TIMEOUT_MS = 30_000;

export interface GitIdentity {
  name?: string;
  email?: string;
}

/** Sets user.name / user.email globally for the remote user, each only when the container has none. Prints `set` when it wrote one. */
export const IDENTITY_SCRIPT = `command -v git >/dev/null 2>&1 || { echo no-git; exit 0; }
if [ -n "$ODH_GIT_NAME" ] && [ -z "$(git config --global --get user.name)" ]; then git config --global user.name "$ODH_GIT_NAME" && echo set; fi
if [ -n "$ODH_GIT_EMAIL" ] && [ -z "$(git config --global --get user.email)" ]; then git config --global user.email "$ODH_GIT_EMAIL" && echo set; fi
exit 0`;

/** Appends $ODH_LINES to ~/.ssh/known_hosts unless $ODH_HOST is already known there. Prints `added` when it wrote. */
export const KNOWN_HOSTS_SCRIPT = `mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || exit 1
f="$HOME/.ssh/known_hosts"
if command -v ssh-keygen >/dev/null 2>&1; then
  [ -f "$f" ] && ssh-keygen -F "$ODH_HOST" -f "$f" >/dev/null 2>&1 && exit 0
  printf "%s\\n" "$ODH_LINES" >> "$f" && echo added
  exit 0
fi
printf "%s\\n" "$ODH_LINES" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  grep -qxF -- "$line" "$f" 2>/dev/null || { printf "%s\\n" "$line" >> "$f" && echo added; }
done
exit 0`;

/** Points git's ssh at the forwarded agent unless the container has its own core.sshCommand (then prints `kept`). */
export const SSH_COMMAND_ON = `command -v git >/dev/null 2>&1 || exit 0
current="$(git config --global --get core.sshCommand)"
if [ -z "$current" ]; then git config --global core.sshCommand "$ODH_SSH_COMMAND"
elif [ "$current" != "$ODH_SSH_COMMAND" ]; then echo kept
fi
exit 0`;

/** Removes core.sshCommand, but only when it is still opendevhub's. */
export const SSH_COMMAND_OFF = `command -v git >/dev/null 2>&1 || exit 0
if [ "$(git config --global --get core.sshCommand)" = "$ODH_SSH_COMMAND" ]; then git config --global --unset core.sshCommand; fi
exit 0`;

function sshHostOf(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if ((u.protocol !== "ssh:" && u.protocol !== "git+ssh:") || !u.hostname)
      return undefined;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return u.port && u.port !== "22" ? `[${host}]:${u.port}` : host;
  }
  return url.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/)?.[1];
}

/** The ssh hosts of `git remote -v` output, named as known_hosts names them: `host`, or `[host]:port` off port 22. */
export function sshHosts(remotes: string): string[] {
  const out: string[] = [];
  for (const line of remotes.split("\n")) {
    const url = line.trim().split(/\s+/)[1];
    const host = url ? sshHostOf(url) : undefined;
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/** How to verify a known_hosts name by hand. */
function sshHint(host: string): { label: string; command: string } {
  const m = host.match(/^\[(.+)\]:(\d+)$/);
  return m
    ? { label: `${m[1]} (port ${m[2]})`, command: `ssh -p ${m[2]} ${m[1]}` }
    : { label: host, command: `ssh ${host}` };
}

function failure(
  what: string,
  r: { stdout: string; stderr: string; exitCode: number }
): Error {
  return new Error(
    `${what} (${tailLines(`${r.stderr}\n${r.stdout}`, 1).at(-1) ?? `exit ${r.exitCode}`})`
  );
}

export interface CredentialsDeps {
  run: Runner;
  containers: Pick<Containers, "exec">;
  /** This machine's known_hosts; defaults to ~/.ssh/known_hosts. */
  knownHostsFile?: string;
}

/** Git identity, known_hosts and git's ssh command in a container, from this machine's git and ssh setup. */
export class Credentials {
  constructor(private readonly deps: CredentialsDeps) {}

  /** Never throws: each step logs what it did, or why it couldn't. */
  async prepare(
    target: ExecTarget,
    projectPath: string,
    opts: { sshAgent: boolean; onLine: (line: string) => void }
  ): Promise<void> {
    const steps = [
      () => this.identity(target, projectPath, opts.onLine),
      () => this.knownHosts(target, projectPath, opts.onLine),
      () => this.sshCommand(target, opts.sshAgent, opts.onLine),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        opts.onLine(
          `credentials: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /** user.name and user.email as git sees them in the project folder, so includeIf identities apply. */
  async hostIdentity(projectPath: string): Promise<GitIdentity> {
    const read = async (key: string) => {
      const r = await this.deps.run(
        "git",
        ["-C", projectPath, "config", "--get", key],
        { timeoutMs: HOST_TIMEOUT_MS }
      );
      return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
    };
    const name = await read("user.name");
    const email = await read("user.email");
    return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
  }

  /** This machine's known_hosts entries for one host (hashed entries too). */
  async hostKnownHosts(host: string): Promise<string[]> {
    const file =
      this.deps.knownHostsFile ??
      path.join(os.homedir(), ".ssh", "known_hosts");
    const r = await this.deps.run("ssh-keygen", ["-F", host, "-f", file], {
      timeoutMs: HOST_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  private async identity(
    target: ExecTarget,
    projectPath: string,
    onLine: (line: string) => void
  ): Promise<void> {
    const id = await this.hostIdentity(projectPath);
    if (!id.name && !id.email) {
      onLine(
        "git: no user.name/user.email on this machine; commits in the container will fail"
      );
      return;
    }
    const r = await this.deps.containers.exec(
      target,
      ["sh", "-c", IDENTITY_SCRIPT],
      {
        env: { ODH_GIT_NAME: id.name ?? "", ODH_GIT_EMAIL: id.email ?? "" },
        timeoutMs: CONTAINER_TIMEOUT_MS,
      }
    );
    if (r.exitCode !== 0) throw failure("could not set the git identity", r);
    if (r.stdout.includes("no-git")) onLine("git: not found in the container");
    else if (/^set$/m.test(r.stdout))
      onLine(
        `git: identity set (${[id.name, id.email && `<${id.email}>`].filter(Boolean).join(" ")})`
      );
    else onLine("git: identity already set in the container");
  }

  private async knownHosts(
    target: ExecTarget,
    projectPath: string,
    onLine: (line: string) => void
  ): Promise<void> {
    const remotes = await this.deps.run(
      "git",
      ["-C", projectPath, "remote", "-v"],
      { timeoutMs: HOST_TIMEOUT_MS }
    );
    if (remotes.exitCode !== 0) return;
    const added: string[] = [];
    for (const host of sshHosts(remotes.stdout)) {
      const lines = await this.hostKnownHosts(host);
      if (lines.length === 0) {
        const hint = sshHint(host);
        onLine(
          `ssh: ${hint.label} is not in known_hosts on this machine; run "${hint.command}" once to verify it`
        );
        continue;
      }
      const r = await this.deps.containers.exec(
        target,
        ["sh", "-c", KNOWN_HOSTS_SCRIPT],
        {
          env: { ODH_HOST: host, ODH_LINES: lines.join("\n") },
          timeoutMs: CONTAINER_TIMEOUT_MS,
        }
      );
      if (r.exitCode !== 0)
        throw failure("could not update known_hosts in the container", r);
      if (r.stdout.includes("added")) added.push(host);
    }
    if (added.length > 0)
      onLine(`ssh: added known_hosts for ${added.join(", ")}`);
  }

  private async sshCommand(
    target: ExecTarget,
    sshAgent: boolean,
    onLine: (line: string) => void
  ): Promise<void> {
    const r = await this.deps.containers.exec(
      target,
      ["sh", "-c", sshAgent ? SSH_COMMAND_ON : SSH_COMMAND_OFF],
      {
        env: { ODH_SSH_COMMAND: AGENT_SSH_COMMAND },
        timeoutMs: CONTAINER_TIMEOUT_MS,
      }
    );
    if (r.exitCode !== 0) throw failure("could not set git's ssh command", r);
    if (r.stdout.includes("kept"))
      onLine(
        "git: the container sets its own core.sshCommand; leaving it as is"
      );
  }
}
```

Check that `tailLines(text, n)` in `containers.ts` takes `(text, count)` (it is called as `tailLines(r.stderr + "\n" + r.stdout, 5)` in `git.ts`) and is exported. If its signature differs, adapt `failure` to use it the way `git.ts` does.

In `src/server/git.ts` replace `IDENTITY_HINT`:

```ts
export const IDENTITY_HINT =
  "git has no user.name/user.email in the container. opendevhub copies them from this machine when the container starts: set them with `git config --global user.name …` and `git config --global user.email …` here (or in the devcontainer), then restart the project.";
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/server/credentials.test.ts test/server/git.test.ts` Expected: PASS. `git.test.ts` compares against the exported constant, so the new wording passes.

- [ ] **Step 5: Commit**

```bash
git add src/server/credentials.ts src/server/git.ts test/server/credentials.test.ts
git commit -m "feat: copy the git identity and known_hosts into containers and point git's ssh at the forwarded agent"
```

---

### Task 5: opencode launches with extra environment

**Files:**

- Modify: `src/server/opencode/runtime.ts:77-112` (`ensureRunning` args and the launch exec)
- Test: `test/server/opencode-runtime.test.ts`

**Interfaces:**

- Produces: `OpencodeRuntime.ensureRunning(target, args: { address; password?; workspaceFolder; onLine; env?: Record<string, string> })`. `env` is added to the `opencode serve` launch, and `OPENCODE_PASSWORD` always wins over it.

- [ ] **Step 1: Write the failing test**

Add to the `describe("OpencodeRuntime.ensureRunning", …)` block in `test/server/opencode-runtime.test.ts`:

```ts
it("launches opencode serve with the extra environment", async () => {
  const { runtime, calls } = runtimeWith({ stdout: "2.0.20" });
  await runtime.ensureRunning(project, {
    ...args(),
    env: { SSH_AUTH_SOCK: "/tmp/opendevhub-ssh-agent.sock" },
  });
  const launch = calls.find((c) =>
    c.args.at(-1)?.includes(" serve --hostname")
  )!;
  expect(launch.args).toContain("SSH_AUTH_SOCK=/tmp/opendevhub-ssh-agent.sock");
  expect(launch.args).toContain("OPENCODE_PASSWORD=pw");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server/opencode-runtime.test.ts` Expected: FAIL. `SSH_AUTH_SOCK=…` is not among the launch args, and TypeScript in vitest doesn't block on the extra property.

- [ ] **Step 3: Implement**

In `src/server/opencode/runtime.ts`, extend the `ensureRunning` args type:

```ts
    args: {
      address: HostPort;
      password?: string;
      workspaceFolder: string;
      onLine: (line: string) => void;
      /** Extra environment for `opencode serve` (and so for every tool the agent runs). */
      env?: Record<string, string>;
    },
```

and the launch:

```ts
const launch = await containers.exec(target, ["sh", "-c", script], {
  env: { ...args.env, OPENCODE_PASSWORD: password },
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/server/opencode-runtime.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/opencode/runtime.ts test/server/opencode-runtime.test.ts
git commit -m "feat: opencode serve can be launched with extra environment"
```

---

### Task 6: Orchestrator wiring

**Files:**

- Modify: `src/server/orchestrator.ts` (deps, a `tunnels` map, `prepareCredentials`, `stopTunnel`, the bring-up, adopt and relaunch call sites, `launchOpencode`, `closePorts`, `shutdown`)
- Modify: `src/server/cli.ts:127-160` (wire `Credentials`)
- Test: `test/server/orchestrator.test.ts` (the `setup()` harness plus a new describe block)

**Interfaces:**

- Consumes: `Credentials.prepare` (Task 4); `AgentTunnel`, `AgentTunnelOptions`, `AGENT_SOCKET` (Task 3); `EnvSettings.sshAgent`, `ProjectRuntime.sshAgent` and `sshAgentReason` (Task 1); `ensureRunning(..., { env })` (Task 5).
- Produces: `OrchestratorDeps.credentials?: CredentialsPort`, `OrchestratorDeps.agentTunnel?: AgentTunnelFactory`, with exported types `CredentialsPort = Pick<Credentials, "prepare">`, `AgentTunnelHandle = { start(): void; stop(): void }` and `AgentTunnelFactory = (target: RelayTarget, opts: AgentTunnelOptions) => AgentTunnelHandle`.

- [ ] **Step 1: Extend the test harness**

In `test/server/orchestrator.test.ts` `setup()`, before `const orch = new Orchestrator({`, add:

```ts
const credentials = {
  prepare: vi.fn(
    async (
      _t: ExecTarget,
      _path: string,
      _o: { sshAgent: boolean; onLine: (l: string) => void }
    ) => {}
  ),
};
const tunnels: Array<{
  target: RelayTarget;
  opts: AgentTunnelOptions;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];
const agentTunnel = vi.fn((target: RelayTarget, opts: AgentTunnelOptions) => {
  const t = { target, opts, start: vi.fn(), stop: vi.fn() };
  tunnels.push(t);
  return t;
});
```

Pass `credentials, agentTunnel,` in the `new Orchestrator({ … })` call, and add `credentials, agentTunnel, tunnels` to the returned object. Add these imports at the top:

```ts
import type { AgentTunnelOptions } from "../../src/server/relay/agent";
import type { RelayTarget } from "../../src/server/relay/client";
```

Change the `runtime.ensureRunning` mock's second parameter type to `_a: { password?: string; env?: Record<string, string> }`.

- [ ] **Step 2: Write the failing tests**

Add a new describe block:

```ts
describe("git and ssh credentials", () => {
  it("prepares credentials and the agent tunnel after the relay and before opencode", async () => {
    const { store, orch, relay, credentials, agentTunnel, tunnels, runtime } =
      setup();
    await orch.rescan();
    await orch.start(project.id);
    const token = store.runtime(project.id).relayToken!;
    expect(credentials.prepare).toHaveBeenCalledWith(
      project,
      "/src/demo",
      expect.objectContaining({ sshAgent: true })
    );
    expect(agentTunnel).toHaveBeenCalledWith(
      { host: "172.17.0.9", port: 4097, token },
      expect.anything()
    );
    expect(tunnels[0].start).toHaveBeenCalled();
    expect(relay.ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(
      credentials.prepare.mock.invocationCallOrder[0]
    );
    expect(credentials.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.ensureRunning.mock.invocationCallOrder[0]
    );
    expect(runtime.ensureRunning.mock.calls[0][1].env).toEqual({
      SSH_AUTH_SOCK: "/tmp/opendevhub-ssh-agent.sock",
    });
  });

  it("shows the tunnel's status on the runtime", async () => {
    const { store, orch, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    tunnels[0].opts.onStatus({ state: "forwarded" });
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "forwarded",
      sshAgentReason: undefined,
    });
    tunnels[0].opts.onStatus({
      state: "unavailable",
      reason: "SSH_AUTH_SOCK is not set on this machine",
    });
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "unavailable",
      sshAgentReason: "SSH_AUTH_SOCK is not set on this machine",
    });
  });

  it("leaves the agent out when the project turns it off", async () => {
    const { store, orch, credentials, agentTunnel, runtime, projectSettings } =
      setup();
    projectSettings.mockReturnValue({ sshAgent: false });
    await orch.rescan();
    await orch.start(project.id);
    expect(credentials.prepare).toHaveBeenCalledWith(
      project,
      "/src/demo",
      expect.objectContaining({ sshAgent: false })
    );
    expect(agentTunnel).not.toHaveBeenCalled();
    expect(store.runtime(project.id).sshAgent).toBe("off");
    expect(runtime.ensureRunning.mock.calls[0][1].env).toBeUndefined();
  });

  it("reports the agent unavailable without a relay", async () => {
    const { store, orch, relay, agentTunnel } = setup();
    relay.ensureRunning.mockResolvedValueOnce({
      status: "unavailable",
      reason: "no relay runtime",
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(agentTunnel).not.toHaveBeenCalled();
    expect(store.runtime(project.id)).toMatchObject({
      sshAgent: "unavailable",
      sshAgentReason: "relay not running",
    });
    expect(orch.logLines(project.id)).toContain(
      "ssh-agent: unavailable (relay not running)"
    );
  });

  it("still starts when preparing credentials fails", async () => {
    const { store, orch, credentials } = setup();
    credentials.prepare.mockRejectedValueOnce(new Error("boom"));
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      opencode: "healthy",
      error: undefined,
    });
    expect(orch.logLines(project.id)).toContain("credentials: boom");
  });

  it("stops the tunnel and clears the status when the container stops", async () => {
    const { store, orch, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    tunnels[0].opts.onStatus({ state: "forwarded" });
    await orch.stop(project.id);
    expect(tunnels[0].stop).toHaveBeenCalled();
    expect(store.runtime(project.id).sshAgent).toBeUndefined();
  });

  it("stops every tunnel on shutdown", async () => {
    const { orch, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.shutdown();
    expect(tunnels[0].stop).toHaveBeenCalled();
  });

  it("gives an adopted running container a tunnel too", async () => {
    const { orch, containers, agentTunnel, credentials } = setup({
      projects: { [project.id]: { password: "pw", relayToken: "kept" } },
    });
    containers.listManaged.mockResolvedValue([running]);
    await orch.rescan();
    await orch.adopt();
    expect(credentials.prepare).toHaveBeenCalledTimes(1);
    expect(agentTunnel).toHaveBeenCalledWith(
      { host: "172.17.0.9", port: 4097, token: "kept" },
      expect.anything()
    );
  });

  it("gives a task container its own tunnel, with its own token", async () => {
    const s = await withEnv();
    expect(s.agentTunnel).toHaveBeenCalledTimes(2);
    const [main, task] = s.tunnels;
    expect(task.target.host).toBe("172.17.0.10");
    expect(task.target.token).not.toBe(main.target.token);
    expect(s.credentials.prepare.mock.calls[1][0]).toMatchObject({
      id: s.envId,
    });
  });

  it("asks for relay recovery when the tunnel loses the relay", async () => {
    const { orch, relay, tunnels } = setup();
    await orch.rescan();
    await orch.start(project.id);
    tunnels[0].opts.onRelayLost?.();
    await vi.waitFor(() =>
      expect(relay.ensureRunning).toHaveBeenCalledTimes(2)
    );
  });
});
```

`withEnv()` is defined after `setup()` and returns the spread setup, so `agentTunnel`, `tunnels` and `credentials` are on it once Step 1 adds them to `setup`'s return.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/server/orchestrator.test.ts -t "git and ssh credentials"` Expected: FAIL. `credentials.prepare` is never called and `agentTunnel` is never called.

- [ ] **Step 4: Implement in the orchestrator**

Imports in `src/server/orchestrator.ts`:

```ts
import type { Credentials } from "./credentials";
import {
  AGENT_SOCKET,
  AgentTunnel,
  type AgentTunnelOptions,
} from "./relay/agent";
import type { RelayTarget } from "./relay/client";
```

Next to the other port types:

```ts
export type CredentialsPort = Pick<Credentials, "prepare">;
export interface AgentTunnelHandle {
  start(): void;
  stop(): void;
}
export type AgentTunnelFactory = (
  target: RelayTarget,
  opts: AgentTunnelOptions
) => AgentTunnelHandle;
```

In `OrchestratorDeps`:

```ts
  /** Git identity, known_hosts and git's ssh command in containers; skipped when absent. */
  credentials?: CredentialsPort;
  /** Defaults to a real AgentTunnel; tests pass their own. */
  agentTunnel?: AgentTunnelFactory;
```

Field next to `routes`:

```ts
  /** The ssh-agent tunnel of each environment whose agent is forwarded. */
  private readonly tunnels = new Map<EnvId, AgentTunnelHandle>();
```

New private methods, placed after `startRelay`:

```ts
  /** Git identity, known_hosts and the ssh-agent tunnel. Never throws: each step logs what happened. */
  private async prepareCredentials(env: Env, target: ForwardTarget): Promise<void> {
    const { store, credentials } = this.deps;
    const sshAgent = this.settingsOf(env.project).sshAgent;
    if (credentials) {
      try {
        await credentials.prepare(env.target, env.project.path, { sshAgent, onLine: (l) => this.envLog(env, l) });
      } catch (err) {
        this.envLog(env, `credentials: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.stopTunnel(env.id);
    if (!sshAgent) {
      store.updateRuntime(env.id, { sshAgent: "off", sshAgentReason: undefined });
      return;
    }
    if (!target.relay) {
      store.updateRuntime(env.id, { sshAgent: "unavailable", sshAgentReason: "relay not running" });
      this.envLog(env, "ssh-agent: unavailable (relay not running)");
      return;
    }
    const relayTarget: RelayTarget = { host: target.relay.host ?? target.host, port: target.relay.port, token: target.relay.token };
    const factory: AgentTunnelFactory = this.deps.agentTunnel ?? ((t, o) => new AgentTunnel(t, o));
    const tunnel = factory(relayTarget, {
      onLog: (l) => this.envLog(env, l),
      onStatus: (s) => store.updateRuntime(env.id, { sshAgent: s.state, sshAgentReason: s.reason }),
      onRelayLost: () => void this.recoverRelay(env.id),
    });
    this.tunnels.set(env.id, tunnel);
    tunnel.start();
  }

  private stopTunnel(id: EnvId): void {
    this.tunnels.get(id)?.stop();
    this.tunnels.delete(id);
  }
```

Call sites. Replace each `await this.forwardPorts(env, await this.startRelay(env, info.ip, route));` (in `adoptRunning`, `bringUpTask` and `bringUp`) with:

```ts
const target = await this.startRelay(env, info.ip, route);
await this.forwardPorts(env, target);
await this.prepareCredentials(env, target);
```

In `relaunchOpencode`, replace `if (target.relay && !relayWasActive) await this.forwardPorts(env, target);` with:

```ts
if (target.relay && !relayWasActive) {
  await this.forwardPorts(env, target);
  await this.prepareCredentials(env, target);
}
```

In `launchOpencode`, pass the environment to `runtime.ensureRunning`:

```ts
const result = await runtime.ensureRunning(env.target, {
  address: route.opencode,
  password,
  workspaceFolder: this.envDirectory(env),
  onLine: (l) => this.envLog(env, l),
  ...(this.settingsOf(env.project).sshAgent
    ? { env: { SSH_AUTH_SOCK: AGENT_SOCKET } }
    : {}),
});
```

`closePorts` (used by stop, rebuild, markStopped and destroyEnv):

```ts
  private async closePorts(id: EnvId): Promise<void> {
    this.stopTunnel(id);
    await this.deps.forwarder.close(id);
    this.deps.store.updateRuntime(id, { ports: undefined, relay: undefined, sshAgent: undefined, sshAgentReason: undefined });
  }
```

`shutdown`, first line:

```ts
for (const id of [...this.tunnels.keys()]) this.stopTunnel(id);
```

- [ ] **Step 5: Wire it in the CLI**

In `src/server/cli.ts`, import `Credentials` from `./credentials` and add `credentials: new Credentials({ run: spawnRunner, containers }),` to the `new Orchestrator({ … })` options (next to `publisher`).

- [ ] **Step 6: Run the whole suite and the type check**

Run: `npm test && npm run typecheck` Expected: PASS, including the existing relay and orchestrator tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/orchestrator.ts src/server/cli.ts test/server/orchestrator.test.ts
git commit -m "feat: every container gets the git identity, known_hosts and the forwarded ssh-agent"
```

---

### Task 7: Dashboard badge

**Files:**

- Modify: `src/web/derive.ts` (add `sshAgentBadge`)
- Modify: `src/web/pages/CheckoutPage.tsx:6,23,62,90` (imports and header badge)
- Test: `test/web/derive.test.ts`

**Interfaces:**

- Consumes: `PublicRuntime.sshAgent` and `sshAgentReason` (Task 1); `checkoutRuntime(view, directory)` from `src/web/checkouts.ts`.
- Produces: `sshAgentBadge(runtime: PublicRuntime): { label: string; warn: boolean; title: string } | undefined`.

- [ ] **Step 1: Write the failing test**

Add `sshAgentBadge` to the import from `../../src/web/derive` in `test/web/derive.test.ts`, add `PublicRuntime` to the type import from `../../src/shared/types`, and append:

```ts
describe("sshAgentBadge", () => {
  const rt = (patch: Partial<PublicRuntime>): PublicRuntime => ({
    projectId: "p",
    containerState: "running",
    opencode: "healthy",
    ...patch,
  });
  it("shows a forwarded agent quietly and an unavailable one as a warning with its reason", () => {
    expect(sshAgentBadge(rt({ sshAgent: "forwarded" }))).toMatchObject({
      label: "ssh-agent forwarded",
      warn: false,
    });
    expect(
      sshAgentBadge(
        rt({ sshAgent: "unavailable", sshAgentReason: "relay not running" })
      )
    ).toEqual({
      label: "ssh-agent unavailable",
      warn: true,
      title: "relay not running",
    });
  });
  it("shows nothing when off, unknown or the container isn't running", () => {
    expect(sshAgentBadge(rt({ sshAgent: "off" }))).toBeUndefined();
    expect(sshAgentBadge(rt({}))).toBeUndefined();
    expect(
      sshAgentBadge(rt({ containerState: "stopped", sshAgent: "forwarded" }))
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/web/derive.test.ts` Expected: FAIL, because `sshAgentBadge` is not exported.

- [ ] **Step 3: Implement**

In `src/web/derive.ts` (add `PublicRuntime` to its type import from `../shared/types` if it isn't imported yet):

```ts
/** The ssh-agent badge for a running container; nothing when forwarding is off or not known yet. */
export function sshAgentBadge(
  runtime: PublicRuntime
): { label: string; warn: boolean; title: string } | undefined {
  if (runtime.containerState !== "running") return undefined;
  if (runtime.sshAgent === "forwarded") {
    return {
      label: "ssh-agent forwarded",
      warn: false,
      title:
        "Your ssh-agent is forwarded into this container while opendevhub runs",
    };
  }
  if (runtime.sshAgent === "unavailable") {
    return {
      label: "ssh-agent unavailable",
      warn: true,
      title: runtime.sshAgentReason ?? "See the Logs tab",
    };
  }
  return undefined;
}
```

In `src/web/pages/CheckoutPage.tsx`:

- Add `KeyRoundIcon` to the `lucide-react` import.
- Add `sshAgentBadge` to the `../derive` import.
- After `const env = envOfDirectory(view, checkout.directory);` add `const agent = sshAgentBadge(checkoutRuntime(view, checkout.directory));`.
- After `{env && <EnvBadge env={env} />}` in the header description, add:

```tsx
{
  agent && (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-normal",
        agent.warn ? "text-warn" : "text-muted-foreground"
      )}
      title={agent.title}
    >
      <KeyRoundIcon className="size-3" /> {agent.label}
    </Badge>
  );
}
```

- [ ] **Step 4: Run the tests, the type check and the build**

Run: `npx vitest run test/web/derive.test.ts && npm run typecheck && npm run build` Expected: PASS; the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/web/derive.ts src/web/pages/CheckoutPage.tsx test/web/derive.test.ts
git commit -m "feat(web): show whether the ssh-agent reaches a checkout's container"
```

---

### Task 8: README and e2e

**Files:**

- Modify: `README.md` (Requirements, a new section after "Own containers for worktrees", Known limitations)
- Modify: `test/e2e/opendevhub.e2e.ts` (agent setup, `Credentials` dep, assertions after the relay check)

**Interfaces:**

- Consumes: everything above; `AGENT_SSH_COMMAND` from `src/server/relay/agent.ts`; `Credentials` from `src/server/credentials.ts`.

- [ ] **Step 1: Extend the e2e test**

In `test/e2e/opendevhub.e2e.ts`, add imports:

```ts
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { Credentials } from "../../src/server/credentials";
import { AGENT_SSH_COMMAND } from "../../src/server/relay/agent";
```

At the start of the `it(…)` body, before the orchestrator is built:

```ts
// A throwaway ssh-agent with one key stands in for the developer's.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-e2e-agent-"));
const agentSock = path.join(agentDir, "agent.sock");
const sshAgent = spawn("ssh-agent", ["-D", "-a", agentSock], {
  stdio: "ignore",
});
await vi.waitFor(() => expect(fs.existsSync(agentSock)).toBe(true));
const keyFile = path.join(agentDir, "key");
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile]);
execFileSync("ssh-add", [keyFile], {
  env: { ...process.env, SSH_AUTH_SOCK: agentSock },
  stdio: "ignore",
});
const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyFile}.pub`])
  .toString()
  .split(" ")[1];
const previousSock = process.env.SSH_AUTH_SOCK;
process.env.SSH_AUTH_SOCK = agentSock;
```

Add `credentials: new Credentials({ run: spawnRunner, containers }),` to the `new Orchestrator({ … })` options.

After `expect(rt.relay).toBe("active");`, add:

```ts
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
const hostEmail = spawnSync("git", ["-C", fixture, "config", "user.email"], {
  encoding: "utf8",
}).stdout.trim();
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
```

Before the test's final `await orch.stop(project.id)` block ends, after the existing stopped assertion, add:

```ts
sshAgent.kill();
if (previousSock === undefined) delete process.env.SSH_AUTH_SOCK;
else process.env.SSH_AUTH_SOCK = previousSock;
fs.rmSync(agentDir, { recursive: true, force: true });
```

- [ ] **Step 2: Run the e2e, both routes**

Run: `npm run test:e2e -- test/e2e/opendevhub.e2e.ts` Then: `OPENDEVHUB_ROUTE=gateway npm run test:e2e -- test/e2e/opendevhub.e2e.ts` Expected: PASS on both routes. The `[e2e]` log shows `ssh-agent: forwarded` and a `git:` line. If the fixture container was created earlier, it's reused; nothing here needs a rebuild.

- [ ] **Step 3: Update the README**

In **Requirements**, replace the line `- LLM provider credentials available inside the container (via `containerEnv`, `remoteEnv` or mounts). opendevhub does not manage credentials.` with:

```markdown
- LLM provider credentials available inside the container (via `containerEnv`, `remoteEnv` or mounts). Git and ssh are set up for you: see [Git and ssh in containers](#git-and-ssh-in-containers).
```

Add a section after **Own containers for worktrees**:

````markdown
## Git and ssh in containers

Every container opendevhub starts (the project's and each worktree's own) is set up for git when it starts or is reconnected:

- **Identity.** `user.name` and `user.email` are copied from git on your machine, read in the project folder so `includeIf` identities apply. They are only set when the container has none; values it already has are kept.
- **ssh-agent.** Your agent (`SSH_AUTH_SOCK`) is forwarded into the container at `/tmp/opendevhub-ssh-agent.sock` through the relay, so `git fetch`, `git pull`, `git push` and private git dependencies work over ssh. opencode gets `SSH_AUTH_SOCK`, and git's `core.sshCommand` points at the socket so terminals and VS Code use it too (unless the container sets its own `core.sshCommand`). The agent is only reachable while opendevhub runs. Your private keys never enter the container, but anything running in it, the agent included, can use them while it's forwarded.
- **known_hosts.** For each ssh remote of the project, the matching entries from your `~/.ssh/known_hosts` are added to the container's. Hosts you haven't connected to from your machine are skipped; the log says to `ssh` to them once.

The checkout page shows whether the agent is forwarded. To turn forwarding off for a project:

```jsonc
"customizations": { "opendevhub": { "sshAgent": false } }
```

or, in `~/.config/opendevhub/config.json`: `"projects": { "/path/to/repo": { "sshAgent": false } }`. It takes effect the next time the container starts or opendevhub restarts. An opencode server started before forwarding was set up picks up `SSH_AUTH_SOCK` after **Restart opencode**.
````

In **Known limitations**, add:

```markdown
- ssh host aliases from `~/.ssh/config` (remotes like `work:team/app.git`) are not resolved inside containers.
- ssh-agent forwarding needs the relay; when the relay can't run, the agent isn't forwarded (the checkout page and log say so).
- https git credentials and commit signing (GPG or ssh) are not set up in containers.
```

- [ ] **Step 4: Commit**

```bash
git add README.md test/e2e/opendevhub.e2e.ts
git commit -m "test: e2e for the forwarded ssh-agent and git identity; docs: git and ssh in containers"
```
