import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Containers } from "../../src/server/containers";
import { OpencodeClient } from "../../src/server/opencode/client";
import {
  LINK_STATE,
  OpencodeRuntime,
  parseBinaryPath,
  parseOpencodeVersion,
} from "../../src/server/opencode/runtime";
import type { Project } from "../../src/shared/types";
import { startFakeOpencode } from "../helpers/fake-opencode";
import type { FakeOpencode } from "../helpers/fake-opencode";
import { fakeRunner } from "../helpers/fake-runner";
import type { Call } from "../helpers/fake-runner";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer.json",
};
let fake: FakeOpencode;
beforeEach(async () => {
  fake = await startFakeOpencode("pw");
});
afterEach(() => fake.close());

interface Output {
  exitCode?: number;
  stdout?: string;
}
const BIN = "/home/node/.opencode/bin/opencode";
const isResolve = (c: Call) =>
  c.args.at(-1)?.includes("command -v opencode") ?? false;

function runtimeWith(
  versionOutput: Output,
  resolveOutput: Output = { stdout: `${BIN}\n` }
) {
  const { run, calls } = fakeRunner((c: Call) =>
    isResolve(c)
      ? resolveOutput
      : c.args.includes("--version")
        ? versionOutput
        : {}
  );
  const runtime = new OpencodeRuntime({
    containers: new Containers(run),
    clientFor: (ep) => new OpencodeClient(ep),
    port: fake.port,
    healthTimeoutMs: 300,
    healthIntervalMs: 20,
    generatePassword: () => "pw",
  });
  return { runtime, calls };
}
const args = () => ({
  address: { host: "127.0.0.1", port: fake.port },
  workspaceFolder: "/workspaces/demo",
  onLine: () => {},
});

describe(parseOpencodeVersion, () => {
  it.each([
    ["opencode v2.0.20", "2.0.20"],
    ["1.18.31\n", "1.18.31"],
    ["garbage", undefined],
  ])("%s -> %s", (input, expected) =>
    expect(parseOpencodeVersion(input)).toBe(expected)
  );
});

describe(parseBinaryPath, () => {
  it.each([
    [`${BIN}\n`, BIN],
    [
      "Welcome to zsh!\n[oh-my-zsh] update available\n/usr/local/bin/opencode\n",
      "/usr/local/bin/opencode",
    ],
    ["opencode: aliased to foo\n", undefined],
    ["", undefined],
  ])("%j -> %s", (input, expected) =>
    expect(parseBinaryPath(input)).toBe(expected)
  );
});

