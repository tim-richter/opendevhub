import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../../src/server/containers";
import { type RunResult, spawnRunner } from "../../src/server/exec";
import { GitOps, IDENTITY_HINT, hostHeadObjects, parseAheadBehind, parseBranchRefs } from "../../src/server/git";
import { fakeRunner } from "../helpers/fake-runner";
import type { Project } from "../../src/shared/types";

const project: Project = { id: "p", name: "p", path: "/p", devcontainerPath: "/p/x" };
let tmp: string;
let repo: string;
let env: Record<string, string>;
let ops: GitOps;

/** Runs the "container" command on this machine, isolated from the user's git config. */
function localContainers() {
  return {
    exec: (_p: Project, command: string[], o?: { timeoutMs?: number }) =>
      spawnRunner(command[0], command.slice(1), { timeoutMs: o?.timeoutMs, env }),
  };
}
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const commitAll = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-git-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  env = { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  write(repo, "a.txt", "one\ntwo\nthree\n");
  commitAll(repo, "init");
  ops = new GitOps({ containers: localContainers() });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("parseAheadBehind", () => {
  it("reads behind then ahead", () => {
    expect(parseAheadBehind("3\t1\n")).toEqual({ behind: 3, ahead: 1 });
    expect(parseAheadBehind("")).toEqual({ behind: 0, ahead: 0 });
  });
});

describe("GitOps", () => {
  it("reads the branch, the recorded base and ahead/behind", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    git(repo, "config", "branch.feature.opendevhubBase", "main");
    write(repo, "b.txt", "b\n");
    commitAll(repo, "b");
    write(repo, "c.txt", "c\n");
    commitAll(repo, "c");
    git(repo, "checkout", "-q", "main");
    write(repo, "d.txt", "d\n");
    commitAll(repo, "d");
    git(repo, "checkout", "-q", "feature");
    expect(await ops.currentBranch(project, repo)).toBe("feature");
    expect(await ops.recordedBase(project, repo, "feature")).toBe("main");
    expect(await ops.recordedBase(project, repo, "main")).toBeUndefined();
    expect(await ops.aheadBehind(project, repo, "main")).toEqual({ ahead: 2, behind: 1 });
    git(repo, "checkout", "-q", "--detach");
    expect(await ops.currentBranch(project, repo)).toBeUndefined();
  });

  it("reads the commit checked out", async () => {
    expect(await ops.head(project, repo)).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  it("knows whether the checkout is clean and whether the branch was pushed", async () => {
    expect(await ops.isClean(project, repo)).toBe(true);
    write(repo, "new.txt", "x\n");
    expect(await ops.isClean(project, repo)).toBe(false);
    git(repo, "checkout", "-q", "-b", "feature");
    expect(await ops.isPushed(project, repo, "feature")).toBe(false);
    git(repo, "config", "branch.feature.opendevhubPublished", "true");
    expect(await ops.isPushed(project, repo, "feature")).toBe(true);
    git(repo, "config", "--unset", "branch.feature.opendevhubPublished");
    git(repo, "branch", "-q", "--set-upstream-to=main", "feature");
    expect(await ops.isPushed(project, repo, "feature")).toBe(true);
  });

  it("commits everything, untracked files included", async () => {
    write(repo, "new.txt", "x\n");
    write(repo, "a.txt", "changed\n");
    await ops.commit(project, repo, "feat: add new");
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("feat: add new");
    expect(await ops.isClean(project, repo)).toBe(true);
  });

  it("refuses to commit without an identity and says how to fix it", async () => {
    git(repo, "config", "--unset", "user.name");
    git(repo, "config", "--unset", "user.email");
    write(repo, "new.txt", "x\n");
    const err = await ops.commit(project, repo, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as Error).message).toBe(IDENTITY_HINT);
  });

  it("rebases onto the base, or merges it into a pushed branch", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "b.txt", "b\n");
    commitAll(repo, "b");
    git(repo, "checkout", "-q", "main");
    write(repo, "c.txt", "c\n");
    commitAll(repo, "c");
    git(repo, "checkout", "-q", "feature");
    expect(await ops.update(project, repo, "main", "rebase")).toEqual({ strategy: "rebase" });
    expect(await ops.aheadBehind(project, repo, "main")).toEqual({ ahead: 1, behind: 0 });
    git(repo, "checkout", "-q", "main");
    write(repo, "d.txt", "d\n");
    commitAll(repo, "d");
    git(repo, "checkout", "-q", "feature");
    expect(await ops.update(project, repo, "main", "merge")).toEqual({ strategy: "merge" });
    expect(git(repo, "log", "-1", "--format=%p").trim().split(" ")).toHaveLength(2);
  });

  it.each(["rebase", "merge"] as const)("aborts a conflicting %s and lists the files, leaving the branch as it was", async (strategy) => {
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "a.txt", "one\nTWO feature\nthree\n");
    commitAll(repo, "feature two");
    const before = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    write(repo, "a.txt", "one\nTWO main\nthree\n");
    commitAll(repo, "main two");
    git(repo, "checkout", "-q", "feature");
    expect(await ops.update(project, repo, "main", strategy)).toEqual({ strategy, conflicts: ["a.txt"] });
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await ops.isClean(project, repo)).toBe(true);
  });

  it("merges a branch into the base with a merge commit or fast-forward only", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "b.txt", "b\n");
    commitAll(repo, "b");
    git(repo, "checkout", "-q", "main");
    await ops.mergeInto(project, repo, "feature", false);
    expect(git(repo, "log", "-1", "--format=%p").trim().split(" ")).toHaveLength(2);
    git(repo, "checkout", "-q", "-b", "ff");
    write(repo, "c.txt", "c\n");
    commitAll(repo, "c");
    git(repo, "checkout", "-q", "main");
    await ops.mergeInto(project, repo, "ff", true);
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("c");
  });

  it("aborts a conflicting merge into the base", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "a.txt", "one\nTWO feature\nthree\n");
    commitAll(repo, "feature two");
    git(repo, "checkout", "-q", "main");
    write(repo, "a.txt", "one\nTWO main\nthree\n");
    commitAll(repo, "main two");
    const before = git(repo, "rev-parse", "HEAD");
    const err = await ops.mergeInto(project, repo, "feature", false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as Error).message).toMatch(/conflicts in a\.txt/);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("deletes a merged branch and refuses an unmerged one", async () => {
    git(repo, "branch", "merged");
    await ops.deleteBranch(project, repo, "merged");
    expect(git(repo, "branch", "--list", "merged").trim()).toBe("");
    git(repo, "checkout", "-q", "-b", "open");
    write(repo, "z.txt", "z\n");
    commitAll(repo, "z");
    git(repo, "checkout", "-q", "main");
    await expect(ops.deleteBranch(project, repo, "open")).rejects.toBeInstanceOf(CommandError);
  });

  it.each(["rebase", "merge"] as const)("never leaves a %s half-done when it fails without conflicts", async (strategy) => {
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "b.txt", "b\n");
    commitAll(repo, "b");
    const before = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    write(repo, "c.txt", "c\n");
    commitAll(repo, "c");
    git(repo, "checkout", "-q", "feature");
    // Signing is required but impossible, as in a container that copied a gpgsign host config without the key.
    git(repo, "config", "commit.gpgsign", "true");
    git(repo, "config", "gpg.program", "false");
    await expect(ops.update(project, repo, "main", strategy)).rejects.toBeInstanceOf(CommandError);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("never leaves a merge into the base half-done when it fails without conflicts", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "b.txt", "b\n");
    commitAll(repo, "b");
    git(repo, "checkout", "-q", "main");
    const before = git(repo, "rev-parse", "HEAD");
    git(repo, "config", "commit.gpgsign", "true");
    git(repo, "config", "gpg.program", "false");
    await expect(ops.mergeInto(project, repo, "feature", false)).rejects.toBeInstanceOf(CommandError);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });
});

