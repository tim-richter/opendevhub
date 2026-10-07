# Port Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward every `forwardPorts` entry of a running project's devcontainer to `127.0.0.1` on the host (same port, or the next free one) and show the mappings on the dashboard.

**Architecture:** `Containers.readConfiguration` reads the merged devcontainer config via the devcontainer CLI; a pure `parseForwardPorts` turns it into port specs; a `PortForwarder` (`node:net`) listens on the host and pipes TCP to the container's bridge IP. The `Orchestrator` opens forwards once a container is running (start, rebuild, adopt) and closes them on stop, external stop and shutdown; results land in `ProjectRuntime.ports` and are rendered by a `PortsRow` component.

**Tech Stack:** existing — Node ≥ 20, TypeScript 7, vitest 5, React 19, `node:net`.

**Spec:** `docs/superpowers/specs/2026-09-30-port-forwarding-design.md` (extends `docs/superpowers/specs/2026-09-30-opendevhub-design.md`)

## Global Constraints

- Listeners bind `127.0.0.1` only.
- Host port selection: try `containerPort`, then `+1 … +100` (never above 65535); only `EADDRINUSE` moves on to the next candidate; any other listen error → `failed` for that port.
- Accepted `forwardPorts` entries: integers 1–65535, `"<n>"`, `"localhost:<n>"`, `"127.0.0.1:<n>"`. Everything else is `skipped` with a reason. Duplicates collapse.
- `portsAttributes["<n>"].label` is the only attribute used.
- Config source: `devcontainer read-configuration --workspace-folder <path> --id-label opendevhub.project=<id> --include-merged-configuration`, timeout 60 s; use `mergedConfiguration`, fall back to `configuration`.
- Forwarding problems never change `containerState`/`opencode` and never set `runtime.error`; they surface as per-port status and log lines prefixed `ports: `.
- Upstream connection errors: log at most once per port per 30 s.
- `ProjectRuntime.ports` is public (sent to the dashboard) and never persisted.
- Linux only (container bridge IP reachable from host), like the rest of opendevhub.
- Imports are extensionless; commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Two projects forwarding the same port**: the second must land on the next free port, not fail — pinned in Task 3 tests.
- **App inside the container not listening yet**: a connection to the forwarded port just closes; the listener survives and later connections work — pinned in Task 3 tests.
- **Stop then Start**: stopping frees the host port at once, so the restart gets the original port back — pinned in Task 3 tests.
- **Rebuild changes the container IP**: old forwards are closed and new ones opened against the new IP — pinned in Task 4 tests.
- **Broken or unreadable devcontainer config**: the project still starts; ports are empty and a log line explains why — pinned in Task 4 tests.

---

## File Structure

```
src/shared/types.ts                 + ForwardedPort, ProjectRuntime.ports
src/server/ports.ts                 new: PortSpec, SkippedPort, parseForwardPorts()
src/server/containers.ts            + PortConfig, Containers.readConfiguration()
src/server/port-forwarder.ts        new: PortForwarder
src/server/orchestrator.ts          forwarding lifecycle, async shutdown()
src/server/cli.ts                   wire PortForwarder, await shutdown
src/web/components/PortsRow.tsx     new
src/web/components/ProjectCard.tsx  render PortsRow
src/web/styles.css                  .ports styles
test/server/ports.test.ts           new
test/server/containers.test.ts      + readConfiguration tests
test/server/port-forwarder.test.ts  new
test/server/orchestrator.test.ts    + forwarding tests, fakes in setup()
test/e2e/fixture/.devcontainer/devcontainer.json  + forwardPorts, postStartCommand
test/e2e/opendevhub.e2e.ts          + forwarder, port assertions
README.md                           + port forwarding note
```

---

### Task 1: Port types and `parseForwardPorts`

**Files:**

- Modify: `src/shared/types.ts`
- Create: `src/server/ports.ts`
- Test: `test/server/ports.test.ts`

**Interfaces:**

- Produces:
  - in `src/shared/types.ts`:
    ```ts
    export type ForwardedPort =
      | {
          status: "forwarded";
          containerPort: number;
          label?: string;
          hostPort: number;
        }
      | {
          status: "failed";
          containerPort: number;
          label?: string;
          reason: string;
        }
      | { status: "skipped"; entry: string; reason: string };
    ```
    and `ports?: ForwardedPort[]` on `ProjectRuntime` (so also on `PublicRuntime`).
  - in `src/server/ports.ts`: `interface PortSpec { containerPort: number; label?: string }`, `interface SkippedPort { entry: string; reason: string }`, `parseForwardPorts(forwardPorts: unknown, portsAttributes: unknown): { ports: PortSpec[]; skipped: SkippedPort[] }`.

- [ ] **Step 1: Add the shared type**

In `src/shared/types.ts`, add after `export type OpencodeState = …`:

```ts
export type ForwardedPort =
  | {
      status: "forwarded";
      containerPort: number;
      label?: string;
      hostPort: number;
    }
  | { status: "failed"; containerPort: number; label?: string; reason: string }
  | { status: "skipped"; entry: string; reason: string };
```

and add `ports?: ForwardedPort[];` to `ProjectRuntime` directly after `error?: string;`.

