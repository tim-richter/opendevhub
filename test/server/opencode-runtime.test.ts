import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Containers } from "../../src/server/containers";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime, parseBinaryPath, parseOpencodeVersion } from "../../src/server/opencode/runtime";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";
import { type FakeOpencode, startFakeOpencode } from "../helpers/fake-opencode";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/.devcontainer.json" };
let fake: FakeOpencode;
beforeEach(async () => {
  fake = await startFakeOpencode("pw");
});
afterEach(() => fake.close());

type Output = { exitCode?: number; stdout?: string };
const BIN = "/home/node/.opencode/bin/opencode";
const isResolve = (c: Call) => c.args.at(-1)?.includes("command -v opencode") ?? false;

function runtimeWith(versionOutput: Output, resolveOutput: Output = { stdout: `${BIN}\n` }) {
  const { run, calls } = fakeRunner((c: Call) =>
    isResolve(c) ? resolveOutput : c.args.includes("--version") ? versionOutput : {},
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
const args = { ip: "127.0.0.1", workspaceFolder: "/workspaces/demo", onLine: () => {} };

describe("parseOpencodeVersion", () => {
  it.each([
    ["opencode v2.0.20", "2.0.20"],
    ["1.18.31\n", "1.18.31"],
    ["garbage", undefined],
  ])("%s -> %s", (input, expected) => expect(parseOpencodeVersion(input)).toBe(expected));
});

describe("parseBinaryPath", () => {
  it.each([
    [`${BIN}\n`, BIN],
    ["Welcome to zsh!\n[oh-my-zsh] update available\n/usr/local/bin/opencode\n", "/usr/local/bin/opencode"],
    ["opencode: aliased to foo\n", undefined],
    ["", undefined],
  ])("%j -> %s", (input, expected) => expect(parseBinaryPath(input)).toBe(expected));
});

describe("OpencodeRuntime.ensureRunning", () => {
  it("searches PATH, the installer dirs and bash/zsh login shells for the binary", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    await runtime.ensureRunning(project, args);
    const script = calls.find(isResolve)?.args.at(-1) ?? "";
    for (const needle of ["command -v opencode", "$HOME/.opencode/bin/opencode", "$HOME/.local/bin/opencode", "$HOME/.bun/bin/opencode", "-lic", "-ic"]) {
      expect(script).toContain(needle);
    }
    expect(script).toMatch(/for sh in bash zsh/);
  });

  it("uses the resolved absolute path for --version and serve", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    await runtime.ensureRunning(project, args);
    expect(calls.find((c) => c.args.at(-1) === "--version")?.args.slice(-2)).toEqual([BIN, "--version"]);
    const launch = calls.find((c) => c.args.at(-1)?.includes("serve --hostname 0.0.0.0"));
    expect(launch?.args.at(-1)).toContain(`nohup '${BIN}' serve`);
  });

  it("accepts a binary found only via a noisy zsh login shell", async () => {
    const { runtime, calls } = runtimeWith(
      { stdout: "opencode v2.0.20" },
      { stdout: "[oh-my-zsh] Would you like to update? [Y/n]\n/opt/tools/opencode\n" },
    );
    await runtime.ensureRunning(project, args);
    expect(calls.find((c) => c.args.at(-1) === "--version")?.args.at(-2)).toBe("/opt/tools/opencode");
  });

  it("launches opencode serve with the generated password and waits for health", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20\n" });
    const res = await runtime.ensureRunning(project, args);
    expect(res).toEqual({ password: "pw", version: "2.0.20" });
    const launch = calls.find((c) => c.args.at(-1)?.includes("serve --hostname 0.0.0.0"));
    expect(launch?.args).toEqual(expect.arrayContaining(["--remote-env", "OPENCODE_PASSWORD=pw", "sh", "-c"]));
    expect(launch?.args.at(-1)).toContain(`--port ${fake.port}`);
    expect(launch?.args.at(-1)).toContain("cd '/workspaces/demo'");
    expect(calls.some((c) => c.args.at(-1)?.includes("pkill -f 'opencode [s]erve'"))).toBe(true);
  });

  it("is idempotent when the server already answers with the given password", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    const res = await runtime.ensureRunning(project, { ...args, password: "pw" });
    expect(res).toEqual({ password: "pw", version: "2.0.20" });
    expect(calls).toHaveLength(0);
  });

  it("fails clearly, listing the searched locations, when opencode is not found", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" }, { exitCode: 1, stdout: "" });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(
      /opencode v2 not found in the devcontainer.*PATH.*~\/\.opencode\/bin.*bash\/zsh/,
    );
    expect(calls.some((c) => c.args.at(-1) === "--version")).toBe(false);
  });

  it("fails clearly when the found binary cannot report its version", async () => {
    const { runtime } = runtimeWith({ exitCode: 126, stdout: "" });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(`failed to run ${BIN} --version`);
  });

  it("rejects opencode v1", async () => {
    const { runtime } = runtimeWith({ stdout: "1.18.31" });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(/requires opencode v2/);
  });

  it("times out when the server never becomes healthy", async () => {
    const { run } = fakeRunner((c) =>
      isResolve(c) ? { stdout: BIN } : c.args.includes("--version") ? { stdout: "2.0.20" } : {},
    );
    const runtime = new OpencodeRuntime({
      containers: new Containers(run),
      clientFor: (ep) => new OpencodeClient(ep),
      port: fake.port,
      healthTimeoutMs: 200,
      healthIntervalMs: 20,
      generatePassword: () => "wrong-password",
    });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(/did not become healthy/);
  });
});