describe("OpencodeRuntime.ensureRunning", () => {
  it("launches opencode serve with the extra environment", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "2.0.20" });
    await runtime.ensureRunning(project, {
      ...args(),
      env: { SSH_AUTH_SOCK: "/tmp/opendevhub-ssh-agent.sock" },
    });
    const launch = calls.find((c) =>
      c.args.at(-1)?.includes(" serve --hostname")
    )!;
    expect(launch.args).toContain(
      "SSH_AUTH_SOCK=/tmp/opendevhub-ssh-agent.sock"
    );
    expect(launch.args).toContain("OPENCODE_PASSWORD=pw");
  });

  it("searches PATH, the installer dirs and bash/zsh login shells for the binary", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    await runtime.ensureRunning(project, args());
    const script = calls.find(isResolve)?.args.at(-1) ?? "";
    for (const needle of [
      "command -v opencode",
      "$HOME/.opencode/bin/opencode",
      "$HOME/.local/bin/opencode",
      "$HOME/.bun/bin/opencode",
      "-lic",
      "-ic",
    ]) {
      expect(script).toContain(needle);
    }
    expect(script).toMatch(/for sh in bash zsh/u);
  });

  it("uses the resolved absolute path for --version and serve", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    await runtime.ensureRunning(project, args());
    expect(
      calls.find((c) => c.args.at(-1) === "--version")?.args.slice(-2)
    ).toStrictEqual([BIN, "--version"]);
    const launch = calls.find((c) =>
      c.args.at(-1)?.includes("serve --hostname 0.0.0.0")
    );
    expect(launch?.args.at(-1)).toContain(`nohup '${BIN}' serve`);
  });

  it("accepts a binary found only via a noisy zsh login shell", async () => {
    const { runtime, calls } = runtimeWith(
      { stdout: "opencode v2.0.20" },
      {
        stdout:
          "[oh-my-zsh] Would you like to update? [Y/n]\n/opt/tools/opencode\n",
      }
    );
    await runtime.ensureRunning(project, args());
    expect(calls.find((c) => c.args.at(-1) === "--version")?.args.at(-2)).toBe(
      "/opt/tools/opencode"
    );
  });

  it("launches opencode serve with the generated password and waits for health", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20\n" });
    const res = await runtime.ensureRunning(project, args());
    expect(res).toStrictEqual({ password: "pw", version: "2.0.20" });
    const launch = calls.find((c) =>
      c.args.at(-1)?.includes("serve --hostname 0.0.0.0")
    );
    expect(launch?.args).toStrictEqual(
      expect.arrayContaining([
        "--remote-env",
        "OPENCODE_PASSWORD=pw",
        "sh",
        "-c",
      ])
    );
    expect(launch?.args.at(-1)).toContain(`--port ${fake.port}`);
    expect(launch?.args.at(-1)).toContain("cd '/workspaces/demo'");
    expect(
      calls.some((c) => c.args.at(-1)?.includes("pkill -f 'opencode [s]erve'"))
    ).toBeTruthy();
  });

  it("is idempotent when the server already answers with the given password", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    const res = await runtime.ensureRunning(project, {
      ...args(),
      password: "pw",
    });
    expect(res).toStrictEqual({ password: "pw", version: "2.0.20" });
    expect(calls).toHaveLength(0);
  });

  it("fails clearly, listing the searched locations, when opencode is not found", async () => {
    const { runtime, calls } = runtimeWith(
      { stdout: "opencode v2.0.20" },
      { exitCode: 1, stdout: "" }
    );
    await expect(runtime.ensureRunning(project, args())).rejects.toThrow(
      /opencode v2 not found in the devcontainer.*PATH.*~\/\.opencode\/bin.*bash\/zsh/u
    );
    expect(calls.some((c) => c.args.at(-1) === "--version")).toBeFalsy();
  });

  it("fails clearly when the found binary cannot report its version", async () => {
    const { runtime } = runtimeWith({ exitCode: 126, stdout: "" });
    await expect(runtime.ensureRunning(project, args())).rejects.toThrow(
      `failed to run ${BIN} --version`
    );
  });

  it("rejects opencode v1", async () => {
    const { runtime } = runtimeWith({ stdout: "1.18.31" });
    await expect(runtime.ensureRunning(project, args())).rejects.toThrow(
      /requires opencode v2/u
    );
  });

  it("times out when the server never becomes healthy", async () => {
    const { run } = fakeRunner((c) =>
      isResolve(c)
        ? { stdout: BIN }
        : c.args.includes("--version")
          ? { stdout: "2.0.20" }
          : {}
    );
    const runtime = new OpencodeRuntime({
      containers: new Containers(run),
      clientFor: (ep) => new OpencodeClient(ep),
      port: fake.port,
      healthTimeoutMs: 200,
      healthIntervalMs: 20,
      generatePassword: () => "wrong-password",
    });
    await expect(runtime.ensureRunning(project, args())).rejects.toThrow(
      /did not become healthy/u
    );
  });
});

describe("OpencodeRuntime.resolveBinary", () => {
  it("returns the resolved path or undefined", async () => {
    const found = runtimeWith({ stdout: "opencode v2.0.20" });
    await expect(found.runtime.resolveBinary(project)).resolves.toBe(BIN);
    const missing = runtimeWith(
      { stdout: "opencode v2.0.20" },
      { exitCode: 1, stdout: "" }
    );
    await expect(
      missing.runtime.resolveBinary(project)
    ).resolves.toBeUndefined();
  });
});

