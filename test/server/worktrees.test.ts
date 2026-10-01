import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CommandError } from "../../src/server/containers";
import type { RunResult } from "../../src/server/exec";
import {
  InvalidRequestError,
  Worktrees,
  mountArg,
  parseGitVersion,
  parseWorktreeList,
  supportsRelativePaths,
  validateBranch,
  worktreeDirName,
  worktreeRoot,
} from "../../src/server/worktrees";
import type { Project } from "../../src/shared/types";
import { fakeRunner } from "../helpers/fake-runner";

const project: Project = { id: "demo-1", name: "demo", path: "/src/demo", devcontainerPath: "/x" };
const root = worktreeRoot("/src/demo", "/workspaces/demo", true);

describe("worktreeRoot", () => {
  it("puts the worktrees folder next to the checkout on both sides", () => {
    expect(worktreeRoot("/home/me/code/demo", "/workspaces/demo/", false)).toEqual({
      host: "/home/me/code/demo.worktrees",
      container: "/workspaces/demo.worktrees",
      mounted: false,
    });
    expect(mountArg(root)).toBe("type=bind,source=/src/demo.worktrees,target=/workspaces/demo.worktrees");
  });
});

describe("git versions", () => {
  it("parses and compares against 2.48", () => {
    expect(parseGitVersion("git version 2.48.1\n")).toEqual([2, 48]);
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual([2, 39]);
    expect(parseGitVersion("nope")).toBeUndefined();
    expect(supportsRelativePaths([2, 48])).toBe(true);
    expect(supportsRelativePaths([3, 0])).toBe(true);
    expect(supportsRelativePaths([2, 47])).toBe(false);
    expect(supportsRelativePaths(undefined)).toBe(false);
  });
});

describe("validateBranch", () => {
  it.each(["feature/login", "fix-1", "a.b_c", "user/x/y"])("accepts %s", (name) => {
    expect(validateBranch(` ${name} `)).toBe(name);
  });
  it.each(["", "-x", "a..b", "a b", "a/", "a//b", "x.lock", "a/.b", "a.", "$(rm)", "a;b"])("rejects %j", (name) => {
    expect(() => validateBranch(name)).toThrow(InvalidRequestError);
  });
  it("flattens slashes into the folder name", () => {
    expect(worktreeDirName("feature/login")).toBe("feature-login");
  });
});

