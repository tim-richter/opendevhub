import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { RunResult } from "../../src/server/exec";
import {
  nodePreflight,
  nodeStats,
  parseNodeStats,
  probeForwarding,
} from "../../src/server/node-preflight";
import { fakeRunner } from "../helpers/fake-runner";
import type { Call } from "../helpers/fake-runner";

/** A dial that answers like sshd, fails with `error`, or never answers. */
function dialer(
  mode: {
    banner?: string;
    error?: string;
    reject?: string;
    silent?: boolean;
  } = { banner: "SSH-2.0-OpenSSH_9.6\r\n" }
) {
  const calls: [string, number][] = [];
  const dial = async (ip: string, port: number) => {
    calls.push([ip, port]);
    if (mode.reject) {
      throw new Error(mode.reject);
    }
    const s = new PassThrough();
    setImmediate(() => {
      if (mode.error) {
        s.destroy(new Error(mode.error));
      } else if (mode.banner) {
        s.write(mode.banner);
      }
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

describe(nodePreflight, () => {
  it("passes when every tool is there and forwarding works", async () => {
    const { dial, calls } = dialer();
    await expect(
      nodePreflight({ run: tools().run, dial }, 2222, "tim@box")
    ).resolves.toStrictEqual([]);
    expect(calls).toStrictEqual([["127.0.0.1", 2222]]);
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
      /devcontainer CLI not found on the PATH of a non-interactive ssh shell/u
    );
    expect(errors[0]).toMatch(/nvm/u);
  });

  it("reports a Docker daemon it can't reach, an old git and an unwritable folder", async () => {
    const { run } = tools({
      docker: { exitCode: 1 },
      git: { stdout: "git version 2.43.0\n" },
      home: { exitCode: 1 },
    });
    const errors = await nodePreflight(
      { run, dial: dialer().dial },
      22,
      "tim@box"
    );
    expect(errors).toStrictEqual([
      "the Docker daemon is not reachable (is Docker running, and may the ssh user use it?)",
      "git 2.48 or newer is needed (found git version 2.43.0)",
      "~/.opendevhub can't be created or isn't writable",
    ]);
  });
});

describe(probeForwarding, () => {
  it("is fine when sshd greets through the channel", async () => {
    await expect(
      probeForwarding(dialer(), 22, "tim@box")
    ).resolves.toBeUndefined();
  });

  it("is fine when the port refuses: the channel itself opened", async () => {
    await expect(
      probeForwarding(
        dialer({
          error: "channel 0: open failed: connect failed: Connection refused",
        }),
        22,
        "tim@box"
      )
    ).resolves.toBeUndefined();
  });

  it("names AllowTcpForwarding when sshd prohibits it", async () => {
    const d = dialer({
      error: "channel 0: open failed: administratively prohibited: open failed",
    });
    await expect(probeForwarding(d, 22, "tim@box")).resolves.toBe(
      "sshd on tim@box does not allow TCP forwarding (AllowTcpForwarding)"
    );
  });

  it("reports a dial that can't start and a channel that stays silent", async () => {
    await expect(
      probeForwarding(dialer({ reject: "spawn ssh ENOENT" }), 22, "tim@box")
    ).resolves.toBe(
      "opening an ssh channel to tim@box failed: spawn ssh ENOENT"
    );
    await expect(
      probeForwarding(
        dialer({ silent: true, banner: undefined }),
        22,
        "tim@box",
        20
      )
    ).resolves.toBe(
      "sshd on tim@box did not answer through a forwarded channel"
    );
  });
});

describe("node stats", () => {
  const sample =
    "8\nMemTotal:       32768000 kB\nMemAvailable:   16384000 kB\n2\n3\n";

  it("parses cpus, memory in bytes and both container counts", () => {
    expect(parseNodeStats(sample)).toStrictEqual({
      cpus: 8,
      memTotal: 32_768_000 * 1024,
      memAvailable: 16_384_000 * 1024,
      containers: 5,
    });
  });

  it("is undefined when /proc/meminfo is missing (macOS)", () => {
    expect(parseNodeStats("10\n0\n0\n")).toBeUndefined();
  });

  it("runs one shell script and gives up quietly on failure", async () => {
    const ok = fakeRunner(() => ({ stdout: sample }));
    await expect(nodeStats(ok.run)).resolves.toMatchObject({ cpus: 8 });
    expect(ok.calls[0].cmd).toBe("sh");
    expect(ok.calls[0].args[1]).toContain("label=opendevhub.env");
    await expect(
      nodeStats(fakeRunner(() => ({ exitCode: 255 })).run)
    ).resolves.toBeUndefined();
  });
});
