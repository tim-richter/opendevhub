# Remote Nodes, Plan 1: Hosts, Nodes and the ssh Route

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure ssh machines as nodes, keep a supervised ssh connection to each, show their health and capacity in the dashboard, and have a `Route` that reaches a container on a node. Nothing is placed on nodes yet; that is Plan 2.

**Architecture:** A `Host` interface (`run`, `dial`, `readFile`, `writeFile`) describes a machine. `localHost` is this one. `SshHost` runs each command as `ssh -S <ctl> <dest> '<cmd>'` and dials with `ssh -S <ctl> -W ip:port <dest>`, both through a ControlMaster that a `NodeConnection` keeps alive as a child process, with preflight and backoff. A `Nodes` registry owns the connections, persists them in `config.json`, samples their stats and publishes `NodeView`s in the dashboard snapshot. `sshRoute` builds a `Route` from a host's `dial`, reusing the gateway route's loopback tunnels.

**Tech Stack:** TypeScript (Node ≥ 22.13, ESM), Hono, vitest, React and Tailwind with shadcn/ui in `src/web`, and OpenSSH's `ssh` client. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-remote-nodes-design.md` (sections "Nodes", "`Host`", "NodeConnection", and "Runtime → Route"). Plan 2 covers placement, git actions, adopt per host, offline handling for environments, and cleanup.

All paths below are relative to `apps/opendevhub/` unless they start with `docs/`. Run commands from `apps/opendevhub/`. Work happens directly on `main`.

## Global Constraints

- The machine opendevhub runs on is the implicit node `local`. It is never stored in `config.json`.
- Node ids follow the `hosts.ts` label rule: `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`. They are unique and never `local`.
- ssh is always non-interactive: every ssh call passes `-o BatchMode=yes`.
- The ControlMaster socket is `<configDir>/ssh/<id>.sock`, and its folder is mode `0700`.
- The master is `ssh -M -N -S <ctl> -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <dest>`, kept as a child process (never `-f`).
- Dialing is always `ssh -S <ctl> -o BatchMode=yes -W <ip>:<port> <dest>`. The `ssh2` library is not used.
- Reconnect backoff starts at 1 s, doubles, and is capped at 60 s. After a preflight failure the next attempt is in 60 s.
- Node preflight requires: `docker` reaching a daemon, `devcontainer`, `git` ≥ 2.48, a writable `~/.opendevhub/`, and TCP forwarding.
- The preflight failure for host key or auth problems reads "add the host key and an ssh key for <dest> first (run `ssh <dest>` once)".
- The preflight failure for forwarding reads "sshd on <dest> does not allow TCP forwarding (AllowTcpForwarding)".
- UI is Tailwind with components from shadcn/ui (`@/components/ui/*`).

## Review Focus