describe("localBranches", () => {
  it("lists local branch names, slashes included", async () => {
    git(repo, "branch", "feature/x");
    expect((await ops.localBranches(project, repo)).sort()).toEqual(["feature/x", "main"]);
  });
});

describe("deleteBranch", () => {
  it("deletes an unmerged branch only when forced", async () => {
    git(repo, "checkout", "-q", "-b", "side");
    write(repo, "s.txt", "s\n");
    commitAll(repo, "side");
    git(repo, "checkout", "-q", "main");
    await expect(ops.deleteBranch(project, repo, "side")).rejects.toBeInstanceOf(CommandError);
    await ops.deleteBranch(project, repo, "side", true);
    expect(git(repo, "branch", "--list", "side").trim()).toBe("");
  });
});

describe("headObjects", () => {
  it("returns the object id of each path at HEAD, undefined where it is missing", async () => {
    const exec = vi.fn(async (_p: Project, _cmd: string[], _o?: { timeoutMs?: number }) => ({ exitCode: 0, stdout: "aaa\n-\nbbb\n", stderr: "", timedOut: false }));
    const ops = new GitOps({ containers: { exec } });
    expect(await ops.headObjects(project, "/w/x", [".devcontainer", ".devcontainer.json", "package-lock.json"])).toEqual(["aaa", undefined, "bbb"]);
    expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(["sh", "-c"]);
    expect(exec.mock.calls[0][1].slice(3)).toEqual(["sh", "/w/x", ".devcontainer", ".devcontainer.json", "package-lock.json"]);
  });
});

describe("parseBranchRefs", () => {
  it("reads names, upstreams and gone tracking", () => {
    const out = "main\trefs/remotes/origin/main\t\nfeat\trefs/remotes/origin/feat\t[gone]\nlocal\t\t\nahead\trefs/remotes/origin/ahead\t[ahead 2]\n";
    expect(parseBranchRefs(out)).toEqual([
      { name: "main", upstream: "refs/remotes/origin/main", gone: false },
      { name: "feat", upstream: "refs/remotes/origin/feat", gone: true },
      { name: "local", gone: false },
      { name: "ahead", upstream: "refs/remotes/origin/ahead", gone: false },
    ]);
  });
});