describe("parseWorktreeList", () => {
  const porcelain = [
    "worktree /workspaces/demo\nHEAD aaa\nbranch refs/heads/main\n",
    "worktree /workspaces/demo.worktrees/feature-x\nHEAD bbb\nbranch refs/heads/feature/x\n",
    "worktree /home/node/.local/share/opencode/worktree/p1/y\nHEAD ccc\ndetached\n",
    "worktree /workspaces/demo.worktrees/../escape\nHEAD ddd\nbranch refs/heads/z\n",
    "",
  ].join("\n");

  it("drops the main checkout and maps mounted worktrees to the host", () => {
    expect(parseWorktreeList(porcelain, root)).toEqual([
      { path: "/workspaces/demo.worktrees/feature-x", hostPath: "/src/demo.worktrees/feature-x", branch: "feature/x", head: "bbb" },
      { path: "/home/node/.local/share/opencode/worktree/p1/y", head: "ccc" },
      { path: "/workspaces/demo.worktrees/../escape", branch: "z", head: "ddd" },
    ]);
  });

  it("drops prunable worktrees", () => {
    const stale = [
      "worktree /workspaces/demo\nHEAD aaa\nbranch refs/heads/main\n",
      "worktree /home/me/demo.worktrees/gone\nHEAD eee\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n",
      "worktree /workspaces/demo.worktrees/old\nHEAD fff\nbranch refs/heads/old\nprunable\n",
      "",
    ].join("\n");
    expect(parseWorktreeList(stale, root)).toEqual([]);
  });

  it("has no host paths when the folder isn't mounted", () => {
    expect(parseWorktreeList(porcelain, { ...root, mounted: false }).every((w) => !w.hostPath)).toBe(true);
  });

  it("parses real git output", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-wt-"));
    const repo = path.join(tmp, "demo");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    try {
      fs.mkdirSync(repo);
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "init");
      git("worktree", "add", "-q", "-b", "feature/x", path.join(tmp, "demo.worktrees", "feature-x"));
      const list = parseWorktreeList(git("worktree", "list", "--porcelain"), worktreeRoot(repo, repo, true));
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ branch: "feature/x", hostPath: path.join(tmp, "demo.worktrees", "feature-x") });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** A container whose git answers by subcommand; records what ran. */
function containerGit(opts: { version?: string; branchExists?: boolean; toplevel?: string; fail?: string } = {}) {
  const calls: string[][] = [];
  const exec = async (_p: Project, command: string[], _o?: unknown): Promise<RunResult> => {
    calls.push(command);
    const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
    const sub = command.slice(3).join(" ");
    if (command[1] === "--version") return ok(`git version ${opts.version ?? "2.49.0"}\n`);
    if (sub.startsWith("rev-parse --show-toplevel")) return ok(`${opts.toplevel ?? "/workspaces/demo"}\n`);
    if (sub.startsWith("show-ref")) return { ...ok(), exitCode: opts.branchExists ? 0 : 1 };
    if (opts.fail && sub.startsWith(opts.fail)) {
      return { exitCode: 128, stdout: "", stderr: "fatal: '/x' contains modified or untracked files, use --force to delete it\n", timedOut: false };
    }
    return ok();
  };
  return { exec, calls };
}

function hostGit(version = "2.49.0") {
  return fakeRunner((c) => (c.cmd === "git" ? { stdout: `git version ${version}\n` } : {}));
}

describe("Worktrees.add", () => {
  const add = (wt: Worktrees, over: Partial<Parameters<Worktrees["add"]>[1]> = {}, lines: string[] = []) =>
    wt.add(project, { workspaceFolder: "/workspaces/demo", root, branch: "feature/x", onLine: (l) => lines.push(l), ...over });

  it("creates a new branch with relative links when both gits support them", async () => {
    const c = containerGit();
    const wt = await add(new Worktrees({ containers: c, run: hostGit().run }), { base: "main" });
    expect(c.calls.at(-1)).toEqual([
      "git", "-C", "/workspaces/demo", "worktree", "add", "--relative-paths", "-b", "feature/x", "--",
      "/workspaces/demo.worktrees/feature-x", "main",
    ]);
    expect(wt).toEqual({ path: "/workspaces/demo.worktrees/feature-x", hostPath: "/src/demo.worktrees/feature-x", branch: "feature/x" });
  });

  it("checks out an existing branch instead of creating it", async () => {
    const c = containerGit({ branchExists: true });
    await add(new Worktrees({ containers: c, run: hostGit().run }));
    expect(c.calls.at(-1)?.slice(3)).toEqual([
      "worktree", "add", "--relative-paths", "--", "/workspaces/demo.worktrees/feature-x", "feature/x",
    ]);
    await expect(add(new Worktrees({ containers: c, run: hostGit().run }), { base: "main" })).rejects.toThrow(/already exists/);
  });

  it.each([
    ["host git is old", { host: "2.43.0" }, /on this machine is older than 2.48 \(2.43\)/],
    ["container git is old", { container: "2.39.2" }, /in the container is older than 2.48/],
    ["folder names differ", { ws: "/workspaces/app" }, /named differently/],
  ])("falls back to absolute links when %s", async (_name, o: { host?: string; container?: string; ws?: string }, why) => {
    const c = containerGit({ version: o.container, toplevel: o.ws });
    const lines: string[] = [];
    await add(new Worktrees({ containers: c, run: hostGit(o.host).run }), { workspaceFolder: o.ws ?? "/workspaces/demo" }, lines);
    expect(c.calls.at(-1)).not.toContain("--relative-paths");
    expect(lines.join("\n")).toMatch(why);
  });

  it("uses absolute links when relative ones are turned off", async () => {
    const c = containerGit();
    const lines: string[] = [];
    await add(new Worktrees({ containers: c, run: hostGit().run, relativeLinks: false }), {}, lines);
    expect(c.calls.at(-1)).not.toContain("--relative-paths");
    expect(lines.join("\n")).toMatch(/OPENDEVHUB_RELATIVE_WORKTREES=0/);
  });

  it("asks the host for its git version once", async () => {
    const host = hostGit();
    const wt = new Worktrees({ containers: containerGit(), run: host.run });
    await add(wt);
    await add(wt);
    expect(host.calls.filter((c) => c.cmd === "git")).toHaveLength(1);
  });

  it("refuses when the workspace isn't the git root, and rejects option-like bases", async () => {
    const wt = new Worktrees({ containers: containerGit({ toplevel: "/workspaces" }), run: hostGit().run });
    await expect(add(wt)).rejects.toThrow(/git root is \/workspaces/);
    await expect(add(new Worktrees({ containers: containerGit(), run: hostGit().run }), { base: "--orphan" })).rejects.toThrow(
      InvalidRequestError,
    );
  });
});

describe("Worktrees.remove", () => {
  it("passes --force only when asked and surfaces git's reason", async () => {
    const c = containerGit();
    const wt = new Worktrees({ containers: c, run: hostGit().run });
    await wt.remove(project, "/workspaces/demo", "/workspaces/demo.worktrees/x", true);
    expect(c.calls.at(-1)?.slice(3)).toEqual(["worktree", "remove", "--force", "--", "/workspaces/demo.worktrees/x"]);
    const dirty = new Worktrees({ containers: containerGit({ fail: "worktree remove" }), run: hostGit().run });
    const err = await dirty.remove(project, "/workspaces/demo", "/x", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as Error).message).toMatch(/use --force/);
  });
});