describe("OpencodeRuntime.persistState", () => {
  const ROOT_EXEC = ["exec", "-u", "root"];
  const isRoot = (c: Call) =>
    c.cmd === "docker" && ROOT_EXEC.every((a, i) => c.args[i] === a);
  const script = (c: Call) => c.args.at(-1) ?? "";

  function persistWith(handler: (c: Call) => Output) {
    const { run, calls } = fakeRunner(handler);
    const runtime = new OpencodeRuntime({
      containers: new Containers(run),
      clientFor: (ep) => new OpencodeClient(ep),
    });
    const lines: string[] = [];
    return {
      calls,
      lines,
      persist: () => runtime.persistState(project, "c1", (l) => lines.push(l)),
    };
  }

  it("says sessions die with a container that has no volume, and changes nothing", async () => {
    const { calls, lines, persist } = persistWith(() => ({
      stdout: "unmounted\n",
    }));
    await persist();
    expect(calls).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/no sessions volume/u);
  });

  it("gives a root-owned volume to the container user before linking", async () => {
    const { calls, lines, persist } = persistWith((c) => {
      if (script(c).includes('echo "owner')) {
        return { stdout: "owner 1000:1000\nreadonly\n" };
      }
      return script(c).includes("link data")
        ? { stdout: "data linked\nstate kept\n" }
        : {};
    });
    await persist();
    const chown = calls.find(isRoot)!;
    expect(chown.args).toContain("ODH_OWNER=1000:1000");
    expect(chown.args).toContain("c1");
    expect(script(chown)).toContain("chown -R");
    expect(calls.indexOf(chown)).toBeLessThan(
      calls.findIndex((c) => script(c).includes("link data"))
    );
    expect(lines).toStrictEqual([
      "opencode data: now on the opendevhub volume",
      "opencode state: on the opendevhub volume",
    ]);
  });

  it("skips the root step when the user can already write the volume", async () => {
    const { calls, persist } = persistWith((c) =>
      script(c).includes('echo "owner') ? { stdout: "owner 1000:1000\n" } : {}
    );
    await persist();
    expect(calls.some(isRoot)).toBeFalsy();
  });

  it("runs before opencode serve when given the container", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    await runtime.ensureRunning(project, { ...args(), containerId: "c1" });
    const probe = calls.findIndex((c) => script(c).includes('echo "owner'));
    const kill = calls.findIndex((c) => script(c).includes("pkill"));
    const launch = calls.findIndex((c) => script(c).includes(" serve "));
    expect(kill).toBeLessThan(probe);
    expect(probe).toBeLessThan(launch);
  });
});

describe("LINK_STATE", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "odh-link-"));
    await mkdir(path.join(dir, "home"));
    await mkdir(path.join(dir, "volume"));
    await writeFile(path.join(dir, "mountinfo"), "");
  });
  afterEach(() => rm(dir, { force: true, recursive: true }));

  const link = (mountinfo = "") => {
    writeFileSync(path.join(dir, "mountinfo"), mountinfo);
    return execFileSync("sh", ["-c", LINK_STATE], {
      encoding: "utf8",
      env: {
        HOME: path.join(dir, "home"),
        ODH_MOUNTINFO: path.join(dir, "mountinfo"),
        ODH_STATE: path.join(dir, "volume"),
        PATH: process.env.PATH,
      },
    });
  };
  const dataDir = () => path.join(dir, "home/.local/share/opencode");

  it("links fresh folders and keeps them on the next start", async () => {
    expect(link()).toBe("data linked\nstate linked\n");
    expect(await readlink(dataDir())).toBe(path.join(dir, "volume/data"));
    expect(link()).toBe("data kept\nstate kept\n");
  });

  it("moves a container's existing data onto an empty volume", async () => {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(path.join(dataDir(), "auth.json"), "{}");
    expect(link()).toMatch(/^data moved\ndata linked\n/u);
    expect(
      await readFile(path.join(dir, "volume/data/auth.json"), "utf8")
    ).toBe("{}");
  });

  it("prefers the volume's data and sets the container's own copy aside", async () => {
    await mkdir(path.join(dir, "volume/data"), { recursive: true });
    await writeFile(path.join(dir, "volume/data/opencode.db"), "old sessions");
    await mkdir(dataDir(), { recursive: true });
    await writeFile(path.join(dataDir(), "opencode.db"), "fresh");
    expect(link()).toMatch(/^data set-aside\ndata linked\n/u);
    expect(await readFile(path.join(dataDir(), "opencode.db"), "utf8")).toBe(
      "old sessions"
    );
    const aside = (await readdir(path.join(dir, "home/.local/share"))).find(
      (n) => n.startsWith("opencode.before-opendevhub.")
    );
    expect(aside).toBeDefined();
  });

  it("leaves a folder the devcontainer already mounts alone", async () => {
    await mkdir(dataDir(), { recursive: true });
    const home = path.join(dir, "home");
    expect(link(`1 0 0:1 / ${home} rw - ext4 /dev/sda rw\n`)).toBe(
      "data own-mount\nstate own-mount\n"
    );
    expect((await lstat(dataDir())).isSymbolicLink()).toBeFalsy();
  });
});