describe("GitOps cleanup queries", () => {
  const p: Project = { id: "demo", name: "demo", path: "/src/demo", devcontainerPath: "/x" };
  function ops(handler: (cmd: string[]) => Partial<RunResult>) {
    const calls: { cmd: string[]; opts?: { env?: Record<string, string>; timeoutMs?: number } }[] = [];
    const containers = {
      exec: async (_t: unknown, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult> => {
        calls.push({ cmd, opts });
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...handler(cmd) };
      },
    };
    return { git: new GitOps({ containers }), calls };
  }

  it("fetches with prune, no prompts and a 60 s timeout", async () => {
    const { git, calls } = ops(() => ({}));
    await git.fetchPrune(p, "/w", "origin");
    expect(calls[0].cmd).toEqual(["git", "-C", "/w", "fetch", "--prune", "--quiet", "origin"]);
    expect(calls[0].opts).toEqual({ env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60_000 });
  });

  it("reports a failed or timed-out fetch", async () => {
    await expect(ops(() => ({ exitCode: 128, stderr: "fatal: could not read from remote" })).git.fetchPrune(p, "/w", "origin")).rejects.toThrow(
      /could not read from remote/,
    );
    await expect(ops(() => ({ exitCode: 143, timedOut: true })).git.fetchPrune(p, "/w", "origin")).rejects.toThrow(/timed out/);
  });

  it("strips the remote from its HEAD branch", async () => {
    expect(await ops(() => ({ stdout: "origin/main\n" })).git.remoteHead(p, "/w", "origin")).toBe("main");
    expect(await ops(() => ({ exitCode: 1 })).git.remoteHead(p, "/w", "origin")).toBeUndefined();
  });

  it("answers ancestry, and throws when git can't", async () => {
    const { git, calls } = ops((cmd) => ({ exitCode: cmd.at(-1) === "main" ? 0 : cmd.at(-1) === "dev" ? 1 : 128, stderr: "fatal: Not a valid object name" }));
    expect(await git.isAncestor(p, "/w", "feat", "main")).toBe(true);
    expect(calls[0].cmd).toEqual(["git", "-C", "/w", "merge-base", "--is-ancestor", "refs/heads/feat", "main"]);
    expect(await git.isAncestor(p, "/w", "feat", "dev")).toBe(false);
    await expect(git.isAncestor(p, "/w", "feat", "gone")).rejects.toThrow(/Not a valid object name/);
  });

  it("lists remotes and branch refs", async () => {
    const { git, calls } = ops((cmd) => ({ stdout: cmd[3] === "remote" ? "origin\nfork\n" : "feat\t\t\n" }));
    expect(await git.remotes(p, "/w")).toEqual(["origin", "fork"]);
    expect(await git.branchRefs(p, "/w")).toEqual([{ name: "feat", gone: false }]);
    expect(calls[1].cmd).toEqual(["git", "-C", "/w", "for-each-ref", "--format=%(refname:short)%09%(upstream)%09%(upstream:track)", "refs/heads"]);
  });
});

describe("hostHeadObjects", () => {
  it("runs git on the host in the folder, one object per path", async () => {
    const fake = fakeRunner(() => ({ stdout: "abc123\n-\n" }));
    expect(await hostHeadObjects(fake.run, "/home/tim/w/fix", [".devcontainer", "package-lock.json"])).toEqual(["abc123", undefined]);
    expect(fake.calls[0].cmd).toBe("sh");
    expect(fake.calls[0].args.slice(2)).toEqual(["sh", "/home/tim/w/fix", ".devcontainer", "package-lock.json"]);
  });

  it("throws when git fails", async () => {
    await expect(hostHeadObjects(fakeRunner(() => ({ exitCode: 128, stderr: "fatal: not a git repository\n" })).run, "/x", ["a"])).rejects.toThrow(
      /git rev-parse failed/,
    );
  });
});

describe("PR worktree source", () => {
  it("fetches the PR ref from a matching remote and verifies the exact commit", async () => {
    const sha = "a".repeat(40);
    const exec = vi.fn(async (_p: unknown, cmd: string[]) => {
      const args = cmd.slice(3);
      const stdout = args[0] === "remote" ? (args[1] === "get-url" ? "git@forge.example:team/demo.git\n" : "origin\n") : args[0] === "rev-parse" ? sha : "";
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    });
    const gitOps = new GitOps({ containers: { exec } });
    expect(await gitOps.fetchPull(project, "/repo", "https://forge.example/team/demo/pulls/7", 7, sha)).toBe(sha);
    expect(exec.mock.calls.find(([, cmd]) => cmd.includes("fetch"))?.[1]).toEqual(["git", "-C", "/repo", "fetch", "--no-tags", "--", "origin", "refs/pull/7/head"]);
    await expect(gitOps.fetchPull(project, "/repo", "https://other.example/team/demo/pulls/7", 7, sha)).rejects.toThrow("no remote matching");
    await expect(gitOps.fetchPull(project, "/repo", "https://forge.example/team/demo/pulls/7", 7, "b".repeat(40))).rejects.toThrow("PR changed");
  });
});
