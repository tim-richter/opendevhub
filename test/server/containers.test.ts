import { describe, expect, it } from "vitest";
import { CommandError, Containers, LABEL, parseUpOutput } from "../../src/server/containers";
import type { Project } from "../../src/shared/types";
import { fakeRunner } from "../helpers/fake-runner";

const project: Project = {
  id: "demo-1a2b3c",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};
const okUp =
  "[2026-09-30T10:00:00Z] Start: Run: docker build\n" +
  '{"outcome":"success","containerId":"abc123","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/demo"}\n';
const inspectJson = JSON.stringify({
  Id: "abc123",
  Name: "/eager_demo",
  State: { Running: true },
  Mounts: [
    { Type: "bind", Source: "/src/demo", Destination: "/workspaces/demo" },
    { Type: "bind", Source: "/src/demo.worktrees", Destination: "/workspaces/demo.worktrees" },
    { Type: "volume", Source: "/var/lib/docker/volumes/x", Destination: "/vscode" },
  ],
  Config: { Labels: { [LABEL]: "demo-1a2b3c" } },
  NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
});

describe("parseUpOutput", () => {
  const base = { exitCode: 0, stderr: "", timedOut: false };
  it("parses the success line", () => {
    expect(parseUpOutput({ ...base, stdout: okUp }, "/fallback")).toEqual({
      containerId: "abc123",
      remoteWorkspaceFolder: "/workspaces/demo",
      remoteUser: "node",
    });
  });
  it("throws the devcontainer error message with stderr tail", () => {
    const stdout = '{"outcome":"error","message":"Command failed: docker build","description":"An error occurred"}';
    try {
      parseUpOutput({ ...base, exitCode: 1, stdout, stderr: "step 1\nboom" }, "/f");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      expect((err as Error).message).toMatch(/Command failed: docker build/);
      expect((err as CommandError).tail).toEqual(["step 1", "boom"]);
    }
  });
  it("reports timeouts", () => {
    expect(() => parseUpOutput({ ...base, exitCode: 1, stdout: "", timedOut: true }, "/f")).toThrow(/timed out/);
  });
  it("reports missing result JSON with exit code", () => {
    expect(() => parseUpOutput({ ...base, exitCode: 1, stdout: "noise only", stderr: "x" }, "/f")).toThrow(
      /exited with code 1/,
    );
  });
  it("falls back when remoteWorkspaceFolder is absent", () => {
    const stdout = '{"outcome":"success","containerId":"c"}';
    expect(parseUpOutput({ ...base, stdout }, "/workspaces/demo").remoteWorkspaceFolder).toBe("/workspaces/demo");
  });
});

