import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeConnection,
  nextDelay,
} from "../../../src/server/nodes/connection";
import type { NodeView } from "../../../src/shared/types";
import { fakeRunner } from "../../helpers/fake-runner";
import type { Call } from "../../helpers/fake-runner";

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
      if (child.exitCode !== null) {
        return;
      }
      if (stderr) {
        (child.stderr as PassThrough).write(stderr);
      }
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
    home?: string;
  } = {}
) {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-ctl-"));
  const masters: FakeChild[] = [];
  let checks = 0;
  const runner = fakeRunner((c: Call) => {
    if (c.args.includes("-O") && c.args.includes("check")) {
      return { exitCode: (opts.check ?? (() => 0))(++checks) };
    }
    if (c.args[0] === "-G") {
      return { stdout: "user tim\nport 2222\n" };
    }
    if (c.args.at(-1)?.includes('"$HOME"')) {
      return { stdout: opts.home ?? "/home/tim" };
    }
    return {};
  });
  const preflight = vi.fn(opts.preflight ?? (async () => []));
  /** Every view the connection reported; states can pass faster than vi.waitFor polls. */
  const history: NodeView[] = [];
  const onChange = vi.fn(() => history.push(conn.view()));
  const conn: NodeConnection = new NodeConnection({
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
  return { conn, masters, runner, preflight, onChange, controlDir, history };
}

describe(nextDelay, () => {
  it("doubles up to the cap", () => {
    expect(nextDelay(1000, 60_000)).toBe(2000);
    expect(nextDelay(40_000, 60_000)).toBe(60_000);
  });
});

describe(NodeConnection, () => {
  it("reads the node's home folder before going online", async () => {
    const { conn } = setup();
    conn.start();
    await vi.waitFor(() => expect(conn.online).toBeTruthy());
    expect(conn.host.home).toBe("/home/tim");
    expect(conn.target).toStrictEqual({
      dest: "tim@box",
      control: expect.stringMatching(/box\.sock$/u),
    });
  });

  it("stays unreachable when $HOME can't be read", async () => {
    const { conn, history } = setup({ home: "" });
    conn.start();
    await vi.waitFor(() =>
      expect(history).toContainEqual(
        expect.objectContaining({
          state: "unreachable",
          reason: "could not read $HOME on tim@box",
        })
      )
    );
  });

  it("starts the master, runs preflight with the resolved port and goes online", async () => {
    const { conn, masters, preflight, onChange, controlDir } = setup();
    expect(conn.view()).toStrictEqual({
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
    const { conn, masters, history } = setup({ check: () => 255 });
    conn.start();
    await vi.waitFor(() => expect(masters).toHaveLength(1));
    masters[0].exitWith(255, "Host key verification failed.\r\n");
    await vi.waitFor(() =>
      expect(history).toContainEqual(
        expect.objectContaining({
          state: "unreachable",
          reason:
            "add the host key and an ssh key for tim@box first (run `ssh tim@box` once)",
        })
      )
    );
    await vi.waitFor(() => expect(masters.length).toBeGreaterThanOrEqual(2));
  });

  it("gives up waiting for a master that never gets ready, and kills it", async () => {
    const { conn, masters } = setup({ check: () => 255 });
    conn.start();
    await vi.waitFor(() => expect(conn.view().state).toBe("unreachable"), {
      timeout: 2000,
    });
    expect(conn.view().reason).toMatch(/did not connect within/u);
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
    const { conn, masters, history } = setup();
    conn.start();
    await vi.waitFor(() => expect(conn.online).toBeTruthy());
    masters[0].exitWith(255, "Timeout, server box not responding.\n");
    await vi.waitFor(() =>
      expect(history).toContainEqual(
        expect.objectContaining({
          state: "unreachable",
          reason: "ssh to tim@box failed: Timeout, server box not responding.",
        })
      )
    );
    await vi.waitFor(() => expect(conn.online).toBeTruthy());
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
    expect(onChange).toHaveBeenCalledTimes(changes);
    for (const m of masters) {
      expect(m.exitCode).not.toBeNull();
    }
  });

  it("close while online asks the master to exit and kills it", async () => {
    const { conn, masters, runner } = setup();
    conn.start();
    await vi.waitFor(() => expect(conn.online).toBeTruthy());
    await conn.close();
    expect(
      runner.calls.some((c) => c.args.includes("-O") && c.args.includes("exit"))
    ).toBeTruthy();
    expect(masters[0].kill).toHaveBeenCalled();
  });
});
