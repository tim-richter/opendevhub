import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Containers } from "../../src/server/containers";
import {
  Credentials,
  IDENTITY_SCRIPT,
  KNOWN_HOSTS_SCRIPT,
  SSH_COMMAND_OFF,
  SSH_COMMAND_ON,
  sshHosts,
} from "../../src/server/credentials";
import { AGENT_SOCKET, AGENT_SSH_COMMAND } from "../../src/server/relay/agent";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/.devcontainer.json" };

describe("sshHosts", () => {
  it("names ssh remotes as known_hosts does and skips the rest", () => {
    const remotes = [
      "origin\tgit@github.com:a/b.git (fetch)",
      "origin\tgit@github.com:a/b.git (push)",
      "fork\tssh://git@git.example.com:2222/a/b.git (fetch)",
      "std\tssh://git@codeberg.org:22/a/b.git (fetch)",
      "plus\tgit+ssh://gitlab.com/a/b (fetch)",
      "web\thttps://github.com/a/b.git (fetch)",
      "local\t/srv/repos/b.git (fetch)",
      "rel\t../b (fetch)",
      "alias\twork:team/app.git (fetch)",
    ].join("\n");
    expect(sshHosts(remotes)).toEqual(["github.com", "[git.example.com]:2222", "codeberg.org", "gitlab.com", "work"]);
  });
});

