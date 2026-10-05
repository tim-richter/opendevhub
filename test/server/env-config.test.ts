import { describe, expect, it } from "vitest";
import { buildOverrideConfig, envIdFor, isolationBlocker, resolveEnvSettings } from "../../src/server/env-config";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

describe("envIdFor", () => {
  it("is the project id, a branch slug and a short hash", () => {
    expect(envIdFor("demo-abc123", "/workspaces/demo.worktrees/feature-login", "feature/login")).toMatch(/^demo-abc123-feature-login-[0-9a-f]{4}$/);
  });
  it("differs per worktree and is stable", () => {
    const a = envIdFor("demo-abc123", "/w/demo.worktrees/a", "x");
    expect(envIdFor("demo-abc123", "/w/demo.worktrees/a", "x")).toBe(a);
    expect(envIdFor("demo-abc123", "/w/demo.worktrees/b", "x")).not.toBe(a);
  });
  it("fits a DNS label even for long names", () => {
    const id = envIdFor(`${"a".repeat(50)}-abc123`, "/w/x", "a-very-long-branch-name-that-goes-on");
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(LABEL);
  });
  it("names a branch with no usable characters 'worktree'", () => {
    expect(envIdFor("demo-abc123", "/w/x", "___")).toMatch(/^demo-abc123-worktree-[0-9a-f]{4}$/);
  });
});

describe("resolveEnvSettings", () => {
  it("defaults to shared with no key files and the ssh-agent forwarded", () => {
    expect(resolveEnvSettings(undefined, undefined)).toEqual({ isolation: "shared", keyFiles: [], sshAgent: true });
  });
  it("reads the devcontainer customization, and the config.json override wins", () => {
    expect(resolveEnvSettings({ isolation: "isolated", keyFiles: ["package-lock.json"] }, undefined)).toEqual({
      isolation: "isolated",
      keyFiles: ["package-lock.json"],
      sshAgent: true,
    });
    expect(resolveEnvSettings({ isolation: "isolated" }, { isolation: "shared" }).isolation).toBe("shared");
    expect(resolveEnvSettings({ keyFiles: ["a"] }, { keyFiles: ["b"] }).keyFiles).toEqual(["b"]);
  });
  it("turns the ssh-agent off from either place, config.json first", () => {
    expect(resolveEnvSettings({ sshAgent: false }, undefined).sshAgent).toBe(false);
    expect(resolveEnvSettings(undefined, { sshAgent: false }).sshAgent).toBe(false);
    expect(resolveEnvSettings({ sshAgent: false }, { sshAgent: true }).sshAgent).toBe(true);
    expect(resolveEnvSettings({ sshAgent: true }, { sshAgent: false }).sshAgent).toBe(false);
  });
  it("ignores invalid values and unsafe key files", () => {
    expect(resolveEnvSettings({ isolation: "yes", keyFiles: ["ok.lock", "/etc/passwd", "../x", "-x", 3, "a b"], sshAgent: "no" }, null)).toEqual({
      isolation: "shared",
      keyFiles: ["ok.lock"],
      sshAgent: true,
    });
  });
});

describe("isolationBlocker", () => {
  it.each([
    [{ dockerComposeFile: "compose.yml" }, /Docker Compose/],
    [{ appPort: 3000 }, /appPort/],
    [{ runArgs: ["-p", "3000:3000"] }, /publish host ports/],
    [{ runArgs: ["-p3000:3000"] }, /publish host ports/],
    [{ runArgs: ["--publish=3000:3000"] }, /publish host ports/],
    [{ runArgs: ["-P"] }, /publish host ports/],
    [{ runArgs: ["--network=host"] }, /host networking/],
    [{ runArgs: ["--net", "host"] }, /host networking/],
  ])("refuses %j", (config, reason) => {
    expect(isolationBlocker(config)).toMatch(reason);
  });
  it("accepts ordinary configs", () => {
    expect(isolationBlocker({ image: "node", runArgs: ["--privileged", "--cap-add=SYS_PTRACE"] })).toBeUndefined();
  });
  it("refuses lifecycle commands that use the workspace folder the CLI guessed", () => {
    expect(isolationBlocker({ postCreateCommand: "cd /workspaces/feat && npm ci" }, "/workspaces/feat")).toMatch(/containerWorkspaceFolder/);
    expect(isolationBlocker({ postCreateCommand: "cd /workspaces/feature && npm ci" }, "/workspaces/feat")).toBeUndefined();
  });
});

describe("buildOverrideConfig", () => {
  const base = {
    guessedFolder: "/workspaces/feat",
    image: "opendevhub/demo-abc123:0123456789ab-base",
    worktree: { hostPath: "/src/demo.worktrees/feat", path: "/workspaces/demo.worktrees/feat" },
    gitDir: { host: "/src/demo/.git", container: "/workspaces/demo/.git" },
  };

  it("pins the image and drops what the image already carries", () => {
    const { config } = buildOverrideConfig({
      ...base,
      config: {
        name: "demo",
        build: { dockerfile: "Dockerfile" },
        features: { "ghcr.io/x/y:1": {} },
        initializeCommand: "echo host",
        onCreateCommand: "a",
        updateContentCommand: "b",
        postCreateCommand: "c",
        postStartCommand: "d",
        postAttachCommand: "e",
        forwardPorts: [3000],
        configFilePath: { fsPath: "/x" },
      },
    });
    expect(config).toEqual({
      name: "demo",
      initializeCommand: "echo host",
      forwardPorts: [3000],
      image: base.image,
      workspaceMount: "type=bind,source=/src/demo.worktrees/feat,target=/workspaces/demo.worktrees/feat",
      workspaceFolder: "/workspaces/demo.worktrees/feat",
      mounts: ["type=bind,source=/src/demo/.git,target=/workspaces/demo/.git"],
    });
  });

  it("keeps the original mounts and adds .git", () => {
    const { config } = buildOverrideConfig({ ...base, config: { image: "node", mounts: ["type=volume,source=c,target=/cache"] } });
    expect(config.mounts).toEqual(["type=volume,source=c,target=/cache", "type=bind,source=/src/demo/.git,target=/workspaces/demo/.git"]);
  });

  it("removes --name from runArgs and says so", () => {
    const { config, notes } = buildOverrideConfig({ ...base, config: { image: "node", runArgs: ["--name", "demo", "--init", "--name=x"] } });
    expect(config.runArgs).toEqual(["--init"]);
    expect(notes).toEqual(["removed --name from runArgs: every task container needs its own name"]);
  });

  it("points paths the CLI guessed at the worktree", () => {
    const { config } = buildOverrideConfig({
      ...base,
      config: { image: "node", containerEnv: { BIN: "/workspaces/feat/bin", OTHER: "/workspaces/feature", ROOT: "/workspaces/feat" } },
    });
    expect(config.containerEnv).toEqual({ BIN: "/workspaces/demo.worktrees/feat/bin", OTHER: "/workspaces/feature", ROOT: "/workspaces/demo.worktrees/feat" });
  });
});
