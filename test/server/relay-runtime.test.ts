import { describe, expect, it, vi } from "vitest";
import { Containers } from "../../src/server/containers";
import { RELAY_PORT, RelayRuntime, generateRelayToken } from "../../src/server/relay/runtime";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/x" };
const args = { ip: "172.17.0.9", token: "tok", binary: "/home/node/.opencode/bin/opencode" };
const script = (c: Call) => c.args.at(-1) ?? "";
const isLaunch = (c: Call) => script(c).includes("odh-relay") && script(c).includes("nohup");

function setup(opts: { hasNode?: boolean; readyAfterLaunch?: number[]; alreadyUp?: boolean } = {}) {
  let launches = 0;
  const { run, calls } = fakeRunner((c) => {
    if (isLaunch(c)) launches += 1;
    if (script(c) === "command -v node >/dev/null 2>&1") return { exitCode: opts.hasNode ? 0 : 1 };
    if (script(c).startsWith("tail -n 1")) return { stdout: "odh-relay: listen EADDRINUSE 0.0.0.0:4097\n" };
    return {};
  });
  const ping = vi.fn(async () => (opts.alreadyUp ? true : (opts.readyAfterLaunch ?? [1]).includes(launches)));
  const relay = new RelayRuntime({ containers: new Containers(run), ping, readyTimeoutMs: 100, readyIntervalMs: 10 });
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
    expect(await relay.ensureRunning(project, args)).toEqual({ status: "active", via: "existing" });
    expect(calls).toHaveLength(0);
    expect(ping).toHaveBeenCalledWith({ host: "172.17.0.9", port: RELAY_PORT, token: "tok" });
  });

  it("kills stale relays, then launches via opencode's Bun mode with token and port in the env", async () => {
    const { relay, calls } = setup({ readyAfterLaunch: [1] });
    expect(await relay.ensureRunning(project, args)).toEqual({ status: "active", via: "bun" });
    expect(script(calls[0])).toBe("pkill -f 'odh-[r]elay' || true");
    const launch = calls.find(isLaunch)!;
    expect(script(launch)).toContain("nohup env BUN_BE_BUN=1 '/home/node/.opencode/bin/opencode' -e '/*odh-relay*/");
    expect(script(launch)).toContain("> /tmp/opendevhub-relay.log 2>&1 &");
    expect(launch.args).toEqual(
      expect.arrayContaining(["--remote-env", "ODH_RELAY_TOKEN=tok", "--remote-env", `ODH_RELAY_PORT=${RELAY_PORT}`]),
    );
  });

  it("falls back to node when the Bun mode does not come up", async () => {
    const { relay, calls } = setup({ hasNode: true, readyAfterLaunch: [2] });
    expect(await relay.ensureRunning(project, args)).toEqual({ status: "active", via: "node" });
    expect(script(calls.filter(isLaunch)[1])).toContain("nohup env node -e '/*odh-relay*/");
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
    expect(await relay.ensureRunning(project, { ip: "172.17.0.9", token: "tok" })).toEqual({
      status: "unavailable",
      reason: "no relay runtime: opencode Bun mode unavailable and node not found",
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