/** Runs a container script with real sh and git against a throwaway HOME. */
function sh(script: string, home: string, env: Record<string, string>) {
  return spawnSync("sh", ["-c", script], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", ...env },
    encoding: "utf8",
  });
}
const git = (home: string, ...args: string[]) =>
  spawnSync("git", args, { env: { HOME: home, PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" }).stdout.trim();
const hasSshKeygen = spawnSync("sh", ["-c", "command -v ssh-keygen"]).status === 0;

describe("container scripts (real sh and git)", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "odh-home-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("sets the identity verbatim when the container has none", () => {
    const r = sh(IDENTITY_SCRIPT, home, { ODH_GIT_NAME: "Tim O'Brien Zoë", ODH_GIT_EMAIL: "t@example.com" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("set");
    expect(git(home, "config", "--global", "user.name")).toBe("Tim O'Brien Zoë");
    expect(git(home, "config", "--global", "user.email")).toBe("t@example.com");
  });

  it("only fills in what is missing", () => {
    git(home, "config", "--global", "user.name", "Container Name");
    sh(IDENTITY_SCRIPT, home, { ODH_GIT_NAME: "Host Name", ODH_GIT_EMAIL: "h@example.com" });
    expect(git(home, "config", "--global", "user.name")).toBe("Container Name");
    expect(git(home, "config", "--global", "user.email")).toBe("h@example.com");
  });

  it("reports nothing to do when both are set", () => {
    git(home, "config", "--global", "user.name", "A");
    git(home, "config", "--global", "user.email", "a@example.com");
    expect(sh(IDENTITY_SCRIPT, home, { ODH_GIT_NAME: "B", ODH_GIT_EMAIL: "b@example.com" }).stdout).not.toContain("set");
  });

  it("sets core.sshCommand only when unset, and removes only its own", () => {
    const env = { ODH_SSH_COMMAND: AGENT_SSH_COMMAND, ODH_AGENT_SOCK: AGENT_SOCKET };
    sh(SSH_COMMAND_ON, home, env);
    expect(git(home, "config", "--global", "core.sshCommand")).toBe(AGENT_SSH_COMMAND);
    sh(SSH_COMMAND_OFF, home, env);
    expect(git(home, "config", "--global", "core.sshCommand")).toBe("");

    git(home, "config", "--global", "core.sshCommand", "ssh -i ~/.ssh/deploy");
    expect(sh(SSH_COMMAND_ON, home, env).stdout).toContain("kept");
    expect(sh(SSH_COMMAND_OFF, home, env).status).toBe(0);
    expect(git(home, "config", "--global", "core.sshCommand")).toBe("ssh -i ~/.ssh/deploy");
  });

  it("treats any core.sshCommand naming opendevhub's socket as its own: replaced when on, removed when off", () => {
    const env = { ODH_SSH_COMMAND: AGENT_SSH_COMMAND, ODH_AGENT_SOCK: AGENT_SOCKET };
    const older = `ssh -o IdentityAgent=${AGENT_SOCKET}`;
    git(home, "config", "--global", "core.sshCommand", older);
    expect(sh(SSH_COMMAND_ON, home, env).stdout).not.toContain("kept");
    expect(git(home, "config", "--global", "core.sshCommand")).toBe(AGENT_SSH_COMMAND);
    git(home, "config", "--global", "core.sshCommand", older);
    sh(SSH_COMMAND_OFF, home, env);
    expect(git(home, "config", "--global", "core.sshCommand")).toBe("");
  });

  it.skipIf(!hasSshKeygen)("adds known_hosts lines once, creating ~/.ssh with mode 700", () => {
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(home, "hostkey")]);
    const key = fs.readFileSync(path.join(home, "hostkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
    const line = `example.org ${key}`;
    const env = { ODH_HOST: "example.org", ODH_LINES: line };
    expect(sh(KNOWN_HOSTS_SCRIPT, home, env).stdout).toContain("added");
    expect(fs.statSync(path.join(home, ".ssh")).mode & 0o777).toBe(0o700);
    expect(sh(KNOWN_HOSTS_SCRIPT, home, env).stdout).not.toContain("added");
    expect(fs.readFileSync(path.join(home, ".ssh/known_hosts"), "utf8")).toBe(`${line}\n`);
  });
});

const hasSshAgent = spawnSync("sh", ["-c", "command -v ssh-agent && command -v ssh-add"]).status === 0;

describe.skipIf(!hasSshAgent)("git's ssh command (real sh and ssh-add)", () => {
  let dir: string;
  let agent: ReturnType<typeof spawn> | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-sshcmd-"));
    // A stand-in ssh that reports which agent it would use.
    fs.writeFileSync(path.join(dir, "ssh"), '#!/bin/sh\necho "agent=$SSH_AUTH_SOCK args=$*"\n', { mode: 0o755 });
  });
  afterEach(() => {
    agent?.kill();
    agent = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the command the way git runs core.sshCommand: through sh, with the ssh arguments appended. */
  function viaGit(sock: string) {
    const command = AGENT_SSH_COMMAND.replaceAll(AGENT_SOCKET, sock);
    return spawnSync("sh", ["-c", `${command} "$@"`, command, "git@example.org", "git-upload-pack 'a/b.git'"], {
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, SSH_AUTH_SOCK: "/run/vscode-agent.sock" },
      encoding: "utf8",
    }).stdout.trim();
  }

  it("uses the forwarded agent while it answers", async () => {
    const sock = path.join(dir, "agent.sock");
    agent = spawn("ssh-agent", ["-D", "-a", sock], { stdio: "ignore" });
    await vi.waitFor(() => expect(fs.existsSync(sock)).toBe(true));
    expect(viaGit(sock)).toBe(`agent=${sock} args=git@example.org git-upload-pack 'a/b.git'`);
  });

  it("falls back to the shell's own agent when opendevhub isn't forwarding (no socket, or a stale one)", () => {
    expect(viaGit(path.join(dir, "missing.sock"))).toBe("agent=/run/vscode-agent.sock args=git@example.org git-upload-pack 'a/b.git'");
    const stale = path.join(dir, "stale.sock");
    const server = net.createServer().listen(stale);
    server.close();
    expect(viaGit(stale)).toBe("agent=/run/vscode-agent.sock args=git@example.org git-upload-pack 'a/b.git'");
  });
});

describe("Credentials.prepare", () => {
  const remotes = "origin\tgit@github.com:a/b.git (fetch)\nfork\tssh://git@git.example.com:2222/a/b.git (fetch)\n";

  function setup(host: { name?: string; email?: string; known?: Record<string, string> } = {}, container: (c: Call) => { exitCode?: number; stdout?: string } = () => ({})) {
    const { run, calls } = fakeRunner((c) => {
      if (c.cmd === "git" && c.args.includes("user.name")) return host.name ? { stdout: `${host.name}\n` } : { exitCode: 1 };
      if (c.cmd === "git" && c.args.includes("user.email")) return host.email ? { stdout: `${host.email}\n` } : { exitCode: 1 };
      if (c.cmd === "git" && c.args.includes("remote")) return { stdout: remotes };
      if (c.cmd === "ssh-keygen") {
        const line = host.known?.[c.args[1]];
        return line ? { stdout: `# Host ${c.args[1]} found: line 3\n${line}\n` } : { exitCode: 1 };
      }
      if (c.cmd === "devcontainer") return container(c);
      return {};
    });
    const lines: string[] = [];
    const credentials = new Credentials({ run, containers: new Containers(run), knownHostsFile: "/home/me/.ssh/known_hosts" });
    const prepare = (sshAgent = true) => credentials.prepare(project, project.path, { sshAgent, onLine: (l) => lines.push(l) });
    const execs = () => calls.filter((c) => c.cmd === "devcontainer");
    const envOf = (c: Call) => c.args.filter((_, i) => c.args[i - 1] === "--remote-env");
    return { prepare, calls, lines, execs, envOf };
  }

  it("reads the identity in the project folder and passes it through the environment", async () => {
    const s = setup({ name: "Tim Richter", email: "tim@example.com" }, (c) => (c.args.at(-1) === IDENTITY_SCRIPT ? { stdout: "set\n" } : {}));
    await s.prepare();
    expect(s.calls.find((c) => c.args.includes("user.name"))?.args).toEqual(["-C", "/src/demo", "config", "--get", "user.name"]);
    const identity = s.execs().find((c) => c.args.at(-1) === IDENTITY_SCRIPT)!;
    expect(s.envOf(identity)).toEqual(["ODH_GIT_NAME=Tim Richter", "ODH_GIT_EMAIL=tim@example.com"]);
    expect(identity.args.at(-1)).not.toContain("Tim");
    expect(s.lines).toContain("git: identity set (Tim Richter <tim@example.com>)");
  });

  it("says so when this machine has no identity, and touches nothing", async () => {
    const s = setup();
    await s.prepare();
    expect(s.lines).toContain("git: no user.name/user.email on this machine; commits in the container will fail");
    expect(s.execs().some((c) => c.args.at(-1) === IDENTITY_SCRIPT)).toBe(false);
  });

  it("reports a container without git", async () => {
    const s = setup({ name: "T", email: "t@e" }, (c) => (c.args.at(-1) === IDENTITY_SCRIPT ? { stdout: "no-git\n" } : {}));
    await s.prepare();
    expect(s.lines).toContain("git: not found in the container");
  });

  it("copies known_hosts lines for ssh remotes the host knows, looking up ports as [host]:port", async () => {
    const s = setup(
      { known: { "github.com": "github.com ssh-ed25519 AAAA1", "[git.example.com]:2222": "[git.example.com]:2222 ssh-ed25519 AAAA2" } },
      (c) => (c.args.at(-1) === KNOWN_HOSTS_SCRIPT ? { stdout: "added\n" } : {}),
    );
    await s.prepare();
    expect(s.calls.filter((c) => c.cmd === "ssh-keygen").map((c) => c.args)).toEqual([
      ["-F", "github.com", "-f", "/home/me/.ssh/known_hosts"],
      ["-F", "[git.example.com]:2222", "-f", "/home/me/.ssh/known_hosts"],
    ]);
    const known = s.execs().filter((c) => c.args.at(-1) === KNOWN_HOSTS_SCRIPT).map(s.envOf);
    expect(known).toEqual([
      ["ODH_HOST=github.com", "ODH_LINES=github.com ssh-ed25519 AAAA1"],
      ["ODH_HOST=[git.example.com]:2222", "ODH_LINES=[git.example.com]:2222 ssh-ed25519 AAAA2"],
    ]);
    expect(s.lines).toContain("ssh: added known_hosts for github.com, [git.example.com]:2222");
  });

  it("hints at verifying a host this machine doesn't know", async () => {
    const s = setup({ known: { "github.com": "github.com ssh-ed25519 AAAA1" } });
    await s.prepare();
    expect(s.lines).toContain('ssh: git.example.com (port 2222) is not in known_hosts on this machine; run "ssh -p 2222 git.example.com" once to verify it');
  });

  it("sets or removes git's ssh command with the agent setting", async () => {
    const on = setup();
    await on.prepare(true);
    expect(on.execs().find((c) => c.args.at(-1) === SSH_COMMAND_ON)).toBeDefined();
    expect(on.envOf(on.execs().find((c) => c.args.at(-1) === SSH_COMMAND_ON)!)).toEqual([`ODH_SSH_COMMAND=${AGENT_SSH_COMMAND}`, `ODH_AGENT_SOCK=${AGENT_SOCKET}`]);
    const off = setup();
    await off.prepare(false);
    expect(off.execs().find((c) => c.args.at(-1) === SSH_COMMAND_OFF)).toBeDefined();
    expect(off.execs().some((c) => c.args.at(-1) === SSH_COMMAND_ON)).toBe(false);
  });

  it("logs a project's own core.sshCommand", async () => {
    const s = setup({}, (c) => (c.args.at(-1) === SSH_COMMAND_ON ? { stdout: "kept\n" } : {}));
    await s.prepare();
    expect(s.lines).toContain("git: the container sets its own core.sshCommand; leaving it as is");
  });

  it("never throws: a failing step is logged and the next one still runs", async () => {
    const s = setup({ name: "T", email: "t@e" }, (c) => (c.args.at(-1) === IDENTITY_SCRIPT ? { exitCode: 1, stdout: "boom" } : {}));
    await expect(s.prepare()).resolves.toBeUndefined();
    expect(s.lines.some((l) => l.startsWith("credentials: could not set the git identity"))).toBe(true);
    expect(s.execs().some((c) => c.args.at(-1) === SSH_COMMAND_ON)).toBe(true);
  });
});