describe("Containers", () => {
  it("up passes workspace folder and id label, streams lines", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    const lines: string[] = [];
    const res = await new Containers(run).up(project, { rebuild: false, onLine: (l) => lines.push(l) });
    expect(res.containerId).toBe("abc123");
    expect(calls[0].cmd).toBe("devcontainer");
    expect(calls[0].args).toEqual(["up", "--workspace-folder", "/src/demo", "--id-label", `${LABEL}=demo-1a2b3c`]);
    calls[0].opts?.onLine?.("hello");
    expect(lines).toEqual(["hello"]);
  });

  it("up with rebuild removes the existing container", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    await new Containers(run).up(project, { rebuild: true, onLine: () => {} });
    expect(calls[0].args).toContain("--remove-existing-container");
  });

  it("inspect parses state, ip and label; undefined on failure", async () => {
    const ok = fakeRunner(() => ({ stdout: inspectJson + "\n" }));
    expect(await new Containers(ok.run).inspect("abc123")).toEqual({
      id: "abc123",
      name: "eager_demo",
      running: true,
      ip: "172.17.0.5",
      projectId: "demo-1a2b3c",
      binds: { "/workspaces/demo": "/src/demo", "/workspaces/demo.worktrees": "/src/demo.worktrees" },
    });
    const missing = fakeRunner(() => ({ exitCode: 1, stderr: "No such container" }));
    expect(await new Containers(missing.run).inspect("nope")).toBeUndefined();
  });

  it("listManaged filters by label and inspects each id", async () => {
    const { run, calls } = fakeRunner((c) => (c.args[0] === "ps" ? { stdout: "abc123\n" } : { stdout: inspectJson }));
    const list = await new Containers(run).listManaged();
    expect(calls[0].args).toEqual(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.ID}}"]);
    expect(list.map((c) => c.id)).toEqual(["abc123"]);
  });

  it("stop throws CommandError on failure", async () => {
    const { run } = fakeRunner(() => ({ exitCode: 1, stderr: "daemon down" }));
    await expect(new Containers(run).stop("abc")).rejects.toBeInstanceOf(CommandError);
  });

  it("exec forwards env as --remote-env before the command", async () => {
    const { run, calls } = fakeRunner();
    await new Containers(run).exec(project, ["opencode", "--version"], { env: { A: "1" } });
    expect(calls[0].args).toEqual([
      "exec",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
      "--remote-env",
      "A=1",
      "opencode",
      "--version",
    ]);
    expect(calls[0].opts?.timeoutMs).toBe(30_000);
  });
});

describe("Containers mounts and workspace folder", () => {
  it("up adds each extra mount", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    await new Containers(run).up(project, { rebuild: true, onLine: () => {}, mounts: ["type=bind,source=/a,target=/b"] });
    expect(calls[0].args.slice(-3)).toEqual(["--remove-existing-container", "--mount", "type=bind,source=/a,target=/b"]);
  });

  it("reads the planned workspace folder from read-configuration", async () => {
    const stdout = JSON.stringify({ configuration: {}, workspace: { workspaceFolder: "/workspaces/demo" } });
    const { run, calls } = fakeRunner(() => ({ stdout }));
    expect(await new Containers(run).workspaceFolder(project)).toBe("/workspaces/demo");
    expect(calls[0].args).not.toContain("--include-merged-configuration");
    expect(await new Containers(fakeRunner(() => ({ exitCode: 1 })).run).workspaceFolder(project)).toBeUndefined();
    expect(await new Containers(fakeRunner(() => ({ stdout: "not json" })).run).workspaceFolder(project)).toBeUndefined();
  });
});

describe("Containers.readConfiguration", () => {
  it("runs read-configuration with the id label and merged config, preferring mergedConfiguration", async () => {
    const stdout = JSON.stringify({
      configuration: { forwardPorts: [1] },
      mergedConfiguration: { forwardPorts: [3000, "db:5432"], portsAttributes: { "3000": { label: "web" } } },
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
    expect(cfg).toEqual({ forwardPorts: [3000, "db:5432"], portsAttributes: { "3000": { label: "web" } } });
  });

  it("falls back to configuration and defaults missing fields", async () => {
    const { run } = fakeRunner(() => ({ stdout: JSON.stringify({ configuration: { forwardPorts: [8080] } }) }));
    expect(await new Containers(run).readConfiguration(project)).toEqual({ forwardPorts: [8080], portsAttributes: {} });
    const empty = fakeRunner(() => ({ stdout: "{}" }));
    expect(await new Containers(empty.run).readConfiguration(project)).toEqual({ forwardPorts: [], portsAttributes: {} });
  });

  it("throws CommandError on failure or invalid output", async () => {
    const failed = fakeRunner(() => ({ exitCode: 1, stderr: "Dev container config not found" }));
    await expect(new Containers(failed.run).readConfiguration(project)).rejects.toBeInstanceOf(CommandError);
    const garbage = fakeRunner(() => ({ stdout: "not json" }));
    await expect(new Containers(garbage.run).readConfiguration(project)).rejects.toThrow(/invalid JSON/);
  });
});
