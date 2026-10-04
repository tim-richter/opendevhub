import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandError } from "../../src/server/containers";
import { spawnRunner } from "../../src/server/exec";
import { GitOps, IDENTITY_HINT, parseAheadBehind } from "../../src/server/git";
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
