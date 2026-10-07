# Container Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make forwarded ports reach apps that listen only on the container's loopback, via a small relay process inside each project's container, with the existing direct connection as fallback.

**Architecture:** A dependency-free JavaScript relay (`RELAY_SCRIPT`) runs inside the container under opencode's Bun mode (`BUN_BE_BUN=1 <opencode> -e`) or `node`, listening on `0.0.0.0:4097`. The host `PortForwarder` opens one relay connection per client connection, sends `<token> <port>\n`, waits for `OK`, then pipes bytes; the relay connects to `127.0.0.1` then `::1`. `RelayRuntime` launches and pings the relay; the `Orchestrator` starts it before forwarding and passes the relay target to the forwarder.

**Tech Stack:** existing — Node ≥ 20, TypeScript 7, vitest 5, React 19, `node:net`; relay runs on Bun 1.4 (inside opencode 2.0.20) or Node.

**Spec:** `docs/superpowers/specs/2026-09-30-container-relay-design.md` (extends `docs/superpowers/specs/2026-09-30-port-forwarding-design.md`)

## Global Constraints

- Relay port inside the container: `4097` (`RELAY_PORT`, next to `OPENCODE_PORT = 4096`).
- Protocol: header `<token> <port>\n` or `<token> ping\n`, max 256 bytes, within 5 s; replies `OK\n`, `ERR <code>\n`, `PONG\n`; invalid/unauthorised → close without reply.
- The relay only connects to `127.0.0.1`, then `::1`. `ERR ECONNREFUSED` if either attempt was refused, else the last error code.
- Token: 32 random bytes, base64url, per project, persisted like the opencode password, never in `PublicRuntime`; passed to the relay via `--remote-env ODH_RELAY_TOKEN=…`.
- Relay runtimes in order: `env BUN_BE_BUN=1 <opencode binary>`, then `node` (only if `command -v node`). Ready = ping answers within 5 s (poll every 200 ms).
- Relay script: CommonJS, only `node:net` and `node:crypto`, no single quotes, starts with `/*odh-relay*/`; killed with `pkill -f 'odh-[r]elay' || true`; log at `/tmp/opendevhub-relay.log`.
- Relay unavailable or unreachable → forwarding connects directly to the bridge IP (today's behaviour) and logs why. The project always starts.
- Log lines are prefixed `relay: ` or `ports: `; per-port connection problems are rate-limited to one line per 30 s.
- Imports are extensionless; commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Vite on the container's `::1` only** (Node ≥ 17 default for `localhost`): must be reachable through the relay — pinned in Task 1 tests.
- **Bytes sent by the browser before the relay answers `OK`** (request pipelined right after connect): must not be lost — pinned in Task 3 tests.
- **Relay dies while ports are forwarded**: the next connection falls back to direct and logs once — pinned in Task 3 tests.
- **opendevhub restart with a still-running relay**: adopt pings with the persisted token and does not relaunch — pinned in Task 4 and Task 5 tests.
- **Another container on the same Docker network probing port 4097 with a wrong token**: gets nothing and cannot reach any port — pinned in Task 1 tests.

---

## File Structure

```
src/server/relay/script.ts          new: RELAY_SCRIPT
src/server/relay/client.ts          new: RelayTarget, RelayError, pingRelay(), openRelayConnection()
src/server/relay/runtime.ts         new: RELAY_PORT, RelayRuntime, generateRelayToken(), RelayStatus
src/server/port-forwarder.ts        ForwardTarget; relay path per connection with direct fallback
src/server/opencode/runtime.ts      + resolveBinary()
src/server/orchestrator.ts          relay lifecycle, ForwardTarget to forwarder
src/server/config.ts                PersistedRuntime.relayToken
src/server/state.ts                 persist relayToken, keep it out of snapshots
src/shared/types.ts                 ProjectRuntime.relayToken / relay; PublicRuntime omits relayToken
src/server/cli.ts                   wire RelayRuntime
src/web/components/PortsRow.tsx     "via relay" / "direct" hint
src/web/components/ProjectCard.tsx  pass runtime.relay
test/helpers/relay.ts               new: startRelay() (runs RELAY_SCRIPT under Node)
test/server/relay-script.test.ts    new
test/server/relay-client.test.ts    new
test/server/relay-runtime.test.ts   new
test/server/port-forwarder.test.ts  ForwardTarget + relay tests
test/server/opencode-runtime.test.ts + resolveBinary test
test/server/state.test.ts           + relayToken test
test/server/orchestrator.test.ts    relay fakes + tests
test/e2e/opendevhub.e2e.ts          loopback-only server, relay assertions
README.md                           limitation replaced by relay note
```

---

### Task 1: Relay script

**Files:**

- Create: `src/server/relay/script.ts`, `test/helpers/relay.ts`
- Test: `test/server/relay-script.test.ts`

**Interfaces:**

- Produces: `export const RELAY_SCRIPT: string`; test helper `startRelay(token = "tok"): Promise<{ port: number; stop(): Promise<void>; output(): string }>` (spawns `process.execPath -e RELAY_SCRIPT` with `ODH_RELAY_PORT`/`ODH_RELAY_TOKEN`, resolves when stdout contains `listening`), and `freePort(host = "127.0.0.1"): Promise<number>`.

- [ ] **Step 1: Write the test helper**

`test/helpers/relay.ts`:

```ts
import { spawn } from "node:child_process";
import net from "node:net";

import { RELAY_SCRIPT } from "../../src/server/relay/script";

export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, host, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export async function startRelay(token = "tok") {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", RELAY_SCRIPT], {
    env: {
      ...process.env,
      ODH_RELAY_PORT: String(port),
      ODH_RELAY_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`relay did not start: ${out}`)),
      5000
    );
    const check = () => {
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code}: ${out}`));
    });
  });
  return {
    port,
    output: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}
```

- [ ] **Step 2: Write the failing tests**

`test/server/relay-script.test.ts`:

```ts
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