- [ ] **Step 2: Write the failing tests**

`test/server/ports.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseForwardPorts } from "../../src/server/ports";

describe("parseForwardPorts", () => {
  it("accepts numbers and numeric/local host strings, in order", () => {
    expect(
      parseForwardPorts([3000, "5173", "localhost:8080", "127.0.0.1:9229"], {})
    ).toEqual({
      ports: [
        { containerPort: 3000 },
        { containerPort: 5173 },
        { containerPort: 8080 },
        { containerPort: 9229 },
      ],
      skipped: [],
    });
  });

  it("attaches labels from portsAttributes", () => {
    expect(
      parseForwardPorts([3000, 5432], {
        "3000": { label: "web" },
        "5432": { label: 42 },
      }).ports
    ).toEqual([{ containerPort: 3000, label: "web" }, { containerPort: 5432 }]);
  });

  it("collapses duplicates, keeping the first", () => {
    expect(
      parseForwardPorts([3000, "localhost:3000", "3000"], {}).ports
    ).toEqual([{ containerPort: 3000 }]);
  });

  it("skips service hosts and invalid entries with reasons", () => {
    const { ports, skipped } = parseForwardPorts(
      ["db:5432", 0, 70000, 3.5, "abc", null, { port: 1 }],
      {}
    );
    expect(ports).toEqual([]);
    expect(skipped).toEqual([
      { entry: "db:5432", reason: "service hosts are not supported yet" },
      { entry: "0", reason: "not a valid port number (1–65535)" },
      { entry: "70000", reason: "not a valid port number (1–65535)" },
      { entry: "3.5", reason: "not a valid port number (1–65535)" },
      { entry: "abc", reason: "not a valid port entry" },
      { entry: "null", reason: "not a valid port entry" },
      { entry: '{"port":1}', reason: "not a valid port entry" },
    ]);
  });

  it("treats missing or malformed inputs as empty", () => {
    expect(parseForwardPorts(undefined, undefined)).toEqual({
      ports: [],
      skipped: [],
    });
    expect(parseForwardPorts("3000", "x")).toEqual({ ports: [], skipped: [] });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/server/ports.test.ts` Expected: FAIL — cannot resolve `../../src/server/ports`.

- [ ] **Step 4: Implement**

`src/server/ports.ts`:

```ts
export interface PortSpec {
  containerPort: number;
  label?: string;
}

export interface SkippedPort {
  entry: string;
  reason: string;
}

const INVALID_NUMBER = "not a valid port number (1–65535)";
const LOCAL_ENTRY = /^(?:(?:localhost|127\.0\.0\.1):)?(\d+)$/i;
const SERVICE_ENTRY = /^[^:\s]+:\d+$/;

function describe(entry: unknown): string {
  return typeof entry === "string"
    ? entry
    : (JSON.stringify(entry) ?? String(entry));
}

function isPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function toPort(entry: unknown): number | string {
  if (typeof entry === "number") return isPort(entry) ? entry : INVALID_NUMBER;
  if (typeof entry !== "string") return "not a valid port entry";
  const text = entry.trim();
  const local = text.match(LOCAL_ENTRY);
  if (local) {
    const n = Number(local[1]);
    return isPort(n) ? n : INVALID_NUMBER;
  }
  if (SERVICE_ENTRY.test(text)) return "service hosts are not supported yet";
  return "not a valid port entry";
}

export function parseForwardPorts(
  forwardPorts: unknown,
  portsAttributes: unknown
): { ports: PortSpec[]; skipped: SkippedPort[] } {
  const attrs =
    portsAttributes && typeof portsAttributes === "object"
      ? (portsAttributes as Record<string, unknown>)
      : {};
  const ports: PortSpec[] = [];
  const skipped: SkippedPort[] = [];
  const seen = new Set<number>();
  for (const entry of Array.isArray(forwardPorts) ? forwardPorts : []) {
    const port = toPort(entry);
    if (typeof port === "string") {
      skipped.push({ entry: describe(entry), reason: port });
      continue;
    }
    if (seen.has(port)) continue;
    seen.add(port);
    const label = (attrs[String(port)] as { label?: unknown } | undefined)
      ?.label;
    ports.push(
      typeof label === "string"
        ? { containerPort: port, label }
        : { containerPort: port }
    );
  }
  return { ports, skipped };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/server/ports.test.ts && npx tsc --noEmit` Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/server/ports.ts test/server/ports.test.ts