1. **An ssh destination that starts with `-`** (e.g. `-oProxyCommand=touch /tmp/x`) must be rejected everywhere: config, API and CLI. Otherwise ssh parses it as an option, which means command execution on the hub. Owned by Task 4.
2. **Remote command arguments with spaces, quotes, `$` or empty strings** must reach the remote program unchanged. The remote side runs them through a shell, so wrong quoting is both a bug and an injection. Owned by Task 3 (a round trip through a real `sh -c`).
3. **Tools installed through nvm or a login profile** aren't on the PATH of a non-interactive ssh shell. Preflight must say so instead of "not installed". Owned by Task 5.
4. **The master dies while a node is online** (network drop, reboot). The node must go `unreachable`, reconnect by itself, and come back `online`. Owned by Task 6.
5. **Removing or closing a node while it is connecting or backing off** must leave no timer, no master process and no further state updates behind. Owned by Task 6 (`close`) and Task 7 (`remove`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/server/exec.ts` (modify) | `RunOptions.input`: write to stdin. |
| `src/shared/types.ts` (modify) | `NodeId`, `NodeState`, `NodeStats`, `NodeView`; `DashboardSnapshot.nodes`. |
| `src/server/host.ts` (new) | `Host` interface, `LOCAL_NODE`, `localHost`, `connectTcp`. |
| `src/server/ssh.ts` (new) | Quoting, ssh argument builders, `parseSshPort`, `describeSshFailure`, `SshHost`. |
| `src/server/config.ts` (modify) | `NodeConfig`, validation, `nodeIdFor`, `addNode`, `removeNode`, `InvalidNodeError`. |
| `src/server/node-preflight.ts` (new) | `nodePreflight`, `probeForwarding`, `parseNodeStats`, `nodeStats`. |
| `src/server/node-connection.ts` (new) | `NodeConnection`: master lifecycle, readiness, preflight, state, backoff. |
| `src/server/nodes.ts` (new) | `Nodes` registry: config, connections, stats sampling, publishing. |
| `src/server/state.ts` (modify) | `setNodes`, `nodes` in the snapshot. |
| `src/server/dashboard-api.ts` (modify) | `POST /api/nodes`, `DELETE /api/nodes/:id`. |
| `src/server/cli.ts` (modify) | `opendevhub nodes add\|list\|remove`; wire `Nodes` into `main`. |
| `src/server/network.ts` (modify) | `Dial` returns a `Duplex`; `tunnelRoute`, `sshRoute`; `Route.kind` gains `ssh`. |
| `src/server/port-forwarder.ts` (modify) | Upstreams typed as `Duplex`. |
| `src/web/api.ts` (modify) | `addNode`, `removeNode`. |
| `src/web/nodes.ts` (new) | Pure view helpers for nodes. |
| `src/web/pages/NodesPage.tsx` (new) | Nodes page: list, add, remove. |
| `src/web/App.tsx`, `src/web/layout/Shell.tsx` (modify) | Route and nav item. |
| `test/server/ssh-localhost.test.ts` (new) | Opt-in integration test against `ssh localhost`. |
| `../../README.md` (modify) | "Remote nodes (preview)" section. |

---

### Task 1: Runner stdin input

**Files:**

- Modify: `src/server/exec.ts`
- Test: `test/server/exec.test.ts`

**Interfaces:**

- Produces: `RunOptions.input?: string`. It is written to the child's stdin, which is then closed. Without it, stdin stays `"ignore"` as today.

- [ ] **Step 1: Write the failing test**

Add inside `describe("spawnRunner", …)` in `test/server/exec.test.ts`:

```ts
it("writes input to stdin and closes it", async () => {
  const r = await spawnRunner(
    node,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { input: "hello\nworld" }
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("hello\nworld");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/exec.test.ts` Expected: FAIL. `stdout` is `""` (stdin is ignored), or a TypeScript error because `input` doesn't exist.

- [ ] **Step 3: Implement**

In `src/server/exec.ts`, add to `RunOptions`:

```ts
  /** Written to the command's stdin, which is then closed. Without it stdin is ignored. */
  input?: string;
```

Change the `spawn` call's options and feed stdin right after it:

```ts
const child = spawn(cmd, args, {
  env: { ...process.env, ...opts.env },
  stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  detached: opts.detached === true,
});
if (opts.input !== undefined) {
  // A child that exits without reading would otherwise raise EPIPE here.
  child.stdin?.on("error", () => {});
  child.stdin?.end(opts.input);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/server/exec.test.ts` Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/server/exec.ts test/server/exec.test.ts
git commit -m "feat(server): runner can write stdin"
```

---

### Task 2: `Host` interface, `localHost`, node types

**Files:**

- Create: `src/server/host.ts`
- Modify: `src/shared/types.ts`
- Test: `test/server/host.test.ts`

**Interfaces:**

- Consumes: `Runner`, `spawnRunner` from `src/server/exec.ts`.
- Produces:

```ts
// src/shared/types.ts
export type NodeId = string;
export type NodeState = "online" | "connecting" | "unreachable" | "error";
export interface NodeStats { cpus: number; memTotal: number; memAvailable: number; containers: number }
export interface NodeView { id: NodeId; label: string; ssh?: string; state: NodeState; reason?: string; stats?: NodeStats }
// DashboardSnapshot gains: nodes?: NodeView[];

// src/server/host.ts
export const LOCAL_NODE: NodeId; // "local"
export interface Host {
  id: NodeId;
  run: Runner;
  dial(ip: string, port: number): Promise<Duplex>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, content: string): Promise<void>;
}
export function connectTcp(ip: string, port: number): Promise<net.Socket>;
export function localHost(run?: Runner): Host;
```

- [ ] **Step 1: Add the shared types**

In `src/shared/types.ts`, after the `ResourceStats` interface, add:

```ts
/** A machine that runs environments: `local` (this one), or an ssh destination from config.json. */
export type NodeId = string;

export type NodeState = "online" | "connecting" | "unreachable" | "error";

/** A node's capacity: memory in bytes, `containers` counts opendevhub's running containers. */
export interface NodeStats {
  cpus: number;
  memTotal: number;
  memAvailable: number;
  containers: number;
}

export interface NodeView {
  id: NodeId;
  label: string;
  /** The ssh destination; absent for `local`. */
  ssh?: string;
  state: NodeState;
  /** Why the node is unreachable or needs setup. */
  reason?: string;
  stats?: NodeStats;
}
```

In `DashboardSnapshot`, after `resources?`, add:

```ts
  /** `local` first, then configured nodes in config order. */
  nodes?: NodeView[];
```

- [ ] **Step 2: Write the failing test**

Create `test/server/host.test.ts`:

```ts
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_NODE, localHost } from "../../src/server/host";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r)))
  );
});

async function echoServer(): Promise<number> {
  const server = net.createServer((s) =>
    s.on("data", (d) => s.write(`echo:${d.toString()}`))
  );
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
    const reply = new Promise<string>((resolve) =>
      stream.once("data", (d: Buffer) => resolve(d.toString()))
    );
    stream.write("hi");
    expect(await reply).toBe("echo:hi");
    stream.destroy();
  });

  it("rejects a dial to a closed port", async () => {
    const port = await echoServer();
    await new Promise((r) => servers.pop()!.close(r));
    await expect(localHost().dial("127.0.0.1", port)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/server/host.test.ts` Expected: FAIL with "Cannot find module '../../src/server/host'" or an equivalent resolve error.

- [ ] **Step 4: Implement**

Create `src/server/host.ts`:

```ts
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";

import type { NodeId } from "../shared/types";
import { type Runner, spawnRunner } from "./exec";

export const LOCAL_NODE: NodeId = "local";

/** A machine opendevhub runs commands on and connects into: this one, or a node over ssh. */
export interface Host {
  id: NodeId;
  run: Runner;
  /** A TCP connection to `ip:port` as that machine sees it. */
  dial(ip: string, port: number): Promise<Duplex>;
  readFile(file: string): Promise<string>;
  /** Creates missing parent folders. */
  writeFile(file: string, content: string): Promise<void>;
}

export function connectTcp(ip: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port, allowHalfOpen: true });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

export function localHost(run: Runner = spawnRunner): Host {
  return {
    id: LOCAL_NODE,
    run,
    dial: connectTcp,
    readFile: (file) => fs.readFile(file, "utf8"),
    async writeFile(file, content) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    },
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run test/server/host.test.ts && pnpm typecheck` Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/host.ts src/shared/types.ts test/server/host.test.ts
git commit -m "feat(server): Host interface and the local host"
```

---

### Task 3: `SshHost` and ssh helpers

**Files:**

- Create: `src/server/ssh.ts`
- Test: `test/server/ssh.test.ts`

**Interfaces:**

- Consumes: `Host` and `NodeId` (Task 2); `RunOptions.input` (Task 1).
- Produces:

```ts
export function shellQuote(value: string): string;
export function remoteCommand(cmd: string, args: string[], env?: Record<string, string>): string;
export interface SshTarget { dest: string; control: string }
export function clientArgs(t: SshTarget): string[];   // ["-S", control, "-o", "BatchMode=yes"]
export function masterArgs(t: SshTarget): string[];
export function parseSshPort(sshG: string): number;   // from `ssh -G <dest>`; 22 when absent
export function describeSshFailure(dest: string, stderr: string): string;
export type Spawn = (cmd: string, args: string[]) => ChildProcess;
export const defaultSpawn: Spawn;
export class SshHost implements Host {
  constructor(id: NodeId, target: SshTarget, local?: Runner, spawn?: Spawn);
}
```

- [ ] **Step 1: Write the failing tests**

Create `test/server/ssh.test.ts`:

```ts
import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { spawnRunner } from "../../src/server/exec";
import {
  SshHost,
  type Spawn,
  clientArgs,
  describeSshFailure,
  masterArgs,
  parseSshPort,
  remoteCommand,
  shellQuote,
} from "../../src/server/ssh";
import { fakeRunner } from "../helpers/fake-runner";

const target = { dest: "tim@box", control: "/tmp/odh/box.sock" };

describe("shellQuote", () => {
  it.each([
    ["plain", "plain"],
    ["/a/b-c_d.json", "/a/b-c_d.json"],
    ["label=opendevhub.env", "label=opendevhub.env"],
    ["a b", "'a b'"],
    ["it's", `'it'\\''s'`],
    ["$HOME", "'$HOME'"],
    ["", "''"],
  ])("%j → %s", (input, quoted) => {
    expect(shellQuote(input)).toBe(quoted);
  });

  it("survives a real shell unchanged", async () => {
    const args = [
      "a b",
      "it's",
      "$HOME",
      "",
      "back\\slash",
      "semi;colon",
      "{{json .}}",
    ];
    const r = await spawnRunner("sh", [
      "-c",
      remoteCommand("printf", ["%s|", ...args]),
    ]);
    expect(r.stdout).toBe(args.map((a) => `${a}|`).join(""));
  });
});

describe("remoteCommand", () => {
  it("prefixes env assignments with env", () => {
    expect(remoteCommand("docker", ["ps"], { A: "1", B: "x y" })).toBe(
      "env A=1 'B=x y' docker ps"
    );
  });
});

describe("ssh arguments", () => {
  it("never prompts and reuses the master", () => {
    expect(clientArgs(target)).toEqual([
      "-S",
      "/tmp/odh/box.sock",
      "-o",
      "BatchMode=yes",
    ]);
  });

  it("runs the master in the foreground with keepalives", () => {
    expect(masterArgs(target)).toEqual([
      "-M",
      "-N",
      "-S",
      "/tmp/odh/box.sock",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "tim@box",
    ]);
    expect(masterArgs(target)).not.toContain("-f");
  });

  it("reads the port from ssh -G", () => {
    expect(parseSshPort("user tim\nhostname box.lan\nport 2222\n")).toBe(2222);
    expect(parseSshPort("user tim\n")).toBe(22);
  });
});

describe("describeSshFailure", () => {
  it("asks for a host key and ssh key on auth problems", () => {
    expect(
      describeSshFailure("tim@box", "Host key verification failed.\n")
    ).toBe(
      "add the host key and an ssh key for tim@box first (run `ssh tim@box` once)"
    );
    expect(
      describeSshFailure("tim@box", "tim@box: Permission denied (publickey).\n")
    ).toContain("add the host key");
  });

  it("quotes ssh's last line otherwise", () => {
    expect(
      describeSshFailure(
        "tim@box",
        "debug\nssh: connect to host box port 22: No route to host\n"
      )
    ).toBe(
      "ssh to tim@box failed: ssh: connect to host box port 22: No route to host"
    );
    expect(describeSshFailure("tim@box", "")).toBe("ssh to tim@box exited");
  });
});

describe("SshHost.run", () => {
  it("runs the quoted command over the master, keeping local options", async () => {
    const fake = fakeRunner();
    const host = new SshHost("box", target, fake.run);
    const onLine = () => {};
    await host.run("docker", ["ps", "--filter", "label=a b"], {
      env: { X: "1" },
      timeoutMs: 5,
      onLine,
    });
    expect(fake.calls).toEqual([
      {
        cmd: "ssh",
        args: [
          "-S",
          "/tmp/odh/box.sock",
          "-o",
          "BatchMode=yes",
          "tim@box",
          "env X=1 docker ps --filter 'label=a b'",
        ],
        opts: { timeoutMs: 5, onLine },
      },
    ]);
  });
});

describe("SshHost files", () => {
  it("reads with cat and reports failures with ssh's stderr", async () => {
    const ok = fakeRunner(() => ({ stdout: "{}\n" }));
    expect(
      await new SshHost("box", target, ok.run).readFile("/x/a b.json")
    ).toBe("{}\n");
    expect(ok.calls[0].args.at(-1)).toBe("cat '/x/a b.json'");

    const missing = fakeRunner(() => ({
      exitCode: 1,
      stderr: "cat: /x: No such file or directory\n",
    }));
    await expect(
      new SshHost("box", target, missing.run).readFile("/x")
    ).rejects.toThrow(/reading \/x on box failed: .*No such file/);
  });

  it("writes through stdin, creating the folder", async () => {
    const fake = fakeRunner();
    await new SshHost("box", target, fake.run).writeFile(
      "/x/y.json",
      "content"
    );
    expect(fake.calls[0].args.at(-1)).toBe(
      `sh -c 'mkdir -p "$(dirname "$1")" && cat > "$1"' sh /x/y.json`
    );
    expect(fake.calls[0].opts?.input).toBe("content");
  });
});

describe("SshHost.dial", () => {
  /** Stands in for `ssh -W`: runs a node script with the same stdio, recording the arguments. */
  function scripted(script: string) {
    const calls: string[][] = [];
    const fake: Spawn = (cmd, args) => {
      calls.push([cmd, ...args]);
      return spawn(process.execPath, ["-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    };
    return { fake, calls };
  }

  it("opens a channel with -W through the master", async () => {
    const { fake, calls } = scripted("process.stdin.pipe(process.stdout)");
    const stream = await new SshHost(
      "box",
      target,
      fakeRunner().run,
      fake
    ).dial("172.17.0.5", 4096);
    expect(calls[0]).toEqual([
      "ssh",
      "-S",
      "/tmp/odh/box.sock",
      "-o",
      "BatchMode=yes",
      "-W",
      "172.17.0.5:4096",
      "tim@box",
    ]);
    stream.write("ping");
    const [data] = (await once(stream, "data")) as [Buffer];
    expect(data.toString()).toBe("ping");
    stream.destroy();
  });

  it("fails the stream with ssh's message when the channel can't open", async () => {
    const { fake } = scripted(
      "process.stderr.write('channel 0: open failed: connect failed: Connection refused\\nstdio forwarding failed\\n'); process.exit(255)"
    );
    const stream = await new SshHost(
      "box",
      target,
      fakeRunner().run,
      fake
    ).dial("172.17.0.5", 9);
    const [err] = (await once(stream, "error")) as [Error];
    expect(err.message).toContain("Connection refused");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/ssh.test.ts` Expected: FAIL, because `src/server/ssh` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/server/ssh.ts`:

```ts
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { Duplex } from "node:stream";

import type { NodeId } from "../shared/types";
import { type Runner, spawnRunner } from "./exec";
import type { Host } from "./host";

/** Quotes a word for a POSIX shell; safe words stay readable. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The single string ssh hands to the remote shell for `cmd args`, with `env` set for it. */
export function remoteCommand(
  cmd: string,
  args: string[],
  env: Record<string, string> = {}
): string {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return [...(vars.length > 0 ? ["env", ...vars] : []), cmd, ...args]
    .map(shellQuote)
    .join(" ");
}

export interface SshTarget {
  /** As the user's ssh config knows it: `host`, `user@host` or an alias. */
  dest: string;
  /** The ControlMaster socket. */
  control: string;
}

/** Every client call: go through the master, never prompt. */
export function clientArgs(t: SshTarget): string[] {
  return ["-S", t.control, "-o", "BatchMode=yes"];
}

/** The master, in the foreground: a daemonized ssh (-f) keeps captured stdio open, and its exit is our signal. */
export function masterArgs(t: SshTarget): string[] {
  return [
    "-M",
    "-N",
    "-S",
    t.control,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    t.dest,
  ];
}

/** The port `ssh -G <dest>` resolved; 22 when it printed none. */
export function parseSshPort(sshG: string): number {
  const m = /^port (\d+)$/m.exec(sshG);
  return m ? Number(m[1]) : 22;
}

const AUTH_FAILURE =
  /Host key verification failed|Permission denied|REMOTE HOST IDENTIFICATION HAS CHANGED|No ED25519 host key is known|host key for .* has changed/i;

/** One line for the dashboard from what ssh printed before it gave up. */
export function describeSshFailure(dest: string, stderr: string): string {
  if (AUTH_FAILURE.test(stderr))
    return `add the host key and an ssh key for ${dest} first (run \`ssh ${dest}\` once)`;
  const last = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last ? `ssh to ${dest} failed: ${last}` : `ssh to ${dest} exited`;
}

export type Spawn = (cmd: string, args: string[]) => ChildProcess;

export const defaultSpawn: Spawn = (cmd, args) =>
  nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

/** A node reached over ssh. Every call goes through the ControlMaster that a NodeConnection keeps open. */
export class SshHost implements Host {
  constructor(
    readonly id: NodeId,
    private readonly target: SshTarget,
    private readonly local: Runner = spawnRunner,
    private readonly spawn: Spawn = defaultSpawn
  ) {}

  readonly run: Runner = (cmd, args, opts = {}) => {
    const { env, ...rest } = opts;
    return this.local(
      "ssh",
      [
        ...clientArgs(this.target),
        this.target.dest,
        remoteCommand(cmd, args, env),
      ],
      rest
    );
  };

  async readFile(file: string): Promise<string> {
    const r = await this.run("cat", [file], { timeoutMs: 30_000 });
    if (r.exitCode !== 0)
      throw new Error(
        `reading ${file} on ${this.id} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`
      );
    return r.stdout;
  }

  async writeFile(file: string, content: string): Promise<void> {
    const r = await this.run(
      "sh",
      ["-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", file],
      {
        input: content,
        timeoutMs: 30_000,
      }
    );
    if (r.exitCode !== 0)
      throw new Error(
        `writing ${file} on ${this.id} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`
      );
  }

  /** A channel to `ip:port` from the node (`ssh -W`), as a stream over the ssh process's stdio. */
  dial(ip: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const child = this.spawn("ssh", [
        ...clientArgs(this.target),
        "-W",
        `${ip}:${port}`,
        this.target.dest,
      ]);
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString("utf8")).slice(-2000);
      });
      const stream = Duplex.from({
        readable: child.stdout!,
        writable: child.stdin!,
      });
      stream.on("close", () => {
        if (child.exitCode === null) child.kill();
      });
      child.once("error", reject);
      child.once("spawn", () => resolve(stream));
      // "close" comes after stderr is drained, so the message is complete.
      child.once("close", (code) => {
        if (code !== 0 && !stream.destroyed) {
          stream.destroy(
            new Error(
              stderr.trim() || `ssh -W ${ip}:${port} exited with ${code}`
            )
          );
        }
      });
    });
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/ssh.test.ts && pnpm typecheck` Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/ssh.ts test/server/ssh.test.ts
git commit -m "feat(server): SshHost runs commands and dials through an ssh master"
```

---

### Task 4: Nodes in `config.json`

**Files:**

- Modify: `src/server/config.ts`
- Test: `test/server/config.test.ts`

**Interfaces:**

- Consumes: `LOCAL_NODE` (Task 2), `NodeId` (Task 2).
- Produces:

```ts
export interface NodeConfig {
  id: NodeId;
  ssh: string;
  label?: string;
}
// Config gains: nodes?: NodeConfig[];
export class InvalidNodeError extends Error {}
export function validateSshDestination(dest: string): string; // trimmed; throws InvalidNodeError
export function nodeIdFor(name: string, taken: string[]): NodeId;
export function addNode(
  cfg: Config,
  input: { ssh: string; label?: string }
): { config: Config; node: NodeConfig };
export function removeNode(cfg: Config, id: NodeId): Config;
```

- [ ] **Step 1: Write the failing tests**

Append to `test/server/config.test.ts` (merge the new names into the existing import from `../../src/server/config`, and import `fs`, `os` and `path` if the file doesn't already):

```ts
describe("nodes in config", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "odh-nodes-"));

  it("loads valid nodes and drops invalid ones", () => {
    const dir = tmp();
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          roots: [],
          port: 7777,
          nodes: [
            { id: "box", ssh: "tim@box", label: "Workstation" },
            { id: "local", ssh: "tim@other" },
            { id: "Bad_ID", ssh: "tim@x" },
            { id: "evil", ssh: "-oProxyCommand=touch /tmp/pwned" },
            { id: "box", ssh: "tim@dupe" },
            "junk",
          ],
        })
      );
      expect(loadConfig(dir).nodes).toEqual([
        { id: "box", ssh: "tim@box", label: "Workstation" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips nodes through saveConfig", () => {
    const dir = tmp();
    try {
      saveConfig(dir, {
        roots: ["/a"],
        port: 7777,
        nodes: [{ id: "box", ssh: "box" }],
      });
      expect(loadConfig(dir).nodes).toEqual([{ id: "box", ssh: "box" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["-oProxyCommand=touch /tmp/x"],
    ["-p"],
    ["tim@box extra"],
    ["tim@box\n-oFoo=bar"],
    [""],
    ["   "],
  ])("rejects the ssh destination %j", (dest) => {
    expect(() => validateSshDestination(dest)).toThrow(InvalidNodeError);
  });

  it("accepts and trims usual destinations", () => {
    expect(validateSshDestination(" tim@box.lan ")).toBe("tim@box.lan");
    expect(validateSshDestination("build-1")).toBe("build-1");
    expect(validateSshDestination("tim@[fe80::1]")).toBe("tim@[fe80::1]");
  });

  it.each([
    ["tim@box.lan", [], "box-lan"],
    ["My Box", [], "my-box"],
    ["box", ["box"], "box-2"],
    ["box", ["box", "box-2"], "box-3"],
    ["local", [], "local-2"],
    ["@@@", [], "node"],
    ["tim@host:2222", [], "host"],
  ])("nodeIdFor(%j, %j) = %s", (name, taken, id) => {
    expect(nodeIdFor(name, taken)).toBe(id);
  });

  it("adds a node with an id from its label, and refuses the same destination twice", () => {
    const base = { roots: [], port: 7777 };
    const { config, node } = addNode(base, {
      ssh: "tim@box",
      label: " Workstation ",
    });
    expect(node).toEqual({
      id: "workstation",
      ssh: "tim@box",
      label: "Workstation",
    });
    expect(config.nodes).toEqual([node]);
    expect(() => addNode(config, { ssh: "tim@box" })).toThrow(/already a node/);
    expect(addNode(config, { ssh: "tim@other" }).node).toEqual({
      id: "other",
      ssh: "tim@other",
    });
  });

  it("removes a node by id", () => {
    const cfg = {
      roots: [],
      port: 7777,
      nodes: [
        { id: "a", ssh: "a" },
        { id: "b", ssh: "b" },
      ],
    };
    expect(removeNode(cfg, "a").nodes).toEqual([{ id: "b", ssh: "b" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/config.test.ts` Expected: FAIL, because `addNode`, `nodeIdFor`, `validateSshDestination` and `InvalidNodeError` aren't exported.

- [ ] **Step 3: Implement**

In `src/server/config.ts`, extend the type import to include `NodeId`, and add `import { LOCAL_NODE } from "./host";`. Add `nodes?: NodeConfig[];` to `Config`, with the doc comment `/** Machines tasks can run on, besides this one. */`. Then add:

```ts
/** A machine reached over ssh. */
export interface NodeConfig {
  id: NodeId;
  /** As the user's ssh config knows it: `host`, `user@host` or an alias. */
  ssh: string;
  label?: string;
}

export class InvalidNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNodeError";
  }
}

const NODE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** No whitespace, and no leading `-`: ssh would read that as an option (`-oProxyCommand=…`). */
const SSH_DEST = /^[^-\s]\S*$/;

export function validateSshDestination(dest: string): string {
  const d = dest.trim();
  if (!SSH_DEST.test(d))
    throw new InvalidNodeError(
      `invalid ssh destination: ${JSON.stringify(dest)}`
    );
  return d;
}

/** A node id from a label or destination: `tim@box.lan` → `box-lan`; taken ids and `local` get a suffix. */
export function nodeIdFor(name: string, taken: string[]): NodeId {
  const host = name.replace(/^.*@/, "").replace(/:\d+$/, "");
  const base =
    host
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "node";
  let id = base;
  for (let n = 2; id === LOCAL_NODE || taken.includes(id); n++)
    id = `${base}-${n}`;
  return id;
}

function readNodes(raw: unknown): NodeConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeConfig[] = [];
  for (const value of raw) {
    const n = value as { id?: unknown; ssh?: unknown; label?: unknown };
    if (
      !n ||
      typeof n !== "object" ||
      typeof n.id !== "string" ||
      typeof n.ssh !== "string"
    )
      continue;
    if (
      !NODE_ID.test(n.id) ||
      n.id === LOCAL_NODE ||
      out.some((o) => o.id === n.id) ||
      !SSH_DEST.test(n.ssh)
    )
      continue;
    out.push({
      id: n.id,
      ssh: n.ssh,
      ...(typeof n.label === "string" && n.label ? { label: n.label } : {}),
    });
  }
  return out;
}

export function addNode(
  cfg: Config,
  input: { ssh: string; label?: string }
): { config: Config; node: NodeConfig } {
  const ssh = validateSshDestination(input.ssh);
  const label = input.label?.trim() || undefined;
  const nodes = cfg.nodes ?? [];
  if (nodes.some((n) => n.ssh === ssh))
    throw new InvalidNodeError(`${ssh} is already a node`);
  const node: NodeConfig = {
    id: nodeIdFor(
      label ?? ssh,
      nodes.map((n) => n.id)
    ),
    ssh,
    ...(label ? { label } : {}),
  };
  return { config: { ...cfg, nodes: [...nodes, node] }, node };
}

export function removeNode(cfg: Config, id: NodeId): Config {
  return { ...cfg, nodes: (cfg.nodes ?? []).filter((n) => n.id !== id) };
}
```

In `loadConfig`, compute `const nodes = readNodes(raw.nodes);` and add `...(nodes.length > 0 ? { nodes } : {}),` to the returned object, after `forges`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/config.test.ts test/server/cli.test.ts && pnpm typecheck` Expected: PASS. `loadAndSaveStartupConfig` keeps `nodes` because it spreads the saved config.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts test/server/config.test.ts
git commit -m "feat(server): nodes in config.json, with safe ssh destinations"
```

---

### Task 5: Node preflight and stats

**Files:**

- Create: `src/server/node-preflight.ts`
- Test: `test/server/node-preflight.test.ts`

**Interfaces:**

- Consumes: `Host` (Task 2); `parseGitVersion`, `supportsRelativePaths` from `src/server/worktrees.ts`; `LABEL`, `ENV_LABEL` from `src/server/containers.ts`.
- Produces:

```ts
export function nodePreflight(
  host: Pick<Host, "run" | "dial">,
  sshPort: number,
  dest: string
): Promise<string[]>;
export function probeForwarding(
  host: Pick<Host, "dial">,
  sshPort: number,
  dest: string,
  timeoutMs?: number
): Promise<string | undefined>;
export function parseNodeStats(stdout: string): NodeStats | undefined;
export function nodeStats(run: Runner): Promise<NodeStats | undefined>;
```

- [ ] **Step 1: Write the failing tests**

Create `test/server/node-preflight.test.ts`:

```ts
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { RunResult } from "../../src/server/exec";
import {
  nodePreflight,
  nodeStats,
  parseNodeStats,
  probeForwarding,
} from "../../src/server/node-preflight";
import { type Call, fakeRunner } from "../helpers/fake-runner";

/** A dial that answers like sshd, fails with `error`, or never answers. */
function dialer(
  mode: {
    banner?: string;
    error?: string;
    reject?: string;
    silent?: boolean;
  } = { banner: "SSH-2.0-OpenSSH_9.6\r\n" }
) {
  const calls: Array<[string, number]> = [];
  const dial = async (ip: string, port: number) => {
    calls.push([ip, port]);
    if (mode.reject) throw new Error(mode.reject);
    const s = new PassThrough();
    setImmediate(() => {
      if (mode.error) s.destroy(new Error(mode.error));
      else if (mode.banner) s.write(mode.banner);
    });
    return s;
  };
  return { dial, calls };
}

function tools(overrides: Partial<Record<string, Partial<RunResult>>> = {}) {
  return fakeRunner((c: Call) => {
    const key = c.cmd === "sh" ? "home" : c.cmd;
    return (
      overrides[key] ??
      (c.cmd === "git" ? { stdout: "git version 2.49.0\n" } : {})
    );
  });
}

describe("nodePreflight", () => {
  it("passes when every tool is there and forwarding works", async () => {
    const { dial, calls } = dialer();
    expect(
      await nodePreflight({ run: tools().run, dial }, 2222, "tim@box")
    ).toEqual([]);
    expect(calls).toEqual([["127.0.0.1", 2222]]);
  });

  it("says a missing tool may just be off the non-interactive PATH", async () => {
    const errors = await nodePreflight(
      {
        run: tools({ devcontainer: { exitCode: 127 } }).run,
        dial: dialer().dial,
      },
      22,
      "tim@box"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /devcontainer CLI not found on the PATH of a non-interactive ssh shell/
    );
    expect(errors[0]).toMatch(/nvm/);
  });

  it("reports a Docker daemon it can't reach, an old git and an unwritable folder", async () => {
    const run = tools({
      docker: { exitCode: 1 },
      git: { stdout: "git version 2.43.0\n" },
      home: { exitCode: 1 },
    }).run;
    const errors = await nodePreflight(
      { run, dial: dialer().dial },
      22,
      "tim@box"
    );
    expect(errors).toEqual([
      "the Docker daemon is not reachable (is Docker running, and may the ssh user use it?)",
      "git 2.48 or newer is needed (found git version 2.43.0)",
      "~/.opendevhub can't be created or isn't writable",
    ]);
  });
});

describe("probeForwarding", () => {
  it("is fine when sshd greets through the channel", async () => {
    expect(await probeForwarding(dialer(), 22, "tim@box")).toBeUndefined();
  });

  it("is fine when the port refuses: the channel itself opened", async () => {
    expect(
      await probeForwarding(
        dialer({
          error: "channel 0: open failed: connect failed: Connection refused",
        }),
        22,
        "tim@box"
      )
    ).toBeUndefined();
  });

  it("names AllowTcpForwarding when sshd prohibits it", async () => {
    const d = dialer({
      error: "channel 0: open failed: administratively prohibited: open failed",
    });
    expect(await probeForwarding(d, 22, "tim@box")).toBe(
      "sshd on tim@box does not allow TCP forwarding (AllowTcpForwarding)"
    );
  });

  it("reports a dial that can't start and a channel that stays silent", async () => {
    expect(
      await probeForwarding(
        dialer({ reject: "spawn ssh ENOENT" }),
        22,
        "tim@box"
      )
    ).toBe("opening an ssh channel to tim@box failed: spawn ssh ENOENT");
    expect(
      await probeForwarding(
        dialer({ silent: true, banner: undefined }),
        22,
        "tim@box",
        20
      )
    ).toBe("sshd on tim@box did not answer through a forwarded channel");
  });
});

describe("node stats", () => {
  const sample =
    "8\nMemTotal:       32768000 kB\nMemAvailable:   16384000 kB\n2\n3\n";

  it("parses cpus, memory in bytes and both container counts", () => {
    expect(parseNodeStats(sample)).toEqual({
      cpus: 8,
      memTotal: 32768000 * 1024,
      memAvailable: 16384000 * 1024,
      containers: 5,
    });
  });

  it("is undefined when /proc/meminfo is missing (macOS)", () => {
    expect(parseNodeStats("10\n0\n0\n")).toBeUndefined();
  });

  it("runs one shell script and gives up quietly on failure", async () => {
    const ok = fakeRunner(() => ({ stdout: sample }));
    expect(await nodeStats(ok.run)).toMatchObject({ cpus: 8 });
    expect(ok.calls[0].cmd).toBe("sh");
    expect(ok.calls[0].args[1]).toContain("label=opendevhub.env");
    expect(
      await nodeStats(fakeRunner(() => ({ exitCode: 255 })).run)
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/node-preflight.test.ts` Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/server/node-preflight.ts`:

```ts
import type { Duplex } from "node:stream";

import type { NodeStats } from "../shared/types";
import { ENV_LABEL, LABEL } from "./containers";
import type { Runner } from "./exec";
import type { Host } from "./host";
import { parseGitVersion, supportsRelativePaths } from "./worktrees";

const TIMEOUT_MS = 15_000;
const PATH_HINT =
  "on the PATH of a non-interactive ssh shell (tools installed through nvm or a login profile aren't on it; see the README)";

/** What keeps a node from running environments; empty when it's ready. */
export async function nodePreflight(
  host: Pick<Host, "run" | "dial">,
  sshPort: number,
  dest: string
): Promise<string[]> {
  const errors: string[] = [];
  const docker = await host.run(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { timeoutMs: TIMEOUT_MS }
  );
  if (docker.exitCode === 127) errors.push(`docker not found ${PATH_HINT}`);
  else if (docker.exitCode !== 0)
    errors.push(
      "the Docker daemon is not reachable (is Docker running, and may the ssh user use it?)"
    );
  const devcontainer = await host.run("devcontainer", ["--version"], {
    timeoutMs: TIMEOUT_MS,
  });
  if (devcontainer.exitCode !== 0)
    errors.push(`devcontainer CLI not found ${PATH_HINT}`);
  const git = await host.run("git", ["--version"], { timeoutMs: TIMEOUT_MS });
  if (git.exitCode !== 0) errors.push(`git not found ${PATH_HINT}`);
  else if (!supportsRelativePaths(parseGitVersion(git.stdout)))
    errors.push(`git 2.48 or newer is needed (found ${git.stdout.trim()})`);
  const home = await host.run(
    "sh",
    ["-c", 'mkdir -p "$HOME/.opendevhub" && test -w "$HOME/.opendevhub"'],
    { timeoutMs: TIMEOUT_MS }
  );
  if (home.exitCode !== 0)
    errors.push("~/.opendevhub can't be created or isn't writable");
  const forwarding = await probeForwarding(host, sshPort, dest);
  if (forwarding) errors.push(forwarding);
  return errors;
}

/**
 * Opens a channel from the node to its own sshd. A greeting, or a refusal (the channel opened and
 * the port said no), means forwarding works; "administratively prohibited" means sshd forbids it.
 */
export async function probeForwarding(
  host: Pick<Host, "dial">,
  sshPort: number,
  dest: string,
  timeoutMs = 5000
): Promise<string | undefined> {
  let stream: Duplex;
  try {
    stream = await host.dial("127.0.0.1", sshPort);
  } catch (err) {
    return `opening an ssh channel to ${dest} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return new Promise((resolve) => {
    const done = (result: string | undefined) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.on("error", () => {});
      stream.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => done(`sshd on ${dest} did not answer through a forwarded channel`),
      timeoutMs
    );
    stream.once("data", (chunk: Buffer) =>
      done(
        chunk.toString("utf8").startsWith("SSH-")
          ? undefined
          : `unexpected answer through a forwarded channel to ${dest}`
      )
    );
    stream.once("error", (err: Error) => {
      if (/administratively prohibited/i.test(err.message))
        done(
          `sshd on ${dest} does not allow TCP forwarding (AllowTcpForwarding)`
        );
      else if (/Connection refused/i.test(err.message)) done(undefined);
      else done(`a forwarded channel to ${dest} failed: ${err.message}`);
    });
  });
}

const STATS_SCRIPT = [
  "nproc",
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
  `docker ps -q --filter label=${LABEL} | wc -l`,
  `docker ps -q --filter label=${ENV_LABEL} | wc -l`,
].join("; ");

/** `nproc`, two /proc/meminfo lines and two container counts. */
export function parseNodeStats(stdout: string): NodeStats | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB$`).exec(
      lines.find((l) => l.startsWith(`${key}:`)) ?? ""
    );
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const memTotal = kb("MemTotal");
  const memAvailable = kb("MemAvailable");
  const numbers = lines.filter((l) => /^\d+$/.test(l)).map(Number);
  if (
    numbers.length < 3 ||
    !(numbers[0] > 0) ||
    memTotal === undefined ||
    memAvailable === undefined
  )
    return undefined;
  return {
    cpus: numbers[0],
    memTotal,
    memAvailable,
    containers: numbers[1] + numbers[2],
  };
}

/** A node's capacity, or undefined when it can't be read (no /proc/meminfo, ssh down). */
export async function nodeStats(run: Runner): Promise<NodeStats | undefined> {
  const r = await run("sh", ["-c", STATS_SCRIPT], { timeoutMs: TIMEOUT_MS });
  return r.exitCode === 0 ? parseNodeStats(r.stdout) : undefined;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/node-preflight.test.ts && pnpm typecheck` Expected: PASS. If `containers.ts` → `worktrees.ts` creates an import cycle that typecheck reports, import `LABEL` and `ENV_LABEL` the same way `cleanup.ts` does.

- [ ] **Step 5: Commit**

```bash
git add src/server/node-preflight.ts test/server/node-preflight.test.ts
git commit -m "feat(server): node preflight and capacity stats"
```

---

### Task 6: `NodeConnection`

**Files:**

- Create: `src/server/node-connection.ts`
- Test: `test/server/node-connection.test.ts`

**Interfaces:**

- Consumes: `NodeConfig` (Task 4); `SshHost`, `Spawn`, `defaultSpawn`, `masterArgs`, `parseSshPort`, `describeSshFailure` (Task 3); `nodePreflight` (Task 5).
- Produces:

```ts
export interface NodeConnectionOptions {
  node: NodeConfig;
  controlDir: string;
  onChange: () => void;
  run?: Runner;
  spawn?: Spawn;
  preflight?: (
    host: SshHost,
    sshPort: number,
    dest: string
  ) => Promise<string[]>;
  readyTimeoutMs?: number; // default 20_000
  readyIntervalMs?: number; // default 250
  retryMinMs?: number; // default 1_000
  retryMaxMs?: number; // default 60_000
}
export function nextDelay(current: number, max: number): number;
export class NodeConnection {
  readonly host: SshHost;
  constructor(opts: NodeConnectionOptions);
  get online(): boolean;
  view(): NodeView; // without stats
  start(): void;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing tests**

Create `test/server/node-connection.test.ts`:

```ts
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeConnection, nextDelay } from "../../src/server/node-connection";
import { type Call, fakeRunner } from "../helpers/fake-runner";

type FakeChild = ChildProcess & {
  exitWith(code: number, stderr?: string): void;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    kill: vi.fn(() => {
      child.exitWith(143);
      return true;
    }),
    exitWith(code: number, stderr = "") {
      if (child.exitCode !== null) return;
      if (stderr) child.stderr!.write(stderr);
      (child as { exitCode: number | null }).exitCode = code;
      setImmediate(() => child.emit("exit", code, null));
    },
  });
  return child;
}

const open: NodeConnection[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

function setup(
  opts: {
    check?: (n: number) => number;
    preflight?: () => Promise<string[]>;
  } = {}
) {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-ctl-"));
  const masters: FakeChild[] = [];
  let checks = 0;
  const runner = fakeRunner((c: Call) => {
    if (c.args.includes("-O") && c.args.includes("check"))
      return { exitCode: (opts.check ?? (() => 0))(++checks) };
    if (c.args[0] === "-G") return { stdout: "user tim\nport 2222\n" };
    return {};
  });
  const preflight = vi.fn(opts.preflight ?? (async () => []));
  const onChange = vi.fn();
  const conn = new NodeConnection({
    node: { id: "box", ssh: "tim@box", label: "Box" },
    controlDir,
    onChange,
    run: runner.run,
    spawn: (cmd, args) => {
      expect(cmd).toBe("ssh");
      expect(args[0]).toBe("-M");
      const child = fakeChild();
      masters.push(child);
      return child;
    },
    preflight,
    readyIntervalMs: 1,
    readyTimeoutMs: 200,
    retryMinMs: 5,
    retryMaxMs: 20,
  });
  open.push(conn);
  return { conn, masters, runner, preflight, onChange, controlDir };
}

describe("nextDelay", () => {
  it("doubles up to the cap", () => {
    expect(nextDelay(1000, 60_000)).toBe(2000);
    expect(nextDelay(40_000, 60_000)).toBe(60_000);
  });
});

describe("NodeConnection", () => {
  it("starts the master, runs preflight with the resolved port and goes online", async () => {
    const { conn, masters, preflight, onChange, controlDir } = setup();
    expect(conn.view()).toEqual({
      id: "box",
      label: "Box",
      ssh: "tim@box",
      state: "connecting",
    });
    conn.start();
    await vi.waitFor(() => expect(conn.view().state).toBe("online"));
    expect(masters).toHaveLength(1);
    expect(preflight).toHaveBeenCalledWith(conn.host, 2222, "tim@box");
    expect(onChange).toHaveBeenCalled();
    expect((fs.statSync(controlDir).mode & 0o777).toString(8)).toBe("700");
  });

  it("reports an auth failure in words and retries", async () => {
    const { conn, masters } = setup({ check: () => 255 });
    conn.start();
    await vi.waitFor(() => expect(masters).toHaveLength(1));
    masters[0].exitWith(255, "Host key verification failed.\r\n");
    await vi.waitFor(() => expect(conn.view().state).toBe("unreachable"));
    expect(conn.view().reason).toBe(
      "add the host key and an ssh key for tim@box first (run `ssh tim@box` once)"
    );
    await vi.waitFor(() => expect(masters.length).toBeGreaterThanOrEqual(2));
  });

  it("gives up waiting for a master that never gets ready, and kills it", async () => {
    const { conn, masters } = setup({ check: () => 255 });
    conn.start();
    await vi.waitFor(() => expect(conn.view().state).toBe("unreachable"), {
      timeout: 2000,
    });
    expect(conn.view().reason).toMatch(/did not connect within/);
    expect(masters[0].kill).toHaveBeenCalled();
  });

  it("shows preflight errors as needing setup", async () => {
    const { conn } = setup({
      preflight: async () => ["docker not found", "git not found"],
    });
    conn.start();
    await vi.waitFor(() => expect(conn.view().state).toBe("error"));
    expect(conn.view().reason).toBe("docker not found; git not found");
  });

  it("goes unreachable when the master dies while online, then reconnects", async () => {
    const { conn, masters } = setup();
    conn.start();
    await vi.waitFor(() => expect(conn.online).toBe(true));
    masters[0].exitWith(255, "Timeout, server box not responding.\n");
    await vi.waitFor(() => expect(conn.view().state).toBe("unreachable"));
    expect(conn.view().reason).toBe(
      "ssh to tim@box failed: Timeout, server box not responding."
    );
    await vi.waitFor(() => expect(conn.online).toBe(true));
    expect(masters).toHaveLength(2);
  });

  it("close while backing off leaves no master, timer or update behind", async () => {
    const { conn, masters, onChange } = setup({ check: () => 255 });
    conn.start();
    await vi.waitFor(() => expect(masters).toHaveLength(1));
    masters[0].exitWith(255, "Connection refused\n");
    await vi.waitFor(() => expect(conn.view().state).toBe("unreachable"));
    await conn.close();
    const spawned = masters.length;
    const changes = onChange.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(masters).toHaveLength(spawned);
    expect(onChange.mock.calls.length).toBe(changes);
    for (const m of masters) expect(m.exitCode).not.toBeNull();
  });

  it("close while online asks the master to exit and kills it", async () => {
    const { conn, masters, runner } = setup();
    conn.start();
    await vi.waitFor(() => expect(conn.online).toBe(true));
    await conn.close();
    expect(
      runner.calls.some((c) => c.args.includes("-O") && c.args.includes("exit"))
    ).toBe(true);
    expect(masters[0].kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/node-connection.test.ts` Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/server/node-connection.ts`:

```ts
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { NodeState, NodeView } from "../shared/types";
import type { NodeConfig } from "./config";
import { type Runner, spawnRunner } from "./exec";
import { nodePreflight } from "./node-preflight";
import {
  SshHost,
  type Spawn,
  type SshTarget,
  defaultSpawn,
  describeSshFailure,
  masterArgs,
  parseSshPort,
} from "./ssh";

export interface NodeConnectionOptions {
  node: NodeConfig;
  /** The master's socket is `<controlDir>/<id>.sock`. */
  controlDir: string;
  onChange: () => void;
  run?: Runner;
  spawn?: Spawn;
  preflight?: (
    host: SshHost,
    sshPort: number,
    dest: string
  ) => Promise<string[]>;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

export function nextDelay(current: number, max: number): number {
  return Math.min(current * 2, max);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps one node reachable: an ssh ControlMaster as a child process, preflight once it's up, and
 * reconnection with backoff when it exits. Every SshHost call goes through that master.
 */
export class NodeConnection {
  readonly host: SshHost;
  private readonly target: SshTarget;
  private readonly run: Runner;
  private state: NodeState = "connecting";
  private reason?: string;
  private master?: ChildProcess;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private delay: number;
  private closed = false;

  constructor(private readonly opts: NodeConnectionOptions) {
    this.target = {
      dest: opts.node.ssh,
      control: path.join(opts.controlDir, `${opts.node.id}.sock`),
    };
    this.run = opts.run ?? spawnRunner;
    this.host = new SshHost(
      opts.node.id,
      this.target,
      this.run,
      opts.spawn ?? defaultSpawn
    );
    this.delay = opts.retryMinMs ?? 1000;
  }

  get online(): boolean {
    return this.state === "online";
  }

  view(): NodeView {
    const { node } = this.opts;
    return {
      id: node.id,
      label: node.label ?? node.ssh,
      ssh: node.ssh,
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  start(): void {
    void this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const master = this.master;
    this.master = undefined;
    if (master && master.exitCode === null) {
      await this.run(
        "ssh",
        ["-S", this.target.control, "-O", "exit", this.target.dest],
        { timeoutMs: 5000 }
      ).catch(() => undefined);
      master.kill();
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.set("connecting");
    try {
      await this.openMaster();
      const port = parseSshPort(
        (await this.run("ssh", ["-G", this.target.dest], { timeoutMs: 10_000 }))
          .stdout
      );
      const errors = await (this.opts.preflight ?? nodePreflight)(
        this.host,
        port,
        this.target.dest
      );
      if (this.closed) return;
      if (errors.length > 0) {
        this.set("error", errors.join("; "));
        this.retry(this.opts.retryMaxMs ?? 60_000);
        return;
      }
      this.delay = this.opts.retryMinMs ?? 1000;
      this.set("online");
    } catch (err) {
      if (this.closed) return;
      this.set("unreachable", err instanceof Error ? err.message : String(err));
      this.retry();
    }
  }

  /** Starts a fresh master and resolves once `ssh -O check` answers; rejects with ssh's reason when it exits first. */
  private async openMaster(): Promise<void> {
    this.stopMaster();
    fs.mkdirSync(path.dirname(this.target.control), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(path.dirname(this.target.control), 0o700);
    // A socket left by a crash makes the new ssh silently skip being a master.
    fs.rmSync(this.target.control, { force: true });
    const child = (this.opts.spawn ?? defaultSpawn)(
      "ssh",
      masterArgs(this.target)
    );
    this.master = child;
    let stderr = "";
    let exited = false;
    child.stdout?.resume();
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    child.once("error", (err) => {
      stderr += `\n${err.message}`;
      exited = true;
    });
    child.once("exit", () => {
      exited = true;
      if (this.master !== child) return;
      this.master = undefined;
      // While connecting, openMaster's own loop reports the exit.
      if (this.closed || this.state === "connecting") return;
      this.set("unreachable", describeSshFailure(this.target.dest, stderr));
      this.retry();
    });

    const timeoutMs = this.opts.readyTimeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exited) throw new Error(describeSshFailure(this.target.dest, stderr));
      const check = await this.run(
        "ssh",
        ["-S", this.target.control, "-O", "check", this.target.dest],
        { timeoutMs: 5000 }
      );
      if (check.exitCode === 0 && !exited) return;
      if (Date.now() > deadline) {
        this.stopMaster();
        throw new Error(
          `ssh to ${this.target.dest} did not connect within ${Math.round(timeoutMs / 1000)} s`
        );
      }
      await sleep(this.opts.readyIntervalMs ?? 250);
    }
  }

  private stopMaster(): void {
    const master = this.master;
    this.master = undefined;
    if (master && master.exitCode === null) master.kill();
  }

  /** Reconnects after `ms`, or after the backoff delay, which then doubles. */
  private retry(ms?: number): void {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    const wait = ms ?? this.delay;
    if (ms === undefined)
      this.delay = nextDelay(this.delay, this.opts.retryMaxMs ?? 60_000);
    this.retryTimer = setTimeout(() => void this.connect(), wait);
    this.retryTimer.unref?.();
  }

  private set(state: NodeState, reason?: string): void {
    if (this.closed || (this.state === state && this.reason === reason)) return;
    this.state = state;
    this.reason = reason;
    this.opts.onChange();
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/node-connection.test.ts && pnpm typecheck` Expected: PASS. If the "never gets ready" test runs past vitest's 10 s timeout, check that `readyTimeoutMs: 200` is being passed through.

- [ ] **Step 5: Commit**

```bash
git add src/server/node-connection.ts test/server/node-connection.test.ts
git commit -m "feat(server): NodeConnection keeps an ssh master alive with preflight and backoff"
```

---

### Task 7: `Nodes` registry and the snapshot

**Files:**

- Create: `src/server/nodes.ts`
- Modify: `src/server/state.ts`
- Test: `test/server/nodes.test.ts`, `test/server/state.test.ts`

**Interfaces:**

- Consumes: `loadConfig`, `saveConfig`, `addNode`, `removeNode`, `InvalidNodeError`, `NodeConfig` (Task 4); `NodeConnection` (Task 6); `nodeStats` (Task 5); `Host`, `localHost`, `LOCAL_NODE` (Task 2); `NotFoundError` from `src/server/orchestrator.ts`.
- Produces:

```ts
// state.ts
StateStore.setNodes(views: NodeView[]): void; // snapshot() gains nodes when non-empty
// nodes.ts
/** What the registry needs from a connection; NodeConnection is one. */
export interface NodeConnectionPort {
  readonly host: Host;
  readonly online: boolean;
  view(): NodeView;
  start(): void;
  close(): Promise<void>;
}
export interface NodesOptions {
  configDir: string;
  controlDir: string;
  store: Pick<StateStore, "setNodes">;
  local?: Host;
  connect?: (node: NodeConfig, onChange: () => void) => NodeConnectionPort;
  stats?: (run: Runner) => Promise<NodeStats | undefined>;
  statsIntervalMs?: number; // default 10_000
}
export class Nodes {
  readonly local: Host;
  constructor(opts: NodesOptions);
  start(): void;
  list(): NodeView[];
  host(id: NodeId): Host | undefined;
  add(input: { ssh: unknown; label?: unknown }): Promise<NodeView>;
  remove(id: NodeId): Promise<void>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write the failing store test**

Add to `test/server/state.test.ts` (inside its top-level `describe`, or in a new `describe("nodes", …)`; use the constructor pattern the file already uses):

```ts
it("publishes nodes in the snapshot and skips no-op updates", () => {
  const store = new StateStore({
    port: 7777,
    persisted: { projects: {} },
    persist: () => {},
  });
  const changes = vi.fn();
  store.subscribe(changes);
  expect(store.snapshot().nodes).toBeUndefined();
  const nodes = [
    { id: "local", label: "This machine", state: "online" as const },
  ];
  store.setNodes(nodes);
  store.setNodes([...nodes]);
  expect(store.snapshot().nodes).toEqual(nodes);
  expect(changes).toHaveBeenCalledTimes(1);
});
```

Import `vi` from vitest if the file doesn't yet.

- [ ] **Step 2: Write the failing registry tests**

Create `test/server/nodes.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InvalidNodeError,
  loadConfig,
  saveConfig,
  type NodeConfig,
} from "../../src/server/config";
import { localHost } from "../../src/server/host";
import { type NodeConnectionPort, Nodes } from "../../src/server/nodes";
import { NotFoundError } from "../../src/server/orchestrator";
import type { NodeView } from "../../src/shared/types";
import { fakeRunner } from "../helpers/fake-runner";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function fakeConnection(node: NodeConfig, online: boolean) {
  const host = {
    ...localHost(
      fakeRunner(() => ({
        stdout: "4\nMemTotal: 1024 kB\nMemAvailable: 512 kB\n1\n0\n",
      })).run
    ),
    id: node.id,
  };
  return {
    host,
    online,
    view: (): NodeView => ({
      id: node.id,
      label: node.label ?? node.ssh,
      ssh: node.ssh,
      state: online ? "online" : "unreachable",
    }),
    start: vi.fn(),
    close: vi.fn(async () => {}),
  } satisfies NodeConnectionPort;
}

function setup(nodes: NodeConfig[] = [], online = true) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-reg-"));
  dirs.push(configDir);
  saveConfig(configDir, {
    roots: ["/src"],
    port: 7777,
    ...(nodes.length ? { nodes } : {}),
  });
  const store = { setNodes: vi.fn() };
  const connections = new Map<string, ReturnType<typeof fakeConnection>>();
  const stats = vi.fn(async () => ({
    cpus: 4,
    memTotal: 1024,
    memAvailable: 512,
    containers: 1,
  }));
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
  it("opens configured nodes on start and lists local first", async () => {
    const { registry, store, connections } = setup([
      { id: "box", ssh: "tim@box" },
    ]);
    registry.start();
    expect(connections.get("box")?.start).toHaveBeenCalled();
    expect(registry.list().map((n) => n.id)).toEqual(["local", "box"]);
    expect(registry.list()[0]).toMatchObject({
      label: "This machine",
      state: "online",
    });
    expect(store.setNodes).toHaveBeenCalled();
    await registry.close();
  });

  it("samples stats for local and online nodes", async () => {
    const { registry, store } = setup([{ id: "box", ssh: "tim@box" }]);
    registry.start();
    await vi.waitFor(() =>
      expect(registry.list().every((n) => n.stats?.cpus === 4)).toBe(true)
    );
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
    expect(loadConfig(configDir).nodes).toEqual([
      { id: "box", ssh: "tim@box", label: "Box" },
    ]);
    expect(connections.get("box")?.start).toHaveBeenCalled();
    await registry.close();
  });

  it("rejects bad input without saving", async () => {
    const { registry, configDir } = setup();
    await expect(
      registry.add({ ssh: "-oProxyCommand=x" })
    ).rejects.toBeInstanceOf(InvalidNodeError);
    await expect(registry.add({})).rejects.toBeInstanceOf(InvalidNodeError);
    expect(loadConfig(configDir).nodes).toBeUndefined();
  });

  it("removes a node: closes it and drops it from config", async () => {
    const { registry, configDir, connections } = setup([
      { id: "box", ssh: "tim@box" },
    ]);
    registry.start();
    await registry.remove("box");
    expect(connections.get("box")?.close).toHaveBeenCalled();
    expect(loadConfig(configDir).nodes).toBeUndefined();
    expect(registry.list().map((n) => n.id)).toEqual(["local"]);
    await expect(registry.remove("box")).rejects.toBeInstanceOf(NotFoundError);
    await expect(registry.remove("local")).rejects.toBeInstanceOf(
      NotFoundError
    );
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
    const { registry, connections, stats } = setup([
      { id: "a", ssh: "a" },
      { id: "b", ssh: "b" },
    ]);
    registry.start();
    await registry.close();
    for (const c of connections.values()) expect(c.close).toHaveBeenCalled();
    const calls = stats.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(stats.mock.calls.length).toBe(calls);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/server/nodes.test.ts test/server/state.test.ts` Expected: FAIL, because `nodes.ts` and `setNodes` don't exist.

- [ ] **Step 4: Implement the store part**

In `src/server/state.ts`, add `NodeView` to the type import, then:

```ts
  private nodeViews: NodeView[] = [];
```

with the other fields, and after `setResources`:

```ts
  setNodes(views: NodeView[]): void {
    if (JSON.stringify(this.nodeViews) === JSON.stringify(views)) return;
    this.nodeViews = views;
    this.emit();
  }
```

In `snapshot()`, after the `resources` spread:

```ts
      ...(this.nodeViews.length > 0 ? { nodes: this.nodeViews } : {}),
```

- [ ] **Step 5: Implement the registry**

Create `src/server/nodes.ts`:

```ts
import type { NodeId, NodeStats, NodeView } from "../shared/types";
import {
  InvalidNodeError,
  type NodeConfig,
  addNode,
  loadConfig,
  removeNode,
  saveConfig,
} from "./config";
import type { Runner } from "./exec";
import { type Host, LOCAL_NODE, localHost } from "./host";
import { NodeConnection } from "./node-connection";
import { nodeStats } from "./node-preflight";
import { NotFoundError } from "./orchestrator";
import type { StateStore } from "./state";

/** What the registry needs from a connection; NodeConnection is one. */
export interface NodeConnectionPort {
  readonly host: Host;
  readonly online: boolean;
  view(): NodeView;
  start(): void;
  close(): Promise<void>;
}

export interface NodesOptions {
  configDir: string;
  /** Where ControlMaster sockets go. */
  controlDir: string;
  store: Pick<StateStore, "setNodes">;
  local?: Host;
  connect?: (node: NodeConfig, onChange: () => void) => NodeConnectionPort;
  stats?: (run: Runner) => Promise<NodeStats | undefined>;
  statsIntervalMs?: number;
}

/** This machine plus the configured ssh nodes: their connections, their stats, and the views the dashboard shows. */
export class Nodes {
  readonly local: Host;
  private readonly connections = new Map<NodeId, NodeConnectionPort>();
  private readonly stats = new Map<NodeId, NodeStats>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly opts: NodesOptions) {
    this.local = opts.local ?? localHost();
  }

  start(): void {
    for (const node of loadConfig(this.opts.configDir).nodes ?? [])
      this.open(node);
    this.publish();
    void this.sample();
  }

  list(): NodeView[] {
    const withStats = (view: NodeView): NodeView => {
      const stats = this.stats.get(view.id);
      return stats ? { ...view, stats } : view;
    };
    return [
      withStats({ id: LOCAL_NODE, label: "This machine", state: "online" }),
      ...[...this.connections.values()].map((c) => withStats(c.view())),
    ];
  }

  /** The local host always; a node's host only while it's online. */
  host(id: NodeId): Host | undefined {
    if (id === LOCAL_NODE) return this.local;
    const conn = this.connections.get(id);
    return conn?.online ? conn.host : undefined;
  }

  async add(input: { ssh: unknown; label?: unknown }): Promise<NodeView> {
    if (typeof input.ssh !== "string")
      throw new InvalidNodeError("an ssh destination is required");
    // Re-read so settings saved meanwhile (forges, projects) aren't lost.
    const { config, node } = addNode(loadConfig(this.opts.configDir), {
      ssh: input.ssh,
      ...(typeof input.label === "string" ? { label: input.label } : {}),
    });
    saveConfig(this.opts.configDir, config);
    this.open(node);
    this.publish();
    return this.list().find((n) => n.id === node.id)!;
  }

  async remove(id: NodeId): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) throw new NotFoundError(`no node ${id}`);
    saveConfig(
      this.opts.configDir,
      removeNode(loadConfig(this.opts.configDir), id)
    );
    this.connections.delete(id);
    this.stats.delete(id);
    await conn.close();
    this.publish();
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.all([...this.connections.values()].map((c) => c.close()));
  }

  private open(node: NodeConfig): void {
    const connect =
      this.opts.connect ??
      ((n: NodeConfig, onChange: () => void) =>
        new NodeConnection({
          node: n,
          controlDir: this.opts.controlDir,
          onChange,
        }));
    const conn = connect(node, () => this.publish());
    this.connections.set(node.id, conn);
    conn.start();
  }

  private publish(): void {
    if (!this.stopped) this.opts.store.setNodes(this.list());
  }

  /** Samples local and online nodes, then again `statsIntervalMs` after the round ends. */
  private async sample(): Promise<void> {
    const read = this.opts.stats ?? nodeStats;
    const targets: Array<[NodeId, Host]> = [[LOCAL_NODE, this.local]];
    for (const [id, conn] of this.connections) {
      if (conn.online) targets.push([id, conn.host]);
      else this.stats.delete(id);
    }
    await Promise.all(
      targets.map(async ([id, host]) => {
        const stats = await read(host.run).catch(() => undefined);
        if (stats) this.stats.set(id, stats);
        else this.stats.delete(id);
      })
    );
    if (this.stopped) return;
    this.publish();
    this.timer = setTimeout(
      () => void this.sample(),
      this.opts.statsIntervalMs ?? 10_000
    );
    this.timer.unref?.();
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run test/server/nodes.test.ts test/server/state.test.ts && pnpm typecheck` Expected: PASS. If importing `NotFoundError` from `orchestrator.ts` makes a cycle that typecheck or the tests trip over, move `NotFoundError` to a new `src/server/errors.ts`, re-export it from `orchestrator.ts`, and import it from there in `nodes.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/server/nodes.ts src/server/state.ts test/server/nodes.test.ts test/server/state.test.ts
git commit -m "feat(server): Nodes registry publishes node health and capacity"
```

---

### Task 8: API endpoints, CLI subcommand, and wiring

**Files:**

- Modify: `src/server/dashboard-api.ts`, `src/server/cli.ts`
- Test: `test/server/dashboard-api.test.ts`, `test/server/cli.test.ts`

**Interfaces:**

- Consumes: `Nodes` (Task 7); `addNode`, `removeNode`, `loadConfig`, `saveConfig`, `InvalidNodeError` (Task 4).
- Produces:
  - `DashboardDeps.nodes?: Pick<Nodes, "add" | "remove">`.
  - `POST /api/nodes` with `{ ssh, label? }` returns a `NodeView`. Errors: 400 bad input, 412 when nodes aren't wired.
  - `DELETE /api/nodes/:id` returns `{ ok: true }`. Errors: 404 for an unknown id.
  - `export function runNodesCommand(argv: string[], dir: string, out: { log(s: string): void; error(s: string): void }): number` in `cli.ts`.

- [ ] **Step 1: Write the failing API tests**

Append to `test/server/dashboard-api.test.ts`:

```ts
describe("node endpoints", () => {
  function withNodes() {
    const base = setup();
    const nodes = {
      add: vi.fn(async (input: { ssh: unknown; label?: unknown }) => {
        if (input.ssh === "-bad")
          throw new InvalidNodeError("invalid ssh destination");
        return {
          id: "box",
          label: "Box",
          ssh: String(input.ssh),
          state: "connecting" as const,
        };
      }),
      remove: vi.fn(async (id: string) => {
        if (id !== "box") throw new NotFoundError(`no node ${id}`);
      }),
    };
    const app = createDashboardApp({
      store: base.store,
      orchestrator: base.orchestrator,
      onboarding: base.onboarding,
      push: base.push,
      cleanup: base.cleanup,
      nodes,
    });
    return { app, nodes };
  }
  const post = (app: ReturnType<typeof createDashboardApp>, body: unknown) =>
    app.request("/api/nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("adds a node", async () => {
    const { app, nodes } = withNodes();
    const res = await post(app, { ssh: "tim@box", label: "Box" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "box", ssh: "tim@box" });
    expect(nodes.add).toHaveBeenCalledWith({ ssh: "tim@box", label: "Box" });
  });

  it("answers 400 for an invalid destination", async () => {
    const { app } = withNodes();
    expect((await post(app, { ssh: "-bad" })).status).toBe(400);
  });

  it("removes a node, and answers 404 for an unknown one", async () => {
    const { app, nodes } = withNodes();
    expect(
      (await app.request("/api/nodes/box", { method: "DELETE" })).status
    ).toBe(200);
    expect(nodes.remove).toHaveBeenCalledWith("box");
    expect(
      (await app.request("/api/nodes/nope", { method: "DELETE" })).status
    ).toBe(404);
  });

  it("answers 412 when nodes aren't available", async () => {
    const { app } = setup();
    expect((await post(app, { ssh: "tim@box" })).status).toBe(412);
  });
});
```

Add `import { InvalidNodeError } from "../../src/server/config";` and add `NotFoundError` to the existing orchestrator import if it isn't there.

- [ ] **Step 2: Write the failing CLI tests**

Append to `test/server/cli.test.ts` (add `runNodesCommand` to the import from `../../src/server/cli`):

```ts
describe("runNodesCommand", () => {
  function run(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runNodesCommand(argv, dir, {
      log: (s) => out.push(s),
      error: (s) => err.push(s),
    });
    return { code, out, err };
  }

  it("adds, lists and removes nodes in config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-nodes-"));
    try {
      saveConfig(dir, { roots: ["/a"], port: 7777 });
      expect(run(dir, "list").out).toEqual([
        "No nodes yet. Add one: opendevhub nodes add user@host",
      ]);
      const added = run(dir, "add", "tim@box", "--label", "Box");
      expect(added.code).toBe(0);
      expect(added.out[0]).toMatch(/added node box \(tim@box\)/);
      expect(run(dir, "list").out).toEqual(["box\ttim@box\tBox"]);
      expect(run(dir, "remove", "box").code).toBe(0);
      expect(loadConfig(dir).nodes).toBeUndefined();
      expect(loadConfig(dir).roots).toEqual(["/a"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [["add"]],
    [["add", "a", "b"]],
    [["add", "-oProxyCommand=x"]],
    [["remove", "nope"]],
    [["bogus"]],
    [[]],
  ])("fails with exit 2 for %j", (argv) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-nodes-"));
    try {
      const r = run(dir, ...argv);
      expect(r.code).toBe(2);
      expect(r.err.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/server/dashboard-api.test.ts test/server/cli.test.ts` Expected: FAIL, because the endpoints and `runNodesCommand` are missing.

- [ ] **Step 4: Implement the API**

In `src/server/dashboard-api.ts`:

- Import `InvalidNodeError` from `./config` and `type Nodes` from `./nodes`.
- Add `InvalidNodeError` to the 400 line in `errorStatus`: `if (err instanceof InvalidRequestError || err instanceof EditorUnavailableError || err instanceof InvalidSubscriptionError || err instanceof InvalidNodeError) return 400;`
- Add to `DashboardDeps`:

```ts
  /** Absent in tests that don't need it. */
  nodes?: Pick<Nodes, "add" | "remove">;
```

- In `createDashboardApp`, destructure `nodes` and, after the cleanup routes, add:

```ts
const requireNodes = () => {
  if (!nodes) throw new UnavailableError("remote nodes are not available");
  return nodes;
};
app.post("/api/nodes", (c) =>
  json(c, (_id, b) => requireNodes().add({ ssh: b.ssh, label: b.label }))
);
app.delete("/api/nodes/:id", (c) =>
  json(c, async (id) => void (await requireNodes().remove(id)))
);
```

`json` answers `{ ok: true }` when the handler returns `undefined`.

- [ ] **Step 5: Implement the CLI**

In `src/server/cli.ts`:

- Import `addNode`, `removeNode` from `./config` (next to the existing config imports) and `Nodes` from `./nodes`.
- Extend `USAGE` with these lines before `Environment:`:

```
Remote nodes:
  opendevhub nodes add <ssh-destination> [--label <name>]
  opendevhub nodes list
  opendevhub nodes remove <id>
```

- Add:

```ts
const NODES_USAGE =
  "usage: opendevhub nodes add <ssh-destination> [--label <name>] | nodes list | nodes remove <id>";

/** `opendevhub nodes …`: edits config.json; a running opendevhub picks changes up on restart. */
export function runNodesCommand(
  argv: string[],
  dir: string,
  out: { log(s: string): void; error(s: string): void }
): number {
  const [sub, ...rest] = argv;
  try {
    if (sub === "list") {
      const nodes = loadConfig(dir).nodes ?? [];
      if (nodes.length === 0)
        out.log("No nodes yet. Add one: opendevhub nodes add user@host");
      for (const n of nodes)
        out.log([n.id, n.ssh, ...(n.label ? [n.label] : [])].join("\t"));
      return 0;
    }
    if (sub === "add") {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { label: { type: "string" } },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length !== 1) throw new Error(NODES_USAGE);
      const { config, node } = addNode(loadConfig(dir), {
        ssh: positionals[0],
        ...(values.label ? { label: values.label } : {}),
      });
      saveConfig(dir, config);
      out.log(
        `added node ${node.id} (${node.ssh}); a running opendevhub connects to it after a restart, or add it on the Nodes page instead`
      );
      return 0;
    }
    if (sub === "remove" && rest.length === 1) {
      const cfg = loadConfig(dir);
      if (!cfg.nodes?.some((n) => n.id === rest[0]))
        throw new Error(`no node ${rest[0]}`);
      saveConfig(dir, removeNode(cfg, rest[0]));
      out.log(`removed node ${rest[0]}`);
      return 0;
    }
    throw new Error(NODES_USAGE);
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}
```

- At the top of `main`, before `parseCli`:

```ts
if (argv[0] === "nodes") {
  process.exitCode = runNodesCommand(argv.slice(1), configDir(), console);
  return;
}
```

- In `main`, after `store.setRoots(...)`:

```ts
const nodes = new Nodes({
  configDir: dir,
  controlDir: path.join(dir, "ssh"),
  store,
});
nodes.start();
```

Pass `nodes` to `createDashboardApp({ … })`. In `shutdown`, add `await nodes.close();` right after `await orchestrator.shutdown();`.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run test/server/dashboard-api.test.ts test/server/cli.test.ts && pnpm typecheck` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/dashboard-api.ts src/server/cli.ts test/server/dashboard-api.test.ts test/server/cli.test.ts
git commit -m "feat(server): add and remove nodes from the API and the CLI"
```

---

### Task 9: The `ssh` route

**Files:**

- Modify: `src/server/network.ts`, `src/server/port-forwarder.ts`
- Test: `test/server/network.test.ts`

**Interfaces:**

- Consumes: `Host` (Task 2).
- Produces:

```ts
export type Dial = (port: number) => Promise<Duplex>; // was Promise<net.Socket>
// Route.kind: "direct" | "gateway" | "ssh"
export function openTunnel(dial: () => Promise<Duplex>): Promise<Tunnel>;
export function tunnelRoute(
  kind: "gateway" | "ssh",
  dial: Dial
): Promise<Route>;
export function sshRoute(host: Pick<Host, "dial">, ip: string): Promise<Route>;
```

Plan 2 calls `sshRoute` from `Network.route` for environments on a node.

- [ ] **Step 1: Write the failing test**

Add to `test/server/network.test.ts` (add `sshRoute` to the import from `../../src/server/network`, plus `import { OPENCODE_PORT } from "../../src/server/opencode/runtime";` and `import { RELAY_PORT } from "../../src/server/relay/runtime";`):

```ts
describe("sshRoute", () => {
  it("tunnels opencode and the relay through the host's dial to the container IP", async () => {
    const opencodeUp = await echo("oc:");
    const relayUp = await echo("relay:");
    const dials: Array<[string, number]> = [];
    // Stands in for a node: container ports map to local echo servers.
    const host = {
      dial: async (ip: string, port: number) => {
        dials.push([ip, port]);
        return connectLocal(port === OPENCODE_PORT ? opencodeUp : relayUp);
      },
    };
    const route = await sshRoute(host, "172.18.0.4");
    closers.push(route.close);
    expect(route.kind).toBe("ssh");
    expect(route.opencode.host).toBe("127.0.0.1");
    expect(await roundTrip(route.opencode.port, "a")).toBe("oc:a");
    expect(await roundTrip(route.relay.port, "b")).toBe("relay:b");
    expect(dials).toEqual([
      ["172.18.0.4", OPENCODE_PORT],
      ["172.18.0.4", RELAY_PORT],
    ]);
    expect(route.dial).toBeDefined();
    await route.dial!(8080).then((s) => s.destroy());
    expect(dials.at(-1)).toEqual(["172.18.0.4", 8080]);
  });

  it("stops listening on close", async () => {
    const route = await sshRoute({ dial: () => connectLocal(1) }, "172.18.0.4");
    await route.close();
    await expect(roundTrip(route.opencode.port, "x")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/network.test.ts` Expected: FAIL, because `sshRoute` isn't exported.

- [ ] **Step 3: Implement**

In `src/server/network.ts`:

- Add `import type { Duplex } from "node:stream";` and `import type { Host } from "./host";`.
- Change `export type Dial = (port: number) => Promise<Duplex>;` and update its comment to say "a stream to a port of the container".
- Change `Route.kind` to `"direct" | "gateway" | "ssh"`, and update the `dial` comment: "Set on the gateway and ssh routes; the direct route connects to the container IP itself."
- Change `openTunnel(dial: () => Promise<net.Socket>)` to `openTunnel(dial: () => Promise<Duplex>)`. The body needs no other change, because it only uses `on`, `pipe` and `destroy`.
- Add, after `openTunnel`:

```ts
/** Loopback tunnels for opencode and the relay, each connection through `dial`. */
export async function tunnelRoute(
  kind: "gateway" | "ssh",
  dial: Dial
): Promise<Route> {
  const opencode = await openTunnel(() => dial(OPENCODE_PORT));
  const relay = await openTunnel(() => dial(RELAY_PORT)).catch(
    async (err: unknown) => {
      await opencode.close();
      throw err;
    }
  );
  return {
    kind,
    opencode: opencode.address,
    relay: relay.address,
    dial,
    close: async () => {
      await Promise.all([opencode.close(), relay.close()]);
    },
  };
}

/** A container on another node: every connection is an ssh channel opened from that node. */
export function sshRoute(host: Pick<Host, "dial">, ip: string): Promise<Route> {
  return tunnelRoute("ssh", (port) => host.dial(ip, port));
}
```

- Replace the tail of `Network.route` (from `const dial: Dial = …` to the end of the method) with:

```ts
return tunnelRoute("gateway", (port) => gateway.connect(container.ip, port));
```

In `src/server/port-forwarder.ts`, import `type { Duplex } from "node:stream"`. Change the `Forward.sockets` set, the `upstream` variable and the `pipe` parameter from `net.Socket` to `Duplex`. Client sockets are `net.Socket`, which is a `Duplex`, so the set still holds them.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/network.test.ts test/server/port-forwarder.test.ts test/server/gateway.test.ts && pnpm typecheck` Expected: PASS. Typecheck may name other places that assumed `net.Socket` from a `Dial`. Change those to `Duplex` the same way, without changing behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/server/network.ts src/server/port-forwarder.ts test/server/network.test.ts
git commit -m "feat(server): ssh route tunnels to a container through a node"
```

---

### Task 10: Nodes page in the dashboard

**Files:**

- Modify: `src/web/api.ts`, `src/web/App.tsx`, `src/web/layout/Shell.tsx`
- Create: `src/web/nodes.ts`, `src/web/pages/NodesPage.tsx`
- Test: `test/web/nodes.test.ts`

**Interfaces:**

- Consumes: `NodeView`, `NodeStats`, `NodeState` (Task 2); `POST /api/nodes` and `DELETE /api/nodes/:id` (Task 8); `formatMemory` from `src/web/resources.ts`.
- Produces:

```ts
// src/web/nodes.ts
export function nodeStateLabel(state: NodeState): string;
export function nodeStateClass(state: NodeState): string;
export function formatNodeStats(
  stats: NodeStats | undefined
): string | undefined;
export function nodesNeedingAttention(nodes: NodeView[] | undefined): number;
// src/web/api.ts
export function addNode(ssh: string, label?: string): Promise<NodeView>;
export function removeNode(id: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

Create `test/web/nodes.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  formatNodeStats,
  nodeStateLabel,
  nodesNeedingAttention,
} from "../../src/web/nodes";

const GiB = 1024 ** 3;

describe("node view helpers", () => {
  it("labels states", () => {
    expect(nodeStateLabel("online")).toBe("Online");
    expect(nodeStateLabel("connecting")).toBe("Connecting…");
    expect(nodeStateLabel("unreachable")).toBe("Unreachable");
    expect(nodeStateLabel("error")).toBe("Needs setup");
  });

  it("formats stats on one line", () => {
    expect(
      formatNodeStats({
        cpus: 8,
        memTotal: 32 * GiB,
        memAvailable: 12.5 * GiB,
        containers: 3,
      })
    ).toBe("8 CPUs · 12.5 GiB free of 32.0 GiB · 3 containers");
    expect(
      formatNodeStats({
        cpus: 1,
        memTotal: GiB,
        memAvailable: 512 * 1024 ** 2,
        containers: 1,
      })
    ).toBe("1 CPU · 512 MiB free of 1.0 GiB · 1 container");
    expect(formatNodeStats(undefined)).toBeUndefined();
  });

  it("counts nodes that need attention", () => {
    expect(nodesNeedingAttention(undefined)).toBe(0);
    expect(
      nodesNeedingAttention([
        { id: "local", label: "This machine", state: "online" },
        { id: "a", label: "a", state: "unreachable" },
        { id: "b", label: "b", state: "error" },
        { id: "c", label: "c", state: "connecting" },
      ])
    ).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/web/nodes.test.ts` Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement the helpers and API calls**

Create `src/web/nodes.ts`:

```ts
import type { NodeState, NodeStats, NodeView } from "../shared/types";
import { formatMemory } from "./resources";

const LABELS: Record<NodeState, string> = {
  online: "Online",
  connecting: "Connecting…",
  unreachable: "Unreachable",
  error: "Needs setup",
};

export function nodeStateLabel(state: NodeState): string {
  return LABELS[state];
}

/** Classes for the state chip. */
export function nodeStateClass(state: NodeState): string {
  if (state === "online") return "text-muted-foreground";
  if (state === "connecting") return "border-attention/50 text-attention";
  return "border-destructive/50 text-destructive";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "8 CPUs · 12.5 GiB free of 32.0 GiB · 3 containers". */
export function formatNodeStats(
  stats: NodeStats | undefined
): string | undefined {
  if (!stats) return undefined;
  return [
    plural(stats.cpus, "CPU"),
    `${formatMemory(stats.memAvailable)} free of ${formatMemory(stats.memTotal)}`,
    plural(stats.containers, "container"),
  ].join(" · ");
}

export function nodesNeedingAttention(nodes: NodeView[] | undefined): number {
  return (nodes ?? []).filter(
    (n) => n.state === "unreachable" || n.state === "error"
  ).length;
}
```

`formatMemory(32 * GiB)` returns `"32.0 GiB"`, which is what the test expects.

In `src/web/api.ts`, add `NodeView` to the type import and append:

```ts
export async function addNode(ssh: string, label?: string): Promise<NodeView> {
  const res = await fetch("/api/nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssh, ...(label ? { label } : {}) }),
  });
  if (!res.ok) throw await failure(res, "add node");
  return (await res.json()) as NodeView;
}

export async function removeNode(id: string): Promise<void> {
  const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await failure(res, "remove node");
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/web/nodes.test.ts` Expected: PASS.

- [ ] **Step 5: Build the page**

Create `src/web/pages/NodesPage.tsx`:

```tsx
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import type { NodeView } from "../../shared/types";
import { addNode, removeNode } from "../api";
import {
  Chip,
  muted,
  Note,
  Page,
  PageHeader,
  Section,
} from "../components/Page";
import { useDash } from "../DashboardContext";
import { formatNodeStats, nodeStateClass, nodeStateLabel } from "../nodes";

function NodeRow(props: { node: NodeView; onRemove?: () => void }) {
  const { node } = props;
  const stats = formatNodeStats(node.stats);
  return (
    <div className="flex flex-col gap-1 border-b px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{node.label}</span>
        {node.ssh && node.ssh !== node.label && (
          <span className="text-muted-foreground font-mono text-sm">
            {node.ssh}
          </span>
        )}
        <Chip variant="outline" className={nodeStateClass(node.state)}>
          {nodeStateLabel(node.state)}
        </Chip>
        {props.onRemove && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7"
            onClick={props.onRemove}
          >
            Remove
          </Button>
        )}
      </div>
      {stats && <span className={cn(muted, "tabular-nums")}>{stats}</span>}
      {node.reason && <Note warn>{node.reason}</Note>}
    </div>
  );
}

export function NodesPage() {
  const { snapshot, report } = useDash();
  const [ssh, setSsh] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<NodeView>();
  const nodes = snapshot?.nodes ?? [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await addNode(ssh.trim(), label.trim() || undefined);
      setSsh("");
      setLabel("");
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const id = removing.id;
    setRemoving(undefined);
    await removeNode(id).catch(report);
  };

  return (
    <Page>
      <PageHeader
        title="Nodes"
        description="Machines that run task environments, reached over ssh. Tasks can't be placed on them yet."
      />

      <Section title="Machines">
        {nodes.map((node) => (
          <NodeRow
            key={node.id}
            node={node}
            onRemove={node.id === "local" ? undefined : () => setRemoving(node)}
          />
        ))}
      </Section>

      <Section
        title="Add a node"
        hint="needs Docker, the devcontainer CLI and git ≥ 2.48 on the machine, and an ssh key that works without a prompt"
      >
        <form
          className="flex flex-wrap items-end gap-3 px-4 py-3"
          onSubmit={(e) => void submit(e)}
        >
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="node-ssh">ssh destination</Label>
            <Input
              id="node-ssh"
              placeholder="tim@workstation"
              value={ssh}
              onChange={(e) => setSsh(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex min-w-40 flex-col gap-1.5">
            <Label htmlFor="node-label">Label (optional)</Label>
            <Input
              id="node-label"
              placeholder="Workstation"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || ssh.trim() === ""}>
            Add node
          </Button>
        </form>
        {error && (
          <Note warn className="mx-4 mb-3">
            {error}
          </Note>
        )}
      </Section>

      <Dialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.label}?</DialogTitle>
            <DialogDescription>
              opendevhub disconnects and forgets this node. Nothing on the
              machine is deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(undefined)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
```

Check that `muted` is exported from `../components/Page`; `CleanupPage.tsx` imports it from there. Check that `Section` renders its children inside a bordered card, as on the Cleanup page. If either differs, follow `CleanupPage.tsx`.

- [ ] **Step 6: Add the route and nav item**

In `src/web/App.tsx`, import `NodesPage` and add `<Route path="nodes" element={<NodesPage />} />` after the `cleanup` route.

In `src/web/layout/Shell.tsx`, add `ServerIcon` to the `lucide-react` import, import `nodesNeedingAttention` from `../nodes`, and add after the Cleanup `NavItem`:

```tsx
<NavItem
  to="/nodes"
  badge={
    nodesNeedingAttention(snapshot.nodes) > 0 && (
      <Count n={nodesNeedingAttention(snapshot.nodes)} tone="attention" />
    )
  }
>
  <ServerIcon /> Nodes
</NavItem>
```

`Count` is the component the Sessions item already uses.

- [ ] **Step 7: Typecheck, test, build**

Run: `pnpm typecheck && pnpm vitest run test/web && pnpm build` Expected: PASS, and the build succeeds.

- [ ] **Step 8: Check it in the browser**

Run `pnpm dev` and `pnpm dev:web` (or use the `run` skill). Open `/nodes`. Check:

- "This machine" is listed as Online with stats (on Linux).
- Adding `-x` shows the "invalid ssh destination" note.
- Adding `nosuchhost.invalid` lists it, and within about 15 s it shows "Unreachable" with ssh's reason.
- Remove asks for confirmation, then drops the node.

Take a screenshot for the review.

- [ ] **Step 9: Commit**

```bash
git add src/web/nodes.ts src/web/api.ts src/web/pages/NodesPage.tsx src/web/App.tsx src/web/layout/Shell.tsx test/web/nodes.test.ts
git commit -m "feat(web): Nodes page to add, watch and remove nodes"
```

---

### Task 11: Integration test against `ssh localhost`, and docs

**Files:**

- Create: `test/server/ssh-localhost.test.ts`
- Modify: `../../README.md`

**Interfaces:**

- Consumes: `NodeConnection` (Task 6), `SshHost` (Task 3), `sshRoute` (Task 9).

- [ ] **Step 1: Write the opt-in integration test**

Create `test/server/ssh-localhost.test.ts`:

```ts
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

import { sshRoute } from "../../src/server/network";
import { NodeConnection } from "../../src/server/node-connection";

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
    expect(await conn.host.readFile(file)).toBe("über\n");

    const server = net.createServer((s) =>
      s.on("data", (d) => s.write(`echo:${d.toString()}`))
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const port = (server.address() as net.AddressInfo).port;
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
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run test/server/ssh-localhost.test.ts` Expected: skipped (1 skipped).

Then, if `ssh -o BatchMode=yes localhost true` succeeds on this machine: Run: `ODH_TEST_SSH_LOCALHOST=1 pnpm vitest run test/server/ssh-localhost.test.ts` Expected: PASS. If localhost isn't set up (for example "Host key verification failed"), report that in the task summary instead of changing the machine's ssh config.

- [ ] **Step 3: Document**

In `README.md` at the repo root, add a section before `## Development`:

```markdown
## Remote nodes (preview)

Other machines can join as nodes, reached over ssh. Tasks can't be placed on them yet; for now the Nodes page shows whether each one is reachable and ready, and how much CPU and memory it has free.

Add one on the Nodes page, or with `opendevhub nodes add tim@workstation --label Workstation` (then restart opendevhub). A node needs:

- Docker, the devcontainer CLI and git 2.48 or newer, on the PATH of a **non-interactive** ssh shell. Tools installed through nvm or a login profile often aren't: check with `ssh tim@workstation 'devcontainer --version'`, and if it fails, link the binary into `/usr/local/bin` or set PATH in `~/.ssh/environment` (with `PermitUserEnvironment yes`).
- An ssh key that logs in without a prompt, and a known host key: run `ssh tim@workstation` once.
- `AllowTcpForwarding yes` in its sshd config (the default).

opendevhub keeps one ssh connection per node (a ControlMaster under `~/.config/opendevhub/ssh/`) and reconnects by itself when a node drops. Nothing is installed on the node and nothing listens there besides sshd.
```

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm test && pnpm build` Expected: everything passes, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add test/server/ssh-localhost.test.ts ../../README.md
git commit -m "test: ssh localhost integration for nodes; docs: remote nodes preview"
```
