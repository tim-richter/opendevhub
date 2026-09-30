import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Containers } from "../../src/server/containers";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime, parseOpencodeVersion } from "../../src/server/opencode/runtime";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";
import { type FakeOpencode, startFakeOpencode } from "../helpers/fake-opencode";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/.devcontainer.json" };
let fake: FakeOpencode;
beforeEach(async () => {
  fake = await startFakeOpencode("pw");
});
afterEach(() => fake.close());

function runtimeWith(versionOutput: { exitCode?: number; stdout?: string }) {
  const { run, calls } = fakeRunner((c: Call) => (c.args.includes("--version") ? versionOutput : {}));
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

describe("OpencodeRuntime.ensureRunning", () => {
  it("launches opencode serve with the generated password and waits for health", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20\n" });
    const res = await runtime.ensureRunning(project, args);
    expect(res).toEqual({ password: "pw", version: "2.0.20" });
    const launch = calls.find((c) => c.args.at(-1)?.includes("opencode serve --hostname 0.0.0.0"));
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

  it("fails clearly when opencode is missing", async () => {
    const { runtime } = runtimeWith({ exitCode: 127, stdout: "" });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(/not installed/);
  });

  it("rejects opencode v1", async () => {
    const { runtime } = runtimeWith({ stdout: "1.18.31" });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(/requires opencode v2/);
  });

  it("times out when the server never becomes healthy", async () => {
    const { run } = fakeRunner((c) => (c.args.includes("--version") ? { stdout: "2.0.20" } : {}));
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