git commit -m "feat: parse devcontainer forwardPorts into port specs"
```

---

### Task 2: `Containers.readConfiguration`

**Files:**

- Modify: `src/server/containers.ts`
- Test: `test/server/containers.test.ts`

**Interfaces:**

- Consumes: `Containers` internals (`run`, `idArgs`, `CommandError`, `tailLines`) from the existing file.
- Produces: `interface PortConfig { forwardPorts: unknown[]; portsAttributes: Record<string, unknown> }` and `Containers.readConfiguration(project: Project): Promise<PortConfig>` (throws `CommandError` on non-zero exit or invalid JSON).

Verified against devcontainer CLI 0.89: the command works without a running container, prints one JSON object with `configuration` and `mergedConfiguration`, and the merged form normalises `"localhost:5173"` to `5173` while keeping `"db:5432"`.

- [ ] **Step 1: Write the failing tests**

Append to `test/server/containers.test.ts` (inside the file, as a new `describe`; `project`, `LABEL`, `CommandError`, `Containers` and `fakeRunner` are already imported/defined there):

```ts
describe("Containers.readConfiguration", () => {
  it("runs read-configuration with the id label and merged config, preferring mergedConfiguration", async () => {
    const stdout = JSON.stringify({
      configuration: { forwardPorts: [1] },
      mergedConfiguration: {
        forwardPorts: [3000, "db:5432"],
        portsAttributes: { "3000": { label: "web" } },
      },
    });
    const { run, calls } = fakeRunner(() => ({ stdout }));
    const cfg = await new Containers(run).readConfiguration(project);
    expect(calls[0].args).toEqual([
      "read-configuration",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
      "--include-merged-configuration",
    ]);
    expect(calls[0].opts?.timeoutMs).toBe(60_000);
    expect(cfg).toEqual({
      forwardPorts: [3000, "db:5432"],
      portsAttributes: { "3000": { label: "web" } },
    });
  });

  it("falls back to configuration and defaults missing fields", async () => {
    const { run } = fakeRunner(() => ({
      stdout: JSON.stringify({ configuration: { forwardPorts: [8080] } }),
    }));
    expect(await new Containers(run).readConfiguration(project)).toEqual({
      forwardPorts: [8080],
      portsAttributes: {},
    });
    const empty = fakeRunner(() => ({ stdout: "{}" }));
    expect(await new Containers(empty.run).readConfiguration(project)).toEqual({
      forwardPorts: [],
      portsAttributes: {},
    });
  });

  it("throws CommandError on failure or invalid output", async () => {
    const failed = fakeRunner(() => ({
      exitCode: 1,
      stderr: "Dev container config not found",
    }));
    await expect(
      new Containers(failed.run).readConfiguration(project)
    ).rejects.toBeInstanceOf(CommandError);
    const garbage = fakeRunner(() => ({ stdout: "not json" }));
    await expect(
      new Containers(garbage.run).readConfiguration(project)
    ).rejects.toThrow(/invalid JSON/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/containers.test.ts` Expected: FAIL — `readConfiguration is not a function`.

- [ ] **Step 3: Implement**

In `src/server/containers.ts` add, next to the other interfaces:

```ts
export interface PortConfig {
  forwardPorts: unknown[];
  portsAttributes: Record<string, unknown>;
}
```

and this method inside `class Containers` (after `up`):

```ts
  async readConfiguration(project: Project): Promise<PortConfig> {
    const r = await this.run(
      "devcontainer",
      ["read-configuration", ...this.idArgs(project), "--include-merged-configuration"],
      { timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) {
      throw new CommandError(`devcontainer read-configuration failed (exit ${r.exitCode})`, tailLines(r.stderr));
    }
    let parsed: { configuration?: Record<string, unknown>; mergedConfiguration?: Record<string, unknown> };
    try {
      parsed = JSON.parse(r.stdout.trim()) as typeof parsed;
    } catch {
      throw new CommandError("devcontainer read-configuration returned invalid JSON", tailLines(r.stdout));
    }
    const cfg = parsed.mergedConfiguration ?? parsed.configuration ?? {};
    const attrs = cfg.portsAttributes;
    return {
      forwardPorts: Array.isArray(cfg.forwardPorts) ? cfg.forwardPorts : [],
      portsAttributes: attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : {},
    };
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/server/containers.test.ts && npx tsc --noEmit` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/containers.ts test/server/containers.test.ts
git commit -m "feat: read forwardPorts via devcontainer read-configuration"
```

---

### Task 3: `PortForwarder`

**Files:**

- Create: `src/server/port-forwarder.ts`
- Test: `test/server/port-forwarder.test.ts`

**Interfaces:**

- Consumes: `PortSpec` (Task 1), `ForwardedPort` (Task 1).
- Produces:
  ```ts
  class PortForwarder {
    constructor(opts?: {
      bindHost?: string;
      maxOffset?: number;
      logIntervalMs?: number;
    });
    open(
      projectId: string,
      targetHost: string,
      ports: PortSpec[],
      onLog?: (line: string) => void
    ): Promise<ForwardedPort[]>;
    close(projectId: string): Promise<void>;
    closeAll(): Promise<void>;
  }
  ```
  `open` never rejects; it replaces any existing forwards of that project; results are in `ports` order and only contain `forwarded`/`failed` entries. Defaults: `bindHost "127.0.0.1"`, `maxOffset 100`, `logIntervalMs 30_000`.

Tests run upstream servers on `127.0.0.2` (any 127/8 address is loopback on Linux) so the forwarder can bind the same port number on `127.0.0.1`.

- [ ] **Step 1: Write the failing tests**

`test/server/port-forwarder.test.ts`:

```ts
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { PortForwarder } from "../../src/server/port-forwarder";
import type { ForwardedPort } from "../../src/shared/types";

const servers: net.Server[] = [];
let forwarder: PortForwarder;

afterEach(async () => {
  await forwarder?.closeAll();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r)))
  );
});

function listen(
  server: net.Server,
  port: number,
  host: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () =>
      resolve((server.address() as net.AddressInfo).port)
    );
  });
}

/** Echo server on 127.0.0.2 that prefixes replies, so we know which upstream answered. */
async function echoUpstream(prefix = "echo:"): Promise<number> {
  const server = net.createServer((s) =>
    s.on("data", (d) => s.write(prefix + d.toString()))
  );
  servers.push(server);
  return listen(server, 0, "127.0.0.2");
}

async function blocker(port: number): Promise<void> {
  const server = net.createServer();
  servers.push(server);
  await listen(server, port, "127.0.0.1");
}

function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(message));
    socket.once("data", (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

function closedOrReset(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

const hostPort = (p: ForwardedPort) =>
  p.status === "forwarded" ? p.hostPort : -1;

describe("PortForwarder", () => {
  it("forwards the same port number and pipes bytes both ways", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    const [result] = await forwarder.open("p1", "127.0.0.2", [
      { containerPort: port, label: "web" },
    ]);
    expect(result).toEqual({
      status: "forwarded",
      containerPort: port,
      label: "web",
      hostPort: port,
    });
    expect(await roundTrip(port, "hi")).toBe("echo:hi");
  });

  it("moves to the next free port when the host port is taken", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    await blocker(port);
    const [result] = await forwarder.open("p1", "127.0.0.2", [
      { containerPort: port },
    ]);
    expect(result.status).toBe("forwarded");
    expect(hostPort(result)).toBeGreaterThan(port);
    expect(await roundTrip(hostPort(result), "x")).toBe("echo:x");
  });

  it("gives a second project with the same port the next free port", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    const [a] = await forwarder.open("p1", "127.0.0.2", [
      { containerPort: port },
    ]);
    const [b] = await forwarder.open("p2", "127.0.0.2", [
      { containerPort: port },
    ]);
    expect(hostPort(a)).toBe(port);
    expect(hostPort(b)).toBeGreaterThan(port);
  });

  it("reports failed when no candidate is free", async () => {
    forwarder = new PortForwarder({ maxOffset: 0 });
    const port = await echoUpstream();
    await blocker(port);
    const [result] = await forwarder.open("p1", "127.0.0.2", [
      { containerPort: port },
    ]);
    expect(result).toEqual({
      status: "failed",
      containerPort: port,
      reason: `no free host port in ${port}–${port}`,
    });
  });

  it("reports non-EADDRINUSE listen errors as failed without trying more ports", async () => {
    forwarder = new PortForwarder({ bindHost: "192.0.2.1" });
    const [result] = await forwarder.open("p1", "127.0.0.2", [
      { containerPort: 45123 },
    ]);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toMatch(
      /EADDRNOTAVAIL/
    );
  });

  it("survives an upstream that is not listening yet and logs once", async () => {
    forwarder = new PortForwarder({ logIntervalMs: 60_000 });
    const probe = net.createServer();
    const port = await listen(probe, 0, "127.0.0.2");
    await new Promise((r) => probe.close(r));
    const logs: string[] = [];
    const [result] = await forwarder.open(
      "p1",
      "127.0.0.2",
      [{ containerPort: port }],
      (l) => logs.push(l)
    );
    await closedOrReset(hostPort(result));
    await closedOrReset(hostPort(result));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(new RegExp(`^ports: ${port}: `));
    const upstream = net.createServer((s) =>
      s.on("data", (d) => s.write("late:" + d.toString()))
    );
    servers.push(upstream);
    await listen(upstream, port, "127.0.0.2");
    expect(await roundTrip(hostPort(result), "x")).toBe("late:x");
  });

  it("close frees the port and ends open connections; reopening gets the same port", async () => {
    forwarder = new PortForwarder();
    const port = await echoUpstream();
    await forwarder.open("p1", "127.0.0.2", [{ containerPort: port }]);
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    const ended = new Promise((r) => socket.once("close", r));
    await forwarder.close("p1");
    await ended;
    await closedOrReset(port);
    const [again] = await forwarder.open("p1", "127.0.0.2", [
      { containerPort: port },
    ]);
    expect(hostPort(again)).toBe(port);
  });

  it("open replaces a project's previous forwards", async () => {
    forwarder = new PortForwarder();
    const first = await echoUpstream("one:");
    const second = await echoUpstream("two:");
    await forwarder.open("p1", "127.0.0.2", [{ containerPort: first }]);
    await forwarder.open("p1", "127.0.0.2", [{ containerPort: second }]);
    await closedOrReset(first);
    expect(await roundTrip(second, "x")).toBe("two:x");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/port-forwarder.test.ts` Expected: FAIL — cannot resolve `../../src/server/port-forwarder`.

- [ ] **Step 3: Implement**

`src/server/port-forwarder.ts`:

```ts
import net from "node:net";

import type { ForwardedPort } from "../shared/types";
import type { PortSpec } from "./ports";

interface Forward {
  server: net.Server;
  sockets: Set<net.Socket>;
}

export interface PortForwarderOptions {
  bindHost?: string;
  maxOffset?: number;
  logIntervalMs?: number;
}

function listen(
  server: net.Server,
  port: number,
  host: string
): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export class PortForwarder {
  private readonly forwards = new Map<string, Forward[]>();

  constructor(private readonly opts: PortForwarderOptions = {}) {}

  async open(
    projectId: string,
    targetHost: string,
    ports: PortSpec[],
    onLog: (line: string) => void = () => {}
  ): Promise<ForwardedPort[]> {
    await this.close(projectId);
    const list: Forward[] = [];
    this.forwards.set(projectId, list);
    const results: ForwardedPort[] = [];
    for (const spec of ports)
      results.push(await this.openOne(spec, targetHost, list, onLog));
    return results;
  }

  async close(projectId: string): Promise<void> {
    const list = this.forwards.get(projectId);
    if (!list) return;
    this.forwards.delete(projectId);
    await Promise.all(
      list.map(
        (f) =>
          new Promise<void>((resolve) => {
            for (const s of f.sockets) s.destroy();
            f.server.close(() => resolve());
          })
      )
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.forwards.keys()].map((id) => this.close(id)));
  }

  private async openOne(
    spec: PortSpec,
    targetHost: string,
    list: Forward[],
    onLog: (line: string) => void
  ): Promise<ForwardedPort> {
    const labelled = spec.label === undefined ? {} : { label: spec.label };
    const sockets = new Set<net.Socket>();
    const logIntervalMs = this.opts.logIntervalMs ?? 30_000;
    let lastLog = -Infinity;

    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      const upstream = net.connect({
        host: targetHost,
        port: spec.containerPort,
        allowHalfOpen: true,
      });
      sockets.add(client);
      sockets.add(upstream);
      const destroy = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", destroy);
      client.on("close", destroy);
      upstream.on("error", (err) => {
        const now = Date.now();
        if (now - lastLog >= logIntervalMs) {
          lastLog = now;
          onLog(`ports: ${spec.containerPort}: ${err.message}`);
        }
        destroy();
      });
      upstream.on("close", destroy);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    const bindHost = this.opts.bindHost ?? "127.0.0.1";
    const last = Math.min(
      65535,
      spec.containerPort + (this.opts.maxOffset ?? 100)
    );
    for (let port = spec.containerPort; port <= last; port++) {
      const err = await listen(server, port, bindHost);
      if (!err) {
        server.on("error", () => {});
        list.push({ server, sockets });
        return {
          status: "forwarded",
          containerPort: spec.containerPort,
          ...labelled,
          hostPort: port,
        };
      }
      if (err.code !== "EADDRINUSE") {
        return {
          status: "failed",
          containerPort: spec.containerPort,
          ...labelled,
          reason: err.message,
        };
      }
    }
    return {
      status: "failed",
      containerPort: spec.containerPort,
      ...labelled,
      reason: `no free host port in ${spec.containerPort}–${last}`,
    };
  }
}
```

- [ ] **Step 4: Run tests (3× for flakiness) and typecheck**

Run: `for i in 1 2 3; do npx vitest run test/server/port-forwarder.test.ts || break; done; npx tsc --noEmit` Expected: PASS every run; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/port-forwarder.ts test/server/port-forwarder.test.ts
git commit -m "feat: TCP port forwarder with next-free-port fallback"
```

---

### Task 4: Orchestrator lifecycle and CLI wiring

**Files:**

- Modify: `src/server/orchestrator.ts`, `src/server/cli.ts`, `test/e2e/opendevhub.e2e.ts` (constructor only)
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**

- Consumes: `Containers.readConfiguration` (Task 2), `parseForwardPorts` (Task 1), `PortForwarder` (Task 3).
- Produces:
  - `ContainersPort` gains `"readConfiguration"`.
  - `type ForwarderPort = Pick<PortForwarder, "open" | "close" | "closeAll">`; `OrchestratorDeps.forwarder: ForwarderPort` (required).
  - `Orchestrator.shutdown(): Promise<void>` (was `void`).
  - Forwarding: after a successful bring-up reaches `containerState: "running"` (before opencode launch), and in `adopt()` for running containers with an IP. Closing: `stop`, `rebuild` (before bring-up), `refreshContainers` when the container is gone, `shutdown`. `runtime.ports` is set to the forwarder results plus skipped entries, and cleared (`undefined`) on close.

- [ ] **Step 1: Extend the test setup and write the failing tests**

In `test/server/orchestrator.test.ts`:

Add imports:

```ts
import type { PortSpec } from "../../src/server/ports";
import type { ForwardedPort } from "../../src/shared/types";
```

In `setup()`, add to the `containers` object:

```ts
    readConfiguration: vi.fn(async (_p?: Project) => ({
      forwardPorts: [3000, "db:5432"] as unknown[],
      portsAttributes: { "3000": { label: "web" } } as Record<string, unknown>,
    })),
```

and after `runtime` add:

```ts
const forwarder = {
  open: vi.fn(
    async (
      _id: string,
      _host: string,
      ports: PortSpec[],
      _onLog?: (l: string) => void
    ) =>
      ports.map((p): ForwardedPort => ({
        status: "forwarded",
        containerPort: p.containerPort,
        label: p.label,
        hostPort: p.containerPort,
      }))
  ),
  close: vi.fn(async (_id: string) => {}),
  closeAll: vi.fn(async () => {}),
};
```

pass `forwarder` in the `new Orchestrator({ … })` call, and return it: `return { store, containers, runtime, orch, monitors, forwarder };`.

Append these tests inside `describe("Orchestrator", …)`:

```ts
it("forwards configured ports on start, including skipped entries in runtime.ports", async () => {
  const { store, orch, forwarder } = setup();
  await orch.rescan();
  await orch.start(project.id);
  expect(forwarder.open).toHaveBeenCalledWith(
    project.id,
    "172.17.0.9",
    [{ containerPort: 3000, label: "web" }],
    expect.any(Function)
  );
  expect(store.runtime(project.id).ports).toEqual([
    { status: "forwarded", containerPort: 3000, label: "web", hostPort: 3000 },
    {
      status: "skipped",
      entry: "db:5432",
      reason: "service hosts are not supported yet",
    },
  ]);
  expect(orch.logLines(project.id)).toContain("ports: 3000 → localhost:3000");
  expect(orch.logLines(project.id)).toContain(
    "ports: skipped db:5432 (service hosts are not supported yet)"
  );
});

it("forwards ports before launching opencode, so they survive an opencode failure", async () => {
  const { store, runtime, orch, forwarder } = setup();
  runtime.ensureRunning.mockRejectedValueOnce(
    new CommandError(
      "opencode 1.18.31 found, but opendevhub requires opencode v2"
    )
  );
  await orch.rescan();
  await orch.start(project.id);
  expect(forwarder.open).toHaveBeenCalled();
  expect(store.runtime(project.id).ports).toHaveLength(2);
  expect(store.runtime(project.id).opencode).toBe("unhealthy");
});

it("still starts when the devcontainer config cannot be read", async () => {
  const { store, containers, orch, forwarder } = setup();
  containers.readConfiguration.mockRejectedValueOnce(
    new CommandError("devcontainer read-configuration failed (exit 1)")
  );
  await orch.rescan();
  await orch.start(project.id);
  expect(forwarder.open).not.toHaveBeenCalled();
  expect(store.runtime(project.id)).toMatchObject({
    containerState: "running",
    opencode: "healthy",
    ports: [],
    error: undefined,
  });
  expect(orch.logLines(project.id)).toContain(
    "ports: could not read devcontainer configuration: devcontainer read-configuration failed (exit 1)"
  );
});

it("logs failed forwards without touching the project error", async () => {
  const { store, orch, forwarder } = setup();
  forwarder.open.mockResolvedValueOnce([
    {
      status: "failed",
      containerPort: 3000,
      label: "web",
      reason: "no free host port in 3000–3100",
    },
  ]);
  await orch.rescan();
  await orch.start(project.id);
  expect(store.runtime(project.id).error).toBeUndefined();
  expect(orch.logLines(project.id)).toContain(
    "ports: 3000 not forwarded (no free host port in 3000–3100)"
  );
});

it("stop closes the forwards and clears runtime.ports", async () => {
  const { store, orch, forwarder } = setup();
  await orch.rescan();
  await orch.start(project.id);
  await orch.stop(project.id);
  expect(forwarder.close).toHaveBeenCalledWith(project.id);
  expect(store.runtime(project.id).ports).toBeUndefined();
});

it("rebuild closes old forwards and reopens against the new container IP", async () => {
  const { containers, orch, forwarder } = setup();
  await orch.rescan();
  await orch.start(project.id);
  containers.inspect.mockResolvedValue({ ...running, ip: "172.17.0.42" });
  await orch.rebuild(project.id);
  expect(forwarder.close).toHaveBeenCalledWith(project.id);
  expect(forwarder.close.mock.invocationCallOrder[0]).toBeLessThan(
    forwarder.open.mock.invocationCallOrder[1]
  );
  expect(forwarder.open.mock.calls[1][1]).toBe("172.17.0.42");
});

it("adopt forwards ports of running containers only", async () => {
  const { store, containers, orch, forwarder } = setup({
    projects: { [project.id]: { password: "pw" } },
  });
  containers.listManaged.mockResolvedValueOnce([running]);
  await orch.rescan();
  await orch.adopt();
  expect(forwarder.open).toHaveBeenCalledWith(
    project.id,
    "172.17.0.9",
    [{ containerPort: 3000, label: "web" }],
    expect.any(Function)
  );
  expect(store.runtime(project.id).ports).toHaveLength(2);

  const stopped = setup();
  stopped.containers.listManaged.mockResolvedValueOnce([
    { ...running, running: false },
  ]);
  await stopped.orch.rescan();
  await stopped.orch.adopt();
  expect(stopped.forwarder.open).not.toHaveBeenCalled();
});

it("refreshContainers closes forwards of containers that went away", async () => {
  const { store, containers, orch, forwarder } = setup();
  await orch.rescan();
  await orch.start(project.id);
  containers.inspect.mockResolvedValueOnce({ ...running, running: false });
  await orch.refreshContainers();
  expect(forwarder.close).toHaveBeenCalledWith(project.id);
  expect(store.runtime(project.id).ports).toBeUndefined();
});

it("shutdown closes all forwards", async () => {
  const { orch, forwarder } = setup();
  await orch.shutdown();
  expect(forwarder.closeAll).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/orchestrator.test.ts` Expected: FAIL — the new tests fail (`forwarder.open` never called, `ports` undefined); existing tests still pass.

- [ ] **Step 3: Implement in the orchestrator**

In `src/server/orchestrator.ts`:

Imports — add:

```ts
import type { ForwardedPort } from "../shared/types";
import type { PortForwarder } from "./port-forwarder";
import { parseForwardPorts } from "./ports";
```

(merge the `ForwardedPort` import into the existing `../shared/types` import, and add `type PortConfig` to the existing `./containers` import).

Types — change and add:

```ts
export type ContainersPort = Pick<
  Containers,
  "up" | "inspect" | "listManaged" | "stop" | "readConfiguration"
>;
export type ForwarderPort = Pick<PortForwarder, "open" | "close" | "closeAll">;
```

and add `forwarder: ForwarderPort;` to `OrchestratorDeps` (after `runtime`).

`rebuild` becomes:

```ts
  rebuild(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      this.stopMonitor(p.id);
      await this.closePorts(p.id);
      await this.bringUp(p, true);
    });
  }
```

In `stop`, directly after `this.stopMonitor(p.id);` add `await this.closePorts(p.id);`.

In `adopt`, directly after `store.updateRuntime(id, { containerId: info.id, containerIp: info.ip, containerState: "running" });` add:

```ts
if (info.ip) await this.forwardPorts(store.project(id)!, info.ip);
```

In `refreshContainers`, directly after `this.stopMonitor(p.id);` add `await this.closePorts(p.id);`.

`shutdown` becomes:

```ts
  async shutdown(): Promise<void> {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
    await this.deps.forwarder.closeAll();
  }
```

In `bringUp`, directly after the `store.updateRuntime(project.id, { containerId: up.containerId, containerIp: info.ip, … opencode: "starting" });` call and before `await this.launchOpencode(…)`, add:

```ts
await this.forwardPorts(project, info.ip);
```

Add these private methods (e.g. after `workspaceFolder`):

```ts
  private async forwardPorts(project: Project, ip: string): Promise<void> {
    const { store, containers, forwarder } = this.deps;
    let config: PortConfig;
    try {
      config = await containers.readConfiguration(project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(project.id, `ports: could not read devcontainer configuration: ${message}`);
      store.updateRuntime(project.id, { ports: [] });
      return;
    }
    const { ports, skipped } = parseForwardPorts(config.forwardPorts, config.portsAttributes);
    for (const s of skipped) this.log(project.id, `ports: skipped ${s.entry} (${s.reason})`);
    const opened = await forwarder.open(project.id, ip, ports, (line) => this.log(project.id, line));
    for (const f of opened) {
      if (f.status === "forwarded") this.log(project.id, `ports: ${f.containerPort} → localhost:${f.hostPort}`);
      else if (f.status === "failed") this.log(project.id, `ports: ${f.containerPort} not forwarded (${f.reason})`);
    }
    const skippedPorts: ForwardedPort[] = skipped.map((s) => ({ status: "skipped", entry: s.entry, reason: s.reason }));
    store.updateRuntime(project.id, { ports: [...opened, ...skippedPorts] });
  }

  private async closePorts(id: ProjectId): Promise<void> {
    await this.deps.forwarder.close(id);
    this.deps.store.updateRuntime(id, { ports: undefined });
  }
```

- [ ] **Step 4: Wire the CLI and the e2e constructor**

In `src/server/cli.ts`:

- add `import { PortForwarder } from "./port-forwarder";`
- pass `forwarder: new PortForwarder(),` in the `new Orchestrator({ … })` call;
- in `shutdown`, replace `orchestrator.shutdown();` with `await orchestrator.shutdown();`.

In `test/e2e/opendevhub.e2e.ts`:

- add `import { PortForwarder } from "../../src/server/port-forwarder";`
- pass `forwarder: new PortForwarder(),` to `new Orchestrator({ … })`;
- replace the final `orch.shutdown();` with `await orch.shutdown();`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx tsc --noEmit && npx vitest run` Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator.ts src/server/cli.ts test/server/orchestrator.test.ts test/e2e/opendevhub.e2e.ts
git commit -m "feat: forward devcontainer ports for the lifetime of a running project"
```

---

### Task 5: Dashboard ports row

**Files:**

- Create: `src/web/components/PortsRow.tsx`
- Modify: `src/web/components/ProjectCard.tsx`, `src/web/styles.css`

**Interfaces:**

- Consumes: `ForwardedPort` (Task 1), `runtime.ports` in the snapshot (Task 4).
- Produces: `PortsRow({ ports }: { ports: ForwardedPort[] })`.

- [ ] **Step 1: Create the component**

`src/web/components/PortsRow.tsx`:

```tsx
import type { ForwardedPort } from "../../shared/types";

export function PortsRow({ ports }: { ports: ForwardedPort[] }) {
  return (
    <ul className="ports" aria-label="Forwarded ports">
      {ports.map((p) => {
        if (p.status === "forwarded") {
          const moved = p.hostPort !== p.containerPort;
          return (
            <li key={`f-${p.containerPort}`}>
              <a
                href={`http://localhost:${p.hostPort}/`}
                target="_blank"
                rel="noreferrer"
              >
                {p.label ?? "port"} · {p.containerPort} → localhost:
                {moved ? <strong>{p.hostPort}</strong> : p.hostPort} ↗
              </a>
            </li>
          );
        }
        if (p.status === "failed") {
          return (
            <li key={`x-${p.containerPort}`} className="muted" title={p.reason}>
              {p.label ? `${p.label} · ` : ""}
              {p.containerPort} not forwarded
            </li>
          );
        }
        return (
          <li key={`s-${p.entry}`} className="muted" title={p.reason}>
            {p.entry} skipped
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 2: Render it in the project card**

In `src/web/components/ProjectCard.tsx`:

- add `import { PortsRow } from "./PortsRow";`
- directly after the closing `</div>` of `<div className="actions">`, add:

```tsx
{
  runtime.ports && runtime.ports.length > 0 && (
    <PortsRow ports={runtime.ports} />
  );
}
```

- [ ] **Step 3: Add styles**

Append to `src/web/styles.css`:

```css
.ports {
  list-style: none;
  margin: 0.6rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 1rem;
  font-size: 13px;
}
.ports a {
  color: var(--accent);
  text-decoration: none;
}
.ports a:hover {
  text-decoration: underline;
}
.ports li.muted {
  cursor: help;
}
```

- [ ] **Step 4: Typecheck, test, build**

Run: `npx tsc --noEmit && npx vitest run && npm run build` Expected: all green; `dist/web` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/PortsRow.tsx src/web/components/ProjectCard.tsx src/web/styles.css
git commit -m "feat: show forwarded ports on the project card"
```

---

### Task 6: End-to-end coverage and README

**Files:**

- Modify: `test/e2e/fixture/.devcontainer/devcontainer.json`, `test/e2e/opendevhub.e2e.ts`, `README.md`

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Extend the fixture**

`test/e2e/fixture/.devcontainer/devcontainer.json`:

```json
{
  "name": "opendevhub-e2e",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:22",
  "postCreateCommand": "npm i -g @opencode/cli@2",
  "postStartCommand": "nohup node -e \"require('http').createServer((q, r) => r.end('e2e-web-ok')).listen(8080)\" > /tmp/odh-e2e-web.log 2>&1 &",
  "forwardPorts": [8080],
  "portsAttributes": { "8080": { "label": "e2e web" } }
}
```

- [ ] **Step 2: Assert forwarding in the e2e test**

In `test/e2e/opendevhub.e2e.ts`, directly after the existing `expect(rt).toMatchObject({ containerState: "running", opencode: "healthy" });` line, add:

```ts
const web = rt.ports?.find(
  (p) => p.status === "forwarded" && p.containerPort === 8080
);
expect(web).toMatchObject({
  status: "forwarded",
  containerPort: 8080,
  label: "e2e web",
});
const webPort = web?.status === "forwarded" ? web.hostPort : 0;
await vi.waitFor(
  async () =>
    expect(await (await fetch(`http://127.0.0.1:${webPort}/`)).text()).toBe(
      "e2e-web-ok"
    ),
  { timeout: 15_000, interval: 500 }
);
```

and directly after `await orch.stop(project.id);` add:

```ts
expect(store.runtime(project.id).ports).toBeUndefined();
await expect(fetch(`http://127.0.0.1:${webPort}/`)).rejects.toThrow();
```

- [ ] **Step 3: Run the e2e test**

Run: `npm run test:e2e` Expected: PASS. If the `postStartCommand` server does not survive (the fetch never answers and `docker exec <container> cat /tmp/odh-e2e-web.log` is empty), remove `postStartCommand` from the fixture and instead start the server in the test right after the `rt` assertions, via `await containers.exec(project, ["sh", "-c", "nohup node -e \"require('http').createServer((q, r) => r.end('e2e-web-ok')).listen(8080)\" > /tmp/odh-e2e-web.log 2>&1 &"]);` then re-run. Afterwards confirm no container is left running: `docker ps --filter label=opendevhub.project` (stop any with `docker stop <id>`).

- [ ] **Step 4: README**

In `README.md`, add to the feature bullet list at the top:

```markdown
- Forwards the ports listed in each project's `forwardPorts` to `localhost` on your machine while the project runs, using the next free port if one is taken. The dashboard shows each mapping as a link.
```

and add to "Known limitations":

```markdown
- `forwardPorts` entries that name another compose service (for example `"db:5432"`) are not forwarded yet.
- Forwarded ports are only open while opendevhub is running.
```

- [ ] **Step 5: Final verification and commit**

Run: `npx tsc --noEmit && npx vitest run && npm run build` Expected: all green.

```bash
git add test/e2e/fixture/.devcontainer/devcontainer.json test/e2e/opendevhub.e2e.ts README.md
git commit -m "test: e2e covers forwarded ports; docs: port forwarding in README"
```