describe("RELAY_SCRIPT", () => {
  it("is CommonJS, single-quote free and carries the kill marker", () => {
    expect(RELAY_SCRIPT.startsWith("/*odh-relay*/")).toBe(true);
    expect(RELAY_SCRIPT).not.toContain("'");
    expect(RELAY_SCRIPT).toContain('require("node:net")');
  });

  it("answers ping with PONG", async () => {
    expect(await talk("secret ping\n")).toBe("PONG\n");
  });

  it("pipes to a 127.0.0.1 target, forwarding bytes sent together with the header", async () => {
    const port = await echoOn("127.0.0.1");
    expect(await talk(`secret ${port}\n`, "hi", /echo:hi/)).toBe("OK\necho:hi");
  });

  it("falls back to ::1 when nothing listens on 127.0.0.1", async () => {
    const port = await echoOn("::1");
    expect(await talk(`secret ${port}\n`, "v6", /echo:v6/)).toBe("OK\necho:v6");
  });

  it("reports ECONNREFUSED when nothing listens", async () => {
    const port = await freePort();
    expect(await talk(`secret ${port}\n`)).toBe("ERR ECONNREFUSED\n");
  });

  it.each([
    ["wrong token", "nope 80\n"],
    ["malformed header", "secret\n"],
    ["bad port", "secret 70000\n"],
    ["non-numeric port", "secret abc\n"],
    ["oversized header", "x".repeat(300)],
  ])("closes silently on %s", async (_name, header) => {
    expect(await talk(header)).toBe("");
  });

  it("exits with an error when the token is missing", () => {
    const r = spawnSync(process.execPath, ["-e", RELAY_SCRIPT], {
      env: { ...process.env, ODH_RELAY_TOKEN: "", ODH_RELAY_PORT: "0" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ODH_RELAY_TOKEN");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/server/relay-script.test.ts` Expected: FAIL — cannot resolve `../../src/server/relay/script`.

- [ ] **Step 4: Implement the script**

`src/server/relay/script.ts`:

```ts
/**
 * Runs inside the container (Bun via `BUN_BE_BUN=1 <opencode> -e`, or Node) and relays TCP from
 * 0.0.0.0:$ODH_RELAY_PORT to the container's loopback. Protocol: see the container relay spec §3.
 * Constraints: CommonJS, node:net/node:crypto only, no single quotes (it is shell-quoted as one arg).
 */
export const RELAY_SCRIPT = `/*odh-relay*/
"use strict";
const net = require("node:net");
const crypto = require("node:crypto");
const token = process.env.ODH_RELAY_TOKEN || "";
const port = Number(process.env.ODH_RELAY_PORT || "4097");
if (!token) {
  console.error("odh-relay: ODH_RELAY_TOKEN is not set");
  process.exit(2);
}
const expected = Buffer.from(token);
function tokenOk(candidate) {
  const b = Buffer.from(candidate);
  return b.length === expected.length && crypto.timingSafeEqual(b, expected);
}
function connectLocal(target, done) {
  const hosts = ["127.0.0.1", "::1"];
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
    if (parts.length !== 2 || !tokenOk(parts[0])) return client.destroy();
    if (parts[1] === "ping") return client.end("PONG\\n");
    if (!/^[0-9]+$/.test(parts[1])) return client.destroy();
    const target = Number(parts[1]);
    if (target < 1 || target > 65535) return client.destroy();
    connectLocal(target, (code, upstream) => {
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

- [ ] **Step 5: Run tests (3× for flakiness) and typecheck**

Run: `for i in 1 2 3; do npx vitest run test/server/relay-script.test.ts || break; done; npx tsc --noEmit` Expected: PASS every run.

- [ ] **Step 6: Commit**

```bash
git add src/server/relay/script.ts test/helpers/relay.ts test/server/relay-script.test.ts
git commit -m "feat: dependency-free relay script for the container loopback"
```

---

### Task 2: Relay client

**Files:**

- Create: `src/server/relay/client.ts`
- Test: `test/server/relay-client.test.ts`

**Interfaces:**

- Consumes: `startRelay`, `freePort` (Task 1).
- Produces:

  ```ts
  interface RelayTarget { host: string; port: number; token: string }
  class RelayError extends Error { readonly code: string }        // relay answered ERR <code> (or EPROTO)
  pingRelay(target: RelayTarget, timeoutMs?: number): Promise<boolean>          // default 1000
  openRelayConnection(target: RelayTarget, port: number, timeoutMs?: number): Promise<{ socket: net.Socket; rest: Buffer }> // default 5000
  ```

  `openRelayConnection` rejects with `RelayError` for relay answers, with a plain `Error` (e.g. `ECONNREFUSED` from `net`) when the relay itself is unreachable or times out. On resolve the socket is paused and has no listeners attached; `rest` holds bytes received after `OK\n` in the same chunk.

- [ ] **Step 1: Write the failing tests**

`test/server/relay-client.test.ts`:

```ts
import net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RelayError,
  openRelayConnection,
  pingRelay,
} from "../../src/server/relay/client";
import { freePort, startRelay } from "../helpers/relay";

let relay: Awaited<ReturnType<typeof startRelay>>;
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

describe("relay client", () => {
  it("pings with the right token and fails with the wrong one or no relay", async () => {
    expect(
      await pingRelay({ host: "127.0.0.1", port: relay.port, token: "secret" })
    ).toBe(true);
    expect(
      await pingRelay(
        { host: "127.0.0.1", port: relay.port, token: "wrong" },
        300
      )
    ).toBe(false);
    expect(
      await pingRelay(
        { host: "127.0.0.1", port: await freePort(), token: "secret" },
        300
      )
    ).toBe(false);
  });

  it("opens a piped connection after OK, handing over early upstream bytes", async () => {
    const port = await freePort();
    const banner = net.createServer((c) => c.write("hello-banner"));
    servers.push(banner);
    await new Promise<void>((r) => banner.listen(port, "127.0.0.1", r));
    const { socket, rest } = await openRelayConnection(
      { host: "127.0.0.1", port: relay.port, token: "secret" },
      port
    );
    const later = await new Promise<string>((resolve) => {
      if (rest.length) return resolve(rest.toString());
      socket.once("data", (d) => resolve(d.toString()));
      socket.resume();
    });
    expect(later).toBe("hello-banner");
    socket.destroy();
  });

  it("rejects with RelayError(ECONNREFUSED) when nothing listens in the container", async () => {
    const err = await openRelayConnection(
      { host: "127.0.0.1", port: relay.port, token: "secret" },
      await freePort()
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe("ECONNREFUSED");
  });

  it("rejects with a plain error when the relay is unreachable", async () => {
    const err = await openRelayConnection(
      { host: "127.0.0.1", port: await freePort(), token: "secret" },
      80
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RelayError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/relay-client.test.ts` Expected: FAIL — cannot resolve `../../src/server/relay/client`.

- [ ] **Step 3: Implement**

`src/server/relay/client.ts`:

```ts
import net from "node:net";

export interface RelayTarget {
  host: string;
  port: number;
  token: string;
}

export class RelayError extends Error {
  constructor(readonly code: string) {
    super(`relay: ${code}`);
    this.name = "RelayError";
  }
}

function handshake(
  target: RelayTarget,
  line: string,
  timeoutMs: number
): Promise<{ socket: net.Socket; reply: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: target.host,
      port: target.port,
      allowHalfOpen: true,
    });
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
    };
    const fail = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onClose = () => fail(new Error("relay closed the connection"));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl === -1) {
        if (buf.length > 256) fail(new Error("relay sent an oversized reply"));
        return;
      }
      cleanup();
      socket.pause();
      resolve({
        socket,
        reply: buf.subarray(0, nl).toString("utf8").trim(),
        rest: buf.subarray(nl + 1),
      });
    };
    const timer = setTimeout(
      () => fail(new Error("relay handshake timed out")),
      timeoutMs
    );
    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.once("connect", () => socket.write(line));
  });
}

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
    return reply === "PONG";
  } catch {
    return false;
  }
}

export async function openRelayConnection(
  target: RelayTarget,
  port: number,
  timeoutMs = 5000
): Promise<{ socket: net.Socket; rest: Buffer }> {
  const { socket, reply, rest } = await handshake(
    target,
    `${target.token} ${port}\n`,
    timeoutMs
  );
  if (reply === "OK") return { socket, rest };
  socket.destroy();
  throw new RelayError(reply.startsWith("ERR ") ? reply.slice(4) : "EPROTO");
}
```

Note: a wrong token makes the relay close silently, which surfaces as "relay closed the connection" → `pingRelay` returns `false`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/server/relay-client.test.ts && npx tsc --noEmit` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/relay/client.ts test/server/relay-client.test.ts
git commit -m "feat: host-side relay client (ping, open, errors)"
```

---

### Task 3: PortForwarder relay path

**Files:**

- Modify: `src/server/port-forwarder.ts`
- Test: `test/server/port-forwarder.test.ts`

**Interfaces:**

- Consumes: `openRelayConnection`, `RelayError` (Task 2); `startRelay`, `freePort` (Task 1).
- Produces: `export interface ForwardTarget { host: string; relay?: { port: number; token: string } }`; `PortForwarder.open(projectId: string, target: ForwardTarget, ports: PortSpec[], onLog?)` (was `targetHost: string`). Everything else unchanged.

- [ ] **Step 1: Update existing tests to the new signature**

In `test/server/port-forwarder.test.ts`, replace every `"127.0.0.2", [` argument of `forwarder.open(...)` with `{ host: "127.0.0.2" }, [` (all existing calls). The current implementation then passes the object where a host string is expected, so every test that connects upstream fails — that is the RED for the signature change (checked in Step 3 together with the new tests).

- [ ] **Step 2: Add the failing relay tests**

Add imports at the top of `test/server/port-forwarder.test.ts`:

```ts
import { startRelay } from "../helpers/relay";
```

and append inside `describe("PortForwarder", …)`:

```ts
describe("with a relay", () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  afterEach(async () => {
    await relay?.stop();
  });

  it("reaches an app bound to 127.0.0.1 only, which the direct route cannot reach", async () => {
    relay = await startRelay("secret");
    const port = await listenEcho("127.0.0.1", "loop:");
    forwarder = new PortForwarder();
    const [result] = await forwarder.open(
      "p1",
      { host: "127.0.0.2", relay: { port: relay.port, token: "secret" } },
      [{ containerPort: port }]
    );
    expect(hostPort(result)).toBeGreaterThan(port); // 127.0.0.1:<port> is taken by the app itself
    expect(await roundTrip(hostPort(result), "x")).toBe("loop:x");
  });

  it("does not lose bytes the client sends before the relay answers", async () => {
    relay = await startRelay("secret");
    const port = await listenEcho("127.0.0.1", "early:");
    forwarder = new PortForwarder();
    const [result] = await forwarder.open(
      "p1",
      { host: "127.0.0.2", relay: { port: relay.port, token: "secret" } },
      [{ containerPort: port }]
    );
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(hostPort(result), "127.0.0.1");
      socket.write("immediately");
      socket.once("data", (d) => {
        resolve(d.toString());
        socket.destroy();
      });
    });
    expect(reply).toBe("early:immediately");
  });

  it("logs once and closes when nothing listens inside the container", async () => {
    relay = await startRelay("secret");
    const logs: string[] = [];
    forwarder = new PortForwarder({ logIntervalMs: 60_000 });
    const [result] = await forwarder.open(
      "p1",
      { host: "127.0.0.2", relay: { port: relay.port, token: "secret" } },
      [{ containerPort: 45999 }],
      (l) => logs.push(l)
    );
    await closedOrReset(hostPort(result));
    await closedOrReset(hostPort(result));
    expect(logs).toEqual([
      "ports: 45999: nothing is listening on port 45999 inside the container",
    ]);
  });

  it("falls back to the direct route when the relay is unreachable", async () => {
    relay = await startRelay("secret");
    await relay.stop();
    const port = await echoUpstream();
    const logs: string[] = [];
    forwarder = new PortForwarder({ logIntervalMs: 60_000 });
    const [result] = await forwarder.open(
      "p1",
      { host: "127.0.0.2", relay: { port: relay.port, token: "secret" } },
      [{ containerPort: port }],
      (l) => logs.push(l)
    );
    expect(await roundTrip(hostPort(result), "d")).toBe("echo:d");
    expect(logs[0]).toMatch(
      new RegExp(
        `^ports: ${port}: relay unreachable \\(.+\\), connecting directly$`
      )
    );
  });
});
```

and add this helper next to `echoUpstream` in the same file:

```ts
async function listenEcho(host: string, prefix: string): Promise<number> {
  const server = net.createServer((s) =>
    s.on("data", (d) => s.write(prefix + d.toString()))
  );
  servers.push(server);
  return listen(server, 0, host);
}
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/server/port-forwarder.test.ts` Expected: FAIL — existing upstream tests and all four relay tests fail.

- [ ] **Step 4: Implement**

In `src/server/port-forwarder.ts`:

Add import and the exported target type:

```ts
import { RelayError, openRelayConnection } from "./relay/client";

export interface ForwardTarget {
  host: string;
  relay?: { port: number; token: string };
}
```

Change the `open` signature's second parameter from `targetHost: string` to `target: ForwardTarget`, and pass `target` instead of `targetHost` to `openOne`; change `openOne`'s parameter the same way.

Replace the whole `const handleClient = (client: net.Socket) => { … };` block with:

```ts
const logLimited = (line: string) => {
  const now = Date.now();
  if (now - lastLog >= logIntervalMs) {
    lastLog = now;
    onLog(line);
  }
};

const handleClient = (client: net.Socket) => {
  // Paused until an upstream is ready, so bytes sent before the relay answers are not lost.
  client.pause();
  sockets.add(client);
  let upstream: net.Socket | undefined;
  const destroy = () => {
    client.destroy();
    upstream?.destroy();
    sockets.delete(client);
    if (upstream) sockets.delete(upstream);
  };
  client.on("error", destroy);
  client.on("close", destroy);

  const pipe = (socket: net.Socket, rest?: Buffer) => {
    if (client.destroyed) {
      socket.destroy();
      return;
    }
    upstream = socket;
    sockets.add(socket);
    socket.on("error", destroy);
    socket.on("close", destroy);
    if (rest?.length) client.write(rest);
    client.pipe(socket);
    socket.pipe(client);
    client.resume();
    socket.resume();
  };

  const direct = () => {
    const socket = net.connect({
      host: target.host,
      port: spec.containerPort,
      allowHalfOpen: true,
    });
    const onConnectError = (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === "ECONNREFUSED"
          ? " (is the app listening on 0.0.0.0 inside the container? apps bound to localhost there are not reachable)"
          : "";
      logLimited(`ports: ${spec.containerPort}: ${err.message}${hint}`);
      socket.destroy();
      destroy();
    };
    socket.once("error", onConnectError);
    socket.once("connect", () => {
      socket.off("error", onConnectError);
      pipe(socket);
    });
  };

  if (!target.relay) return direct();
  openRelayConnection(
    { host: target.host, ...target.relay },
    spec.containerPort
  ).then(
    ({ socket, rest }) => pipe(socket, rest),
    (err: Error) => {
      if (err instanceof RelayError) {
        logLimited(
          err.code === "ECONNREFUSED"
            ? `ports: ${spec.containerPort}: nothing is listening on port ${spec.containerPort} inside the container`
            : `ports: ${spec.containerPort}: relay could not connect (${err.code})`
        );
        destroy();
        return;
      }
      if (client.destroyed) return;
      logLimited(
        `ports: ${spec.containerPort}: relay unreachable (${err.message}), connecting directly`
      );
      direct();
    }
  );
};
```

(`lastLog` and `logIntervalMs` stay declared above it as today.)

- [ ] **Step 5: Run tests (3×) and typecheck**

Run: `for i in 1 2 3; do npx vitest run test/server/port-forwarder.test.ts || break; done; npx tsc --noEmit` Expected: forwarder tests PASS every run. `tsc` reports errors only in `src/server/orchestrator.ts` (it still passes a string) — fixed in Task 5. Note this in the ledger.

- [ ] **Step 6: Commit**

```bash
git add src/server/port-forwarder.ts test/server/port-forwarder.test.ts
git commit -m "feat: forward through the container relay with direct fallback"
```

---

### Task 4: RelayRuntime and `resolveBinary`

**Files:**

- Create: `src/server/relay/runtime.ts`
- Modify: `src/server/opencode/runtime.ts`
- Test: `test/server/relay-runtime.test.ts`, `test/server/opencode-runtime.test.ts`

**Interfaces:**

- Consumes: `Containers.exec`, `CommandError` (existing); `pingRelay`, `RelayTarget` (Task 2); `RELAY_SCRIPT` (Task 1).
- Produces:

  ```ts
  // src/server/relay/runtime.ts
  const RELAY_PORT = 4097;
  type RelayStatus = { status: "active"; via: "existing" | "bun" | "node" } | { status: "unavailable"; reason: string };
  function generateRelayToken(): string;
  interface RelayRuntimeDeps { containers: Pick<Containers, "exec">; ping?: (t: RelayTarget) => Promise<boolean>; relayPort?: number; readyTimeoutMs?: number; readyIntervalMs?: number }
  class RelayRuntime {
    ensureRunning(project: Project, args: { ip: string; token: string; binary?: string }): Promise<RelayStatus>; // never rejects
    stop(project: Project): Promise<void>;
  }
  // src/server/opencode/runtime.ts
  OpencodeRuntime.resolveBinary(project: Project): Promise<string | undefined>
  ```

- [ ] **Step 1: Write the failing tests**

`test/server/relay-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { Containers } from "../../src/server/containers";
import {
  RELAY_PORT,
  RelayRuntime,
  generateRelayToken,
} from "../../src/server/relay/runtime";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/x",
};
const args = {
  ip: "172.17.0.9",
  token: "tok",
  binary: "/home/node/.opencode/bin/opencode",
};
const script = (c: Call) => c.args.at(-1) ?? "";
const isLaunch = (c: Call) =>
  script(c).includes("odh-relay") && script(c).includes("nohup");

function setup(
  opts: {
    hasNode?: boolean;
    readyAfterLaunch?: number[];
    alreadyUp?: boolean;
  } = {}
) {
  let launches = 0;
  const { run, calls } = fakeRunner((c) => {
    if (isLaunch(c)) launches += 1;
    if (script(c) === "command -v node >/dev/null 2>&1")
      return { exitCode: opts.hasNode ? 0 : 1 };
    if (script(c).startsWith("tail -n 1"))
      return { stdout: "odh-relay: listen EADDRINUSE 0.0.0.0:4097\n" };
    return {};
  });
  const ping = vi.fn(async () =>
    opts.alreadyUp ? true : (opts.readyAfterLaunch ?? [1]).includes(launches)
  );
  const relay = new RelayRuntime({
    containers: new Containers(run),
    ping,
    readyTimeoutMs: 100,
    readyIntervalMs: 10,
  });
  return { relay, calls, ping };
}

describe("generateRelayToken", () => {
  it("returns 43 url-safe characters", () => {
    expect(generateRelayToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("RelayRuntime.ensureRunning", () => {
  it("does nothing when the relay already answers", async () => {
    const { relay, calls, ping } = setup({ alreadyUp: true });
    expect(await relay.ensureRunning(project, args)).toEqual({
      status: "active",
      via: "existing",
    });
    expect(calls).toHaveLength(0);
    expect(ping).toHaveBeenCalledWith({
      host: "172.17.0.9",
      port: RELAY_PORT,
      token: "tok",
    });
  });

  it("kills stale relays, then launches via opencode's Bun mode with token and port in the env", async () => {
    const { relay, calls } = setup({ readyAfterLaunch: [1] });
    expect(await relay.ensureRunning(project, args)).toEqual({
      status: "active",
      via: "bun",
    });
    expect(script(calls[0])).toBe("pkill -f 'odh-[r]elay' || true");
    const launch = calls.find(isLaunch)!;
    expect(script(launch)).toContain(
      "nohup env BUN_BE_BUN=1 '/home/node/.opencode/bin/opencode' -e '/*odh-relay*/"
    );
    expect(script(launch)).toContain("> /tmp/opendevhub-relay.log 2>&1 &");
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--remote-env",
        "ODH_RELAY_TOKEN=tok",
        "--remote-env",
        `ODH_RELAY_PORT=${RELAY_PORT}`,
      ])
    );
  });

  it("falls back to node when the Bun mode does not come up", async () => {
    const { relay, calls } = setup({ hasNode: true, readyAfterLaunch: [2] });
    expect(await relay.ensureRunning(project, args)).toEqual({
      status: "active",
      via: "node",
    });
    expect(script(calls.filter(isLaunch)[1])).toContain(
      "nohup env node -e '/*odh-relay*/"
    );
  });

  it("reports unavailable with the relay log line when nothing works", async () => {
    const { relay } = setup({ hasNode: false, readyAfterLaunch: [] });
    expect(await relay.ensureRunning(project, args)).toEqual({
      status: "unavailable",
      reason: "bun: odh-relay: listen EADDRINUSE 0.0.0.0:4097",
    });
  });

  it("skips Bun mode without a binary and reports when node is missing too", async () => {
    const { relay, calls } = setup({ hasNode: false, readyAfterLaunch: [] });
    expect(
      await relay.ensureRunning(project, { ip: "172.17.0.9", token: "tok" })
    ).toEqual({
      status: "unavailable",
      reason:
        "no relay runtime: opencode Bun mode unavailable and node not found",
    });
    expect(calls.some(isLaunch)).toBe(false);
  });
});

describe("RelayRuntime.stop", () => {
  it("kills the relay by its marker", async () => {
    const { relay, calls } = setup();
    await relay.stop(project);
    expect(script(calls[0])).toBe("pkill -f 'odh-[r]elay' || true");
  });
});
```

Append to `test/server/opencode-runtime.test.ts` (inside the file, new `describe`):

```ts
describe("OpencodeRuntime.resolveBinary", () => {
  it("returns the resolved path or undefined", async () => {
    const found = runtimeWith({ stdout: "opencode v2.0.20" });
    expect(await found.runtime.resolveBinary(project)).toBe(BIN);
    const missing = runtimeWith(
      { stdout: "opencode v2.0.20" },
      { exitCode: 1, stdout: "" }
    );
    expect(await missing.runtime.resolveBinary(project)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/relay-runtime.test.ts test/server/opencode-runtime.test.ts` Expected: FAIL — relay runtime module missing; `resolveBinary is not a function`.

- [ ] **Step 3: Extract `resolveBinary`**

In `src/server/opencode/runtime.ts`, add this public method to `OpencodeRuntime` (before `ensureRunning`):

```ts
  async resolveBinary(project: Project): Promise<string | undefined> {
    const resolved = await this.deps.containers.exec(project, ["sh", "-c", RESOLVE_BINARY]);
    return resolved.exitCode === 0 ? parseBinaryPath(resolved.stdout) : undefined;
  }
```

and in `ensureRunning` replace

```ts
const resolved = await containers.exec(project, ["sh", "-c", RESOLVE_BINARY]);
const binary =
  resolved.exitCode === 0 ? parseBinaryPath(resolved.stdout) : undefined;
if (!binary) {
  throw new CommandError(
    `opencode v2 not found in the devcontainer (searched ${SEARCHED})`,
    tailLines(resolved.stderr)
  );
}
```

with

```ts
const binary = await this.resolveBinary(project);
if (!binary)
  throw new CommandError(
    `opencode v2 not found in the devcontainer (searched ${SEARCHED})`
  );
```

- [ ] **Step 4: Implement `RelayRuntime`**

`src/server/relay/runtime.ts`:

```ts
import { randomBytes } from "node:crypto";

import type { Project } from "../../shared/types";
import type { Containers } from "../containers";
import { type RelayTarget, pingRelay } from "./client";
import { RELAY_SCRIPT } from "./script";

export const RELAY_PORT = 4097;
const RELAY_LOG = "/tmp/opendevhub-relay.log";
const KILL_RELAY = "pkill -f 'odh-[r]elay' || true";

export type RelayStatus =
  | { status: "active"; via: "existing" | "bun" | "node" }
  | { status: "unavailable"; reason: string };

export function generateRelayToken(): string {
  return randomBytes(32).toString("base64url");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RelayRuntimeDeps {
  containers: Pick<Containers, "exec">;
  ping?: (target: RelayTarget) => Promise<boolean>;
  relayPort?: number;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

export class RelayRuntime {
  constructor(private readonly deps: RelayRuntimeDeps) {}

  async ensureRunning(
    project: Project,
    args: { ip: string; token: string; binary?: string }
  ): Promise<RelayStatus> {
    try {
      return await this.start(project, args);
    } catch (err) {
      return {
        status: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async stop(project: Project): Promise<void> {
    await this.deps.containers.exec(project, ["sh", "-c", KILL_RELAY]);
  }

  private async start(
    project: Project,
    args: { ip: string; token: string; binary?: string }
  ): Promise<RelayStatus> {
    const { containers } = this.deps;
    const port = this.deps.relayPort ?? RELAY_PORT;
    const target: RelayTarget = { host: args.ip, port, token: args.token };
    if (await this.ping(target)) return { status: "active", via: "existing" };

    await containers.exec(project, ["sh", "-c", KILL_RELAY]);
    const candidates: Array<{ via: "bun" | "node"; command: string }> = [];
    if (args.binary)
      candidates.push({
        via: "bun",
        command: `BUN_BE_BUN=1 ${shellQuote(args.binary)}`,
      });
    const hasNode = await containers.exec(project, [
      "sh",
      "-c",
      "command -v node >/dev/null 2>&1",
    ]);
    if (hasNode.exitCode === 0)
      candidates.push({ via: "node", command: "node" });
    if (candidates.length === 0) {
      return {
        status: "unavailable",
        reason:
          "no relay runtime: opencode Bun mode unavailable and node not found",
      };
    }

    let reason = "";
    for (const candidate of candidates) {
      const launch =
        `nohup env ${candidate.command} -e ${shellQuote(RELAY_SCRIPT)} odh-relay ` +
        `< /dev/null > ${RELAY_LOG} 2>&1 &`;
      await containers.exec(project, ["sh", "-c", launch], {
        env: { ODH_RELAY_TOKEN: args.token, ODH_RELAY_PORT: String(port) },
      });
      if (await this.waitReady(target))
        return { status: "active", via: candidate.via };
      const log = await containers.exec(project, [
        "sh",
        "-c",
        `tail -n 1 ${RELAY_LOG} 2>/dev/null`,
      ]);
      reason = `${candidate.via}: ${log.stdout.trim() || "did not answer"}`;
      await containers.exec(project, ["sh", "-c", KILL_RELAY]);
    }
    return { status: "unavailable", reason };
  }

  private ping(target: RelayTarget): Promise<boolean> {
    return (this.deps.ping ?? pingRelay)(target);
  }

  private async waitReady(target: RelayTarget): Promise<boolean> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 5000);
    while (Date.now() < deadline) {
      if (await this.ping(target)) return true;
      await new Promise((r) => setTimeout(r, this.deps.readyIntervalMs ?? 200));
    }
    return false;
  }
}
```

Note on the "node missing" test: `setup({ hasNode: false })` with `binary` set still launches the Bun candidate; the "skips Bun mode without a binary" test passes no binary and no node, so no launch happens.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/server/relay-runtime.test.ts test/server/opencode-runtime.test.ts` Expected: PASS. (`tsc` still reports only the orchestrator error from Task 3.)

- [ ] **Step 6: Commit**

```bash
git add src/server/relay/runtime.ts src/server/opencode/runtime.ts test/server/relay-runtime.test.ts test/server/opencode-runtime.test.ts
git commit -m "feat: launch and ping the container relay (Bun via opencode, node fallback)"
```

---

### Task 5: State, orchestrator and CLI wiring

**Files:**

- Modify: `src/shared/types.ts`, `src/server/config.ts`, `src/server/state.ts`, `src/server/orchestrator.ts`, `src/server/cli.ts`, `test/e2e/opendevhub.e2e.ts` (constructor only)
- Test: `test/server/state.test.ts`, `test/server/orchestrator.test.ts`

**Interfaces:**

- Consumes: `RelayRuntime`, `RELAY_PORT`, `generateRelayToken` (Task 4); `ForwardTarget` (Task 3); `resolveBinary` (Task 4).
- Produces:
  - `ProjectRuntime.relayToken?: string` (persisted, never public), `ProjectRuntime.relay?: "active" | "unavailable"` (public, not persisted); `PublicRuntime = Omit<ProjectRuntime, "password" | "relayToken">`; `PersistedRuntime.relayToken?: string`.
  - `OrchestratorDeps.relay: RelayPort` where `type RelayPort = Pick<RelayRuntime, "ensureRunning" | "stop">`; `RuntimePort` gains `"resolveBinary"`.

- [ ] **Step 1: Write the failing state test**

Append inside `describe("StateStore", …)` in `test/server/state.test.ts`:

```ts
it("persists relayToken and never exposes it in snapshots", () => {
  const { store, saved } = make();
  store.setProjects([p("a")]);
  store.updateRuntime("a", { relayToken: "relay-secret", relay: "active" });
  expect(saved.at(-1)?.projects.a).toMatchObject({
    relayToken: "relay-secret",
  });
  const snap = JSON.stringify(store.snapshot());
  expect(snap).not.toContain("relay-secret");
  expect(store.snapshot().projects[0].runtime.relay).toBe("active");
});
```

- [ ] **Step 2: Extend the orchestrator test setup and write the failing tests**

In `test/server/orchestrator.test.ts`:

- add to the `runtime` fake: `resolveBinary: vi.fn(async (_p?: Project): Promise<string | undefined> => "/usr/local/bin/opencode"),`
- add after `forwarder`:

```ts
const relay = {
  ensureRunning: vi.fn(
    async (
      _p: Project,
      _a: { ip: string; token: string; binary?: string }
    ): Promise<RelayStatus> => ({
      status: "active",
      via: "bun",
    })
  ),
  stop: vi.fn(async (_p?: Project) => {}),
};
```

- pass `relay` to `new Orchestrator({ … })` and add it to the returned object;
- add import `import type { RelayStatus } from "../../src/server/relay/runtime";`
- update the three existing assertions that expect a string host:
  - in "forwards configured ports on start…": `expect(forwarder.open).toHaveBeenCalledWith(project.id, expect.objectContaining({ host: "172.17.0.9" }), [{ containerPort: 3000, label: "web" }], expect.any(Function));`
  - in "rebuild closes old forwards…": `expect(forwarder.open.mock.calls[1][1].host).toBe("172.17.0.42");`
  - in "adopt forwards ports of running containers only": same `expect.objectContaining({ host: "172.17.0.9" })` form. (and change the `forwarder.open` fake's second parameter type from `_host: string` to `_target: ForwardTarget`, importing `type ForwardTarget` from `../../src/server/port-forwarder`).

Append these tests inside `describe("Orchestrator", …)`:

```ts
it("starts the relay before forwarding and forwards through it", async () => {
  const { store, relay, forwarder, orch } = setup();
  await orch.rescan();
  await orch.start(project.id);
  const token = store.runtime(project.id).relayToken!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(relay.ensureRunning).toHaveBeenCalledWith(project, {
    ip: "172.17.0.9",
    token,
    binary: "/usr/local/bin/opencode",
  });
  expect(relay.ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(
    forwarder.open.mock.invocationCallOrder[0]
  );
  expect(forwarder.open.mock.calls[0][1]).toEqual({
    host: "172.17.0.9",
    relay: { port: 4097, token },
  });
  expect(store.runtime(project.id).relay).toBe("active");
  expect(orch.logLines(project.id)).toContain("relay: active (bun)");
});

it("forwards directly and still starts when the relay is unavailable", async () => {
  const { store, relay, forwarder, orch } = setup();
  relay.ensureRunning.mockResolvedValueOnce({
    status: "unavailable",
    reason: "no relay runtime",
  });
  await orch.rescan();
  await orch.start(project.id);
  expect(forwarder.open.mock.calls[0][1]).toEqual({ host: "172.17.0.9" });
  expect(store.runtime(project.id)).toMatchObject({
    relay: "unavailable",
    opencode: "healthy",
    error: undefined,
  });
  expect(orch.logLines(project.id)).toContain(
    "relay: unavailable (no relay runtime)"
  );
});

it("reuses the persisted relay token across restarts and adoption", async () => {
  const { relay, containers, orch } = setup({
    projects: { [project.id]: { password: "pw", relayToken: "kept" } },
  });
  containers.listManaged.mockResolvedValueOnce([running]);
  await orch.rescan();
  await orch.adopt();
  expect(relay.ensureRunning.mock.calls[0][1].token).toBe("kept");
});

it("stop stops the relay and clears the relay status", async () => {
  const { store, relay, orch } = setup();
  await orch.rescan();
  await orch.start(project.id);
  await orch.stop(project.id);
  expect(relay.stop).toHaveBeenCalledWith(project);
  expect(store.runtime(project.id).relay).toBeUndefined();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/server/state.test.ts test/server/orchestrator.test.ts` Expected: FAIL — the new state test and the four relay tests fail; the three updated assertions fail too.

- [ ] **Step 4: Types, config and state**

`src/shared/types.ts`: add to `ProjectRuntime` after `ports?: ForwardedPort[];`:

```ts
  relayToken?: string;
  relay?: "active" | "unavailable";
```

and change `export type PublicRuntime = Omit<ProjectRuntime, "password">;` to `export type PublicRuntime = Omit<ProjectRuntime, "password" | "relayToken">;`

`src/server/config.ts`: add `relayToken?: string;` to `PersistedRuntime`.

`src/server/state.ts`:

- `const DURABLE_KEYS = ["containerId", "password", "workspaceFolder", "relayToken"] as const;`
- in `snapshot()`: `const { password: _password, relayToken: _relayToken, ...runtime } = this.runtime(project.id);`
- in `save()`: condition `if (r.containerId || r.password || r.workspaceFolder || r.relayToken)` and the object `{ containerId: r.containerId, password: r.password, workspaceFolder: r.workspaceFolder, relayToken: r.relayToken }`.

The existing state test "persists only durable fields…" expects an object without `relayToken`; `toEqual` ignores `undefined` properties, so it keeps passing.

- [ ] **Step 5: Orchestrator**

In `src/server/orchestrator.ts`:

Imports: add

```ts
import type { ForwardTarget } from "./port-forwarder";
import {
  RELAY_PORT,
  type RelayRuntime,
  generateRelayToken,
} from "./relay/runtime";
```

Types:

```ts
export type RuntimePort = Pick<
  OpencodeRuntime,
  "ensureRunning" | "stopServer" | "isHealthy" | "endpoint" | "resolveBinary"
>;
export type RelayPort = Pick<RelayRuntime, "ensureRunning" | "stop">;
```

and `relay: RelayPort;` in `OrchestratorDeps` (after `forwarder`).

In `bringUp`, replace `await this.forwardPorts(project, info.ip);` with

```ts
await this.forwardPorts(project, await this.startRelay(project, info.ip));
```

In `adopt`, replace `if (info.ip) await this.forwardPorts(store.project(id)!, info.ip);` with

```ts
if (info.ip) {
  const adopted = store.project(id)!;
  await this.forwardPorts(adopted, await this.startRelay(adopted, info.ip));
}
```

In `stop`, change

```ts
if (rt.containerState === "running")
  await runtime.stopServer(p).catch(() => {});
```

to

```ts
if (rt.containerState === "running") {
  await runtime.stopServer(p).catch(() => {});
  await this.deps.relay.stop(p).catch(() => {});
}
```

In `forwardPorts`, change the signature to `private async forwardPorts(project: Project, target: ForwardTarget): Promise<void>` and the call to `forwarder.open(project.id, target, ports, (line) => this.log(project.id, line))`.

In `closePorts`, change the update to `this.deps.store.updateRuntime(id, { ports: undefined, relay: undefined });`.

Add the private method (next to `forwardPorts`):

```ts
  private async startRelay(project: Project, ip: string): Promise<ForwardTarget> {
    const { store, runtime, relay } = this.deps;
    let token = store.runtime(project.id).relayToken;
    if (!token) {
      token = generateRelayToken();
      store.updateRuntime(project.id, { relayToken: token });
    }
    const binary = await runtime.resolveBinary(project).catch(() => undefined);
    const result = await relay.ensureRunning(project, { ip, token, binary });
    if (result.status === "active") {
      this.log(project.id, `relay: active (${result.via})`);
      store.updateRuntime(project.id, { relay: "active" });
      return { host: ip, relay: { port: RELAY_PORT, token } };
    }
    this.log(project.id, `relay: unavailable (${result.reason})`);
    store.updateRuntime(project.id, { relay: "unavailable" });
    return { host: ip };
  }
```

- [ ] **Step 6: CLI and e2e constructor**

`src/server/cli.ts`: add `import { RelayRuntime } from "./relay/runtime";` and pass `relay: new RelayRuntime({ containers }),` in `new Orchestrator({ … })`.

`test/e2e/opendevhub.e2e.ts`: add `import { RelayRuntime } from "../../src/server/relay/runtime";` and pass `relay: new RelayRuntime({ containers }),` in `new Orchestrator({ … })`.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx tsc --noEmit && npx vitest run` Expected: all PASS, type check clean (the Task 3 orchestrator error is gone).

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/server/config.ts src/server/state.ts src/server/orchestrator.ts src/server/cli.ts test/server/state.test.ts test/server/orchestrator.test.ts test/e2e/opendevhub.e2e.ts
git commit -m "feat: start the container relay with each project and forward through it"
```

---

### Task 6: Dashboard hint, e2e and README

**Files:**

- Modify: `src/web/components/PortsRow.tsx`, `src/web/components/ProjectCard.tsx`, `test/e2e/opendevhub.e2e.ts`, `README.md`

**Interfaces:**

- Consumes: `runtime.relay` (Task 5).
- Produces: `PortsRow({ ports, relay }: { ports: ForwardedPort[]; relay?: "active" | "unavailable" })`.

- [ ] **Step 1: Ports row hint**

In `src/web/components/PortsRow.tsx` change the signature to

```tsx
export function PortsRow({ ports, relay }: { ports: ForwardedPort[]; relay?: "active" | "unavailable" }) {
```

and add, as the last child of the `<ul>` (after the `ports.map(...)` expression):

```tsx
{
  relay && (
    <li
      className="muted"
      title={
        relay === "active"
          ? "Connections go through a relay inside the container, so apps bound to localhost there are reachable"
          : "No relay in the container; only apps listening on 0.0.0.0 are reachable (see the project log)"
      }
    >
      {relay === "active" ? "via relay" : "direct"}
    </li>
  );
}
```

In `src/web/components/ProjectCard.tsx` change `<PortsRow ports={runtime.ports} />` to `<PortsRow ports={runtime.ports} relay={runtime.relay} />`.

- [ ] **Step 2: e2e — loopback-only server**

In `test/e2e/opendevhub.e2e.ts`:

- in the `containers.exec(...)` call that starts the web server, change `.listen(8080)` to `.listen(8080, '127.0.0.1')` (single quotes, like the existing `'http'` in the same string), and extend the comment above it: the server binds the container's loopback only, so it is reachable only through the relay;
- directly after `expect(rt).toMatchObject({ containerState: "running", opencode: "healthy" });` add `expect(rt.relay).toBe("active");`.

Because the web server is started after `orch.start`, the forward already exists; the relay connects on each request, so no other change is needed.

- [ ] **Step 3: Run the e2e test**

Run: `npm run test:e2e` Expected: PASS. Then confirm the fixture container is stopped: `docker ps --filter label=opendevhub.project=fixture-3ed7c1 -q` prints nothing (stop only that container if it is listed; never stop other `opendevhub.project` containers — they belong to the user's real projects).

- [ ] **Step 4: README**

In `README.md`, replace the Known-limitations bullet that starts with "- Forwarded apps must listen on `0.0.0.0` inside the container" with:

```markdown
- Forwarded ports go through a small relay that opendevhub starts inside the container, so apps bound to the container's `localhost` work too. The relay runs on the opencode binary (Bun mode) or `node`; if neither can run it, forwarding connects directly and only apps listening on `0.0.0.0` are reachable (the project log says so).
```

- [ ] **Step 5: Final verification and commit**

Run: `npx tsc --noEmit && npx vitest run && npm run build` Expected: all green.

```bash
git add src/web/components/PortsRow.tsx src/web/components/ProjectCard.tsx test/e2e/opendevhub.e2e.ts README.md
git commit -m "feat: show relay status on the card; e2e forwards a loopback-only app"
```
