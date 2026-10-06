import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { spawnRunner } from "../../src/server/exec";

const node = process.execPath;

describe("spawnRunner", () => {
  it("writes input to stdin and closes it", async () => {
    const r = await spawnRunner(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello\nworld" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hello\nworld");
  });

  it("captures stdout, stderr and exit code", async () => {
    const r = await spawnRunner(node, ["-e", "console.log('out'); console.error('err'); process.exit(3)"]);
    expect(r).toMatchObject({ exitCode: 3, timedOut: false });
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  it("streams complete lines to onLine, joining partial chunks", async () => {
    const lines: string[] = [];
    await spawnRunner(
      node,
      ["-e", "process.stdout.write('a\\nb'); setTimeout(() => process.stdout.write('c\\n'), 20)"],
      { onLine: (l) => lines.push(l) },
    );
    expect(lines).toEqual(["a", "bc"]);
  });

  it("reports a missing binary as exit code 127", async () => {
    const r = await spawnRunner("opendevhub-no-such-binary", []);
    expect(r.exitCode).toBe(127);
  });

  it("kills the process on timeout", async () => {
    const r = await spawnRunner(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("kills a detached run's whole process group on timeout", async () => {
    const r = await spawnRunner(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200, detached: true });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("passes extra env vars", async () => {
    const r = await spawnRunner(node, ["-e", "console.log(process.env.ODH_FOO)"], { env: { ODH_FOO: "bar" } });
    expect(r.stdout.trim()).toBe("bar");
  });

  it("runs in the given working directory", async () => {
    const dir = os.tmpdir();
    const r = await spawnRunner(node, ["-e", "console.log(process.cwd())"], { cwd: dir });
    expect(fs.realpathSync(r.stdout.trim())).toBe(fs.realpathSync(dir));
  });
});
